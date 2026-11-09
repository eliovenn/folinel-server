import { fromNodeHeaders, toNodeHandler } from 'better-auth/node';
import { Router, type RequestHandler, type Response } from 'express';
import type { z } from 'zod';

import { publicAuthError, HttpError } from '../../http/errors.ts';
import { AUTH_BASE_PATH, OTP_EXPIRY_SECONDS, RESEND_SECONDS } from './options.ts';
import type { AuthService } from './service.ts';
import { registerSchema, resendSchema, verifyRegistrationSchema } from './validation.ts';

function parse<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const result = schema.safeParse(input);
  if (!result.success) throw new HttpError(400, 'VALIDATION_ERROR', '请求参数无效。');
  return result.data;
}

/** 只转发认证需要的响应头，不写入日志。 */
export async function sendAuthResponse(response: globalThis.Response, res: Response) {
  const cookies = response.headers.getSetCookie();
  if (cookies.length) res.setHeader('Set-Cookie', cookies);
  for (const name of ['set-auth-token', 'retry-after', 'cache-control']) {
    const value = response.headers.get(name);
    if (value) res.setHeader(name, value);
  }
  if (!response.ok) {
    const { code, message } = await publicAuthError(response);
    res.status(response.status).json({ error: { code, message } });
    return;
  }
  const data: unknown = await response.json();
  res.status(response.status).json({ data });
}

export function authRequestBoundary(auth: AuthService): RequestHandler {
  const origins = new Set([auth.config.baseURL, ...auth.config.trustedOrigins]);
  return async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    // Express 只解析显式信任的代理链；覆盖外部伪造的内部头，统一会话与限流身份。
    const clientIP = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    req.headers['x-folinel-client-ip'] = clientIP;
    await auth.limits.ip(clientIP);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const origin = req.get('origin');
      if ((origin && !origins.has(origin)) || (!origin && (req.get('cookie') || req.get('sec-fetch-site')))) {
        throw new HttpError(403, 'INVALID_ORIGIN', '请求来源不受信任。');
      }
      if (req.method === 'POST' && !req.is('application/json')) {
        throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', '请使用 application/json。');
      }
    }
    next();
  };
}

/** 在 express.json 前挂载，避免消耗 Better Auth 需要的请求流。 */
export function nativeAuthHandler(auth: AuthService): RequestHandler {
  const handler = toNodeHandler(async (request: globalThis.Request) => {
    const response = await auth.nativeAuth.handler(request);
    if (response.ok) return response;
    const { code, message } = await publicAuthError(response);
    const headers = new Headers(response.headers);
    headers.delete('content-length');
    headers.set('content-type', 'application/json');
    return globalThis.Response.json({ code, message }, { status: response.status, headers });
  });
  const allowed = new Set(['POST /sign-in/email', 'GET /get-session', 'POST /sign-out']);
  return async (req, res, next) => {
    const path = req.path.slice(AUTH_BASE_PATH.length);
    if (!allowed.has(`${req.method} ${path}`)) return next();
    await handler(req, res);
  };
}

export function registrationRoutes(auth: AuthService) {
  const router = Router();
  const timing = { expiresIn: OTP_EXPIRY_SECONDS, resendAfter: RESEND_SECONDS };
  router.post('/register', async (req, res) => {
    const registrationId = await auth.register(parse(registerSchema, req.body));
    res.json({ data: { registrationId, ...timing } });
  });
  router.post('/resend', async (req, res) => {
    await auth.resend(parse(resendSchema, req.body));
    res.json({ data: timing });
  });
  router.post('/verify-registration', async (req, res) => {
    const response = await auth.verifyRegistration(parse(verifyRegistrationSchema, req.body), fromNodeHeaders(req.headers));
    await sendAuthResponse(response, res);
  });
  return router;
}

export function currentUserHandler(auth: AuthService): RequestHandler {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const current = await auth.nativeAuth.api.getSession({ headers: fromNodeHeaders(req.headers) });
    if (!current?.user.emailVerified) throw new HttpError(401, 'UNAUTHENTICATED', '请先登录。');
    const { id, email, name, emailVerified } = current.user;
    res.json({ data: { id, email, name, emailVerified } });
  };
}
