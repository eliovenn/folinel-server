import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { z } from 'zod';

import { auth } from '../auth.schema.ts';
import { AUTH_BASE_PATH, OTP_EXPIRY_SECONDS, RESEND_SECONDS } from '../src/modules/auth/options.ts';
import { registerSchema, resendSchema, verifyRegistrationSchema } from '../src/modules/auth/validation.ts';

interface Schema {
  type?: string | string[];
  properties?: Record<string, Schema>;
  [key: string]: unknown;
}
interface ApiResponse {
  description: string;
  content?: { 'application/json': { schema: Schema } };
  headers?: Record<string, unknown>;
}
interface Operation {
  responses: Record<string, ApiResponse>;
  [key: string]: unknown;
}

/** 原生接口从库生成，项目请求从实际 Zod schema 生成；补齐已实测的插件契约缺口。 */
const native = await auth.api.generateOpenAPISchema() as unknown as {
  components: { schemas: Record<string, Schema> };
  paths: Record<string, Record<string, Operation>>;
};
const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });
const object = (properties: Record<string, Schema>): Schema => ({ type: 'object', properties, required: Object.keys(properties) });
const data = (schema: Schema) => object({ data: schema });
const json = (schema: Schema, description = '成功'): ApiResponse => ({ description, content: { 'application/json': { schema } } });
const sessionHeaders = {
  'Set-Cookie': { description: '浏览器会话：HttpOnly、SameSite=Lax；HTTPS 使用 Secure 及 __Secure- 前缀。', schema: { type: 'string' } },
  'set-auth-token': { description: 'Flutter 保存此签名会话凭据，后续使用 Authorization: Bearer。', schema: { type: 'string' } },
};
const authSecurity = [{ bearerAuth: [] }, { sessionCookie: [] }, { developmentCookie: [] }];
const errors = {
  400: '输入、JSON、注册申请或验证码无效/过期。',
  401: '未登录或邮箱密码错误。',
  403: '域名被禁用、邮箱未验证、来源不可信或验证码尝试次数用完。',
  413: '项目 JSON 请求正文超过 1 MiB。',
  415: 'POST 必须使用 application/json。',
  429: '请求超限；Retry-After 为至少等待的秒数。',
  500: '服务暂时不可用；响应不包含内部异常。',
  503: '邮件服务暂时不可用；本次注册/重发已回滚。',
};
function errorResponses(statuses: (keyof typeof errors)[], nativeRoute = false) {
  return Object.fromEntries(statuses.map((status) => [status, {
    ...json(nativeRoute ? { oneOf: [ref('Error'), ref('NativeAuthError')] } : ref('Error'), errors[status]),
    ...(status === 429 ? { headers: { 'Retry-After': { schema: { type: 'integer', minimum: 1 }, description: '秒' } } } : {}),
  }]));
}
function requestBody(schema: z.ZodType) {
  const input = z.toJSONSchema(schema, { io: 'input', target: 'draft-2020-12' }) as Schema;
  delete input.$schema;
  if (input.properties?.email) input.properties.email.description = '邮箱：去除首尾空白、转小写后校验邮箱格式和 254 字符上限。';
  return { required: true, content: { 'application/json': { schema: input } } };
}
function nativeSuccess(path: string, method = 'post') {
  const result = native.paths[path]?.[method]?.responses['200'];
  assert.ok(result?.content, '认证插件的 OpenAPI 结构已变化，需重新核对契约。');
  return result.content['application/json'].schema;
}

const schemas: Record<string, Schema> = {
  User: native.components.schemas.User,
  Session: native.components.schemas.Session,
  NativeAuthError: object({ code: { type: 'string' }, message: { type: 'string' } }),
  Error: object({ error: ref('NativeAuthError') }),
};
// 插件未给可空数据库字段标 null；按实际 HTTP 返回修正，不暴露 account/verification 模型。
assert.ok(schemas.User.properties && schemas.Session.properties);
schemas.User.properties.image = { type: ['string', 'null'] };
for (const key of ['ipAddress', 'userAgent']) schemas.Session.properties[key] = { type: ['string', 'null'] };
const verificationResult = nativeSuccess('/email-otp/verify-email');
assert.ok(verificationResult.properties);
verificationResult.properties.token = { type: 'string', description: '库返回的会话 token；客户端优先保存 set-auth-token 响应头。' };
const loginResult = nativeSuccess('/sign-in/email');
assert.ok(loginResult.properties);
loginResult.properties.redirect = { type: 'boolean', description: '传入可信 callbackURL 时为 true。' };
loginResult.properties.url = { type: 'string', description: '仅传入 callbackURL 时返回。' };
delete loginResult.description;

const timing = { expiresIn: { type: 'integer', const: OTP_EXPIRY_SECONDS, description: '验证码有效秒数' }, resendAfter: { type: 'integer', const: RESEND_SECONDS, description: '邮箱发送冷却秒数' } };
const paths: Record<string, Record<string, Operation>> = {
  '/health': { get: { operationId: 'health', summary: '存活检查', security: [], responses: { 200: json(data(object({ status: { const: 'ok', type: 'string' } }))) } } },
  '/api/v1/auth/register': { post: {
    operationId: 'register', summary: '邮箱密码注册并发送验证码', security: [],
    description: '验证前不建立会话。未验证账号再次注册会替换密码及申请 ID；已验证账号返回模拟成功但不修改账号、不发信。请保存当前 registrationId。',
    requestBody: requestBody(registerSchema),
    responses: { 200: json(data(object({ registrationId: { type: 'string', format: 'uuid' }, ...timing }))), ...errorResponses([400, 403, 413, 415, 429, 500, 503]) },
  } },
  '/api/v1/auth/resend': { post: {
    operationId: 'resendRegistration', summary: '重发当前注册申请验证码', security: [],
    description: '当前邮箱和 registrationId 必须匹配；新验证码轮换旧验证码。发送失败保留上一枚尚未过期的验证码。',
    requestBody: requestBody(resendSchema),
    responses: { 200: json(data(object(timing))), ...errorResponses([400, 403, 413, 415, 429, 500, 503]) },
  } },
  '/api/v1/auth/verify-registration': { post: {
    operationId: 'verifyRegistration', summary: '验证当前注册申请并自动建立会话', security: [],
    description: '消费六位验证码；最多五次错误。成功后直接进入应用，无需再次输入密码。',
    requestBody: requestBody(verifyRegistrationSchema),
    responses: { 200: { ...json(data(verificationResult)), headers: sessionHeaders }, ...errorResponses([400, 403, 413, 415, 429, 500]) },
  } },
  '/api/v1/me': { get: {
    operationId: 'currentUser', summary: '读取已验证的当前用户', security: authSecurity,
    responses: { 200: json(data(object({ id: { type: 'string' }, email: { type: 'string', format: 'email' }, name: { type: 'string' }, emailVerified: { type: 'boolean', const: true } }))), ...errorResponses([401, 500]) },
  } },
};
for (const [path, method, summary] of [
  ['/sign-in/email', 'post', '邮箱密码登录'],
  ['/get-session', 'get', '读取当前会话；未登录返回 null'],
  ['/sign-out', 'post', '退出并使当前会话失效'],
]) {
  const operation = native.paths[path][method];
  operation.summary = summary;
  operation.tags = ['Better Auth'];
  operation.security = path === '/sign-in/email' ? [] : [{}, ...authSecurity];
  operation.description = '保持 Better Auth 原生成功响应。原生错误为 { code, message }；项目前置来源/限流/格式检查错误为 { error: { code, message } }。所有错误使用固定安全文案。';
  operation.responses = {
    200: { ...json(nativeSuccess(path, method)), ...(path === '/sign-in/email' ? { headers: sessionHeaders } : {}) },
    ...errorResponses(method === 'post' ? [400, 401, 403, 415, 429, 500] : [400, 429, 500], true),
  };
  paths[`${AUTH_BASE_PATH}${path}`] = { [method]: operation };
}
const document = {
  openapi: '3.1.1',
  info: {
    title: 'Folinel API', version: '0.1.0',
    description: '邮箱注册、验证和会话。项目接口使用 data/error 包装；原生认证接口保留库契约。浏览器使用同源代理和 HttpOnly Cookie，Flutter 使用 Bearer。POST 必须发送 JSON；携带 Cookie 的 POST 必须带可信 Origin。',
  },
  servers: [{ url: '/' }],
  tags: [{ name: 'Better Auth', description: 'Better Auth 1.7.18 原生开放入口' }],
  components: {
    schemas,
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', description: 'set-auth-token 响应头的签名会话凭据' },
      sessionCookie: { type: 'apiKey', in: 'cookie', name: '__Secure-better-auth.session_token', description: 'HTTPS HttpOnly Cookie，由浏览器自动管理' },
      developmentCookie: { type: 'apiKey', in: 'cookie', name: 'better-auth.session_token', description: '仅用于本地 HTTP 开发' },
    },
  },
  paths,
};
const target = new URL('../../../docs/api/openapi.json', import.meta.url);
await mkdir(new URL('.', target), { recursive: true });
await writeFile(target, `${JSON.stringify(document, null, 2)}\n`);
