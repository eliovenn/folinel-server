/* eslint-disable no-process-env */
import assert from 'node:assert/strict';
import { eq, sql } from 'drizzle-orm';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, describe, it, type TestContext } from 'node:test';
import supertest from 'supertest';
import { z } from 'zod';

import { createDatabase } from '#src/db/client.ts';
import { readDatabaseConfig } from '#src/db/config.ts';
import { migrateDatabase } from '#src/db/migrate.ts';
import { account, blockedEmailDomain, registrationAttempt, session, user, verification } from '#src/db/schema.ts';
import { EmailDeliveryError, type EmailMessage } from '#src/email/smtp.ts';
import { createAuthService } from '#src/modules/auth/service.ts';
import { createApp } from '#src/server.ts';

const configured = Boolean(process.env.TEST_DATABASE_URL?.trim());
const config = {
  secret: randomBytes(32).toString('hex'),
  baseURL: 'http://localhost:3000',
  trustedOrigins: ['http://localhost:5173'],
};
const password = 'test-registration-password';

const currentUserSchema = z.object({ id: z.string(), email: z.email(), name: z.string(), emailVerified: z.boolean() });
function registrationId(response: { body: unknown }) {
  return z.object({ data: z.object({ registrationId: z.uuid() }) }).parse(response.body).data.registrationId;
}
function authenticated(response: { body: unknown }) {
  return z.object({ data: z.object({ status: z.literal(true), user: currentUserSchema }) }).parse(response.body).data;
}

describe('邮箱注册与会话（独立 PostgreSQL）', {
  skip: configured ? false : '未配置 TEST_DATABASE_URL，跳过认证数据库集成测试',
}, () => {
  let database: ReturnType<typeof createDatabase>;
  const emails: string[] = [];
  const domains: string[] = [];

  before(async () => {
    assert.notEqual(process.env.TEST_DATABASE_URL, process.env.DATABASE_URL, '认证测试必须使用独立数据库。');
    database = createDatabase(readDatabaseConfig({ ...process.env, NODE_ENV: 'test' }));
    await migrateDatabase(database.db);
    // 迁移器重复运行不应重复写入默认规则。
    await migrateDatabase(database.db);
    const defaults = await database.db.select().from(blockedEmailDomain);
    assert.ok(['outlook.com', 'hotmail.com', 'live.com'].every((domain) => defaults.some((row) => row.domain === domain)));
  });

  after(async () => {
    if (!database) return;
    for (const email of emails) {
      await database.db.delete(user).where(eq(user.email, email));
      await database.db.delete(verification).where(eq(verification.identifier, `email-verification-otp-${email}`));
    }
    for (const domain of domains) await database.db.delete(blockedEmailDomain).where(eq(blockedEmailDomain.domain, domain));
    await database.close();
  });

  function fixture(t: TestContext, authConfig = config, trustProxy: string[] = []) {
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const messages: EmailMessage[] = [];
    let failMail = false;
    const auth = createAuthService(database.db, authConfig, {
      send(message) {
        if (failMail) return Promise.reject(new EmailDeliveryError());
        messages.push(message);
        return Promise.resolve({ messageId: 'test-delivery' });
      },
    });
    const app = createApp({ auth, trustProxy });
    const agent = supertest(app);
    const email = `registration-${randomUUID()}@example.test`;
    emails.push(email);
    const register = (address = email, nextPassword = password) => agent.post('/api/v1/auth/register').send({ email: address, password: nextPassword });
    const otp = () => {
      const code = messages.at(-1)?.text.match(/\b\d{6}\b/)?.[0];
      assert.ok(code);
      return code;
    };
    const verify = (id: string, code = otp(), address = email) => agent.post('/api/v1/auth/verify-registration').send({ email: address, registrationId: id, otp: code });
    return { auth, agent, email, messages, register, verify, otp, fail: (value: boolean) => { failMail = value; }, advance: () => t.mock.timers.tick(61_000) };
  }

  it('注册无需昵称；验证前无会话；验证后 Bearer 与 Cookie 直接访问当前用户', async (t) => {
    const f = fixture(t);
    const start = await f.register();
    assert.equal(start.status, 200);
    assert.ok(registrationId(start));
    assert.equal(Object.hasOwn(start.body as object, 'token'), false);
    assert.equal(start.headers['set-cookie'], undefined);
    assert.equal((await f.agent.get('/api/v1/me')).status, 401);
    const pendingLogin = await f.agent.post('/api/auth/sign-in/email').send({ email: f.email, password });
    assert.equal(pendingLogin.status, 403);
    assert.equal(f.messages.length, 1, '未验证登录不能绕过发码冷却。');
    const stored = await database.db.select().from(verification).where(eq(verification.identifier, `email-verification-otp-${f.email}`));
    assert.equal(stored.length, 1);
    assert.ok(!stored[0].value.includes(f.otp()), '数据库不保存明文验证码。');
    const finish = await f.verify(registrationId(start));
    assert.equal(finish.status, 200);
    const result = authenticated(finish);
    assert.equal(result.status, true);
    assert.equal(result.user.name, 'Folinel 用户');
    assert.equal(result.user.emailVerified, true);
    const token = finish.headers['set-auth-token'];
    assert.ok(token);
    const me = await f.agent.get('/api/v1/me').set('Authorization', `Bearer ${token}`);
    assert.equal(me.status, 200);
    const profile = z.object({ data: currentUserSchema.strict() }).parse(me.body).data;
    assert.equal(profile.id, result.user.id);
    assert.deepEqual(Object.keys(profile).sort(), ['email', 'emailVerified', 'id', 'name']);
    const cookies = finish.headers['set-cookie'];
    assert.ok(cookies);
    assert.equal((await f.agent.get('/api/v1/me').set('Cookie', cookies)).status, 200);
    assert.equal((await f.verify(registrationId(start))).status, 400);
  });

  it('邮箱密码可登录，退出后原 Cookie/Bearer 均失效', async (t) => {
    const f = fixture(t);
    const start = await f.register();
    await f.verify(registrationId(start));
    assert.equal((await f.agent.post('/api/auth/sign-in/email').send({ email: f.email, password: 'wrong-password' })).status, 401);
    const login = await f.agent.post('/api/auth/sign-in/email').send({ email: f.email, password });
    assert.equal(login.status, 200);
    const token = login.headers['set-auth-token'];
    const current = await f.agent.get('/api/auth/get-session').set('Authorization', `Bearer ${token}`);
    assert.equal(z.object({ user: currentUserSchema }).parse(current.body).user.email, f.email);
    const exit = await f.agent.post('/api/auth/sign-out').set('Authorization', `Bearer ${token}`).send({});
    assert.equal(exit.status, 200);
    assert.equal((await f.agent.get('/api/v1/me').set('Authorization', `Bearer ${token}`)).status, 401);
    assert.equal((await f.agent.get('/api/v1/me').set('Cookie', login.headers['set-cookie'])).status, 401);
  });

  it('五次错误后正确码也不能通过；过期码与并发重放不能建立额外会话', async (t) => {
    const f = fixture(t);
    const start = await f.register();
    const id = registrationId(start);
    const wrong = f.otp() === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) assert.equal((await f.verify(id, wrong)).status, 400);
    assert.equal((await f.verify(id)).status, 403);
    f.advance();
    await f.agent.post('/api/v1/auth/resend').send({ email: f.email, registrationId: id });
    t.mock.timers.tick(601_000);
    assert.equal((await f.verify(id)).status, 400);
    await f.agent.post('/api/v1/auth/resend').send({ email: f.email, registrationId: id });
    const results = await Promise.all([f.verify(id), f.verify(id)]);
    assert.deepEqual(results.map((result) => result.status).sort(), [200, 400]);
    const users = await database.db.select().from(user).where(eq(user.email, f.email));
    assert.equal((await database.db.select().from(session).where(eq(session.userId, users[0].id))).length, 1);
  });

  it('重发受冷却限制，重发后旧码失效，新码可验证', async (t) => {
    const f = fixture(t);
    const start = await f.register();
    const id = registrationId(start);
    const old = f.otp();
    const body = { email: f.email, registrationId: id };
    const early = await f.agent.post('/api/v1/auth/resend').send(body);
    assert.equal(early.status, 429);
    assert.ok(Number(early.headers['retry-after']) > 0);
    f.advance();
    assert.equal((await f.agent.post('/api/v1/auth/resend').send(body)).status, 200);
    if (old !== f.otp()) assert.equal((await f.verify(id, old)).status, 400);
    assert.equal((await f.verify(id)).status, 200);
  });

  it('再次注册替换未验证密码和申请；旧申请不能验证新码或重发', async (t) => {
    const f = fixture(t);
    const first = await f.register();
    f.advance();
    const second = await f.register(f.email, 'owner-new-password');
    assert.notEqual(registrationId(first), registrationId(second));
    assert.equal((await f.verify(registrationId(first))).status, 400);
    f.advance();
    assert.equal((await f.agent.post('/api/v1/auth/resend').send({ email: f.email, registrationId: registrationId(first) })).status, 400);
    assert.equal(f.messages.length, 2);
    assert.equal((await f.verify(registrationId(second))).status, 200);
    assert.equal((await f.agent.post('/api/auth/sign-in/email').send({ email: f.email, password })).status, 401);
    assert.equal((await f.agent.post('/api/auth/sign-in/email').send({ email: f.email, password: 'owner-new-password' })).status, 200);
    f.advance();
    const duplicate = await f.register(f.email, 'attacker-new-password');
    assert.equal(duplicate.status, 200);
    assert.equal(f.messages.length, 2);
    assert.equal((await f.verify(registrationId(duplicate))).status, 400);
    const current = await database.db.select().from(user).where(eq(user.email, f.email));
    assert.equal((await database.db.select().from(account).where(eq(account.userId, current[0].id))).length, 1);
  });

  it('SMTP 失败回滚注册；恢复后可重新发起，重发失败保留上一枚有效码', async (t) => {
    const f = fixture(t);
    f.fail(true);
    const failure = await f.register();
    assert.equal(failure.status, 503);
    assert.equal((await database.db.select().from(user).where(eq(user.email, f.email))).length, 0);
    f.fail(false);
    f.advance();
    const start = await f.register();
    const old = f.otp();
    f.advance();
    f.fail(true);
    assert.equal((await f.agent.post('/api/v1/auth/resend').send({ email: f.email, registrationId: registrationId(start) })).status, 503);
    assert.equal((await f.verify(registrationId(start), old)).status, 200);
  });

  it('并发错误验证累计五次后锁定，不能靠并发请求重置计数', async (t) => {
    const f = fixture(t);
    const id = registrationId(await f.register());
    const wrong = f.otp() === '000000' ? '111111' : '000000';
    const failures = await Promise.all(Array.from({ length: 5 }, () => f.verify(id, wrong)));
    assert.ok(failures.every((result) => result.status === 400));
    const locked = await f.verify(id);
    assert.equal(locked.status, 403);
    assert.deepEqual(locked.body, { error: { code: 'TOO_MANY_ATTEMPTS', message: '验证码尝试次数已用完，请重新获取。' } });
  });

  it('会话写入失败回滚邮箱验证和验证码消费，恢复后同一码可验证', async (t) => {
    const f = fixture(t);
    const id = registrationId(await f.register());
    const [pending] = await database.db.select().from(user).where(eq(user.email, f.email));
    // 仅拒绝本测试用户的会话写入；DDL 字面量来自库生成的内部 ID，并转义单引号。
    await database.db.execute(sql.raw(`alter table "session" add constraint auth_test_session_failure check (user_id <> '${pending.id.replaceAll("'", "''")}') not valid`));
    try {
      const failure = await f.verify(id);
      assert.equal(failure.status, 500);
      assert.equal(failure.headers['set-auth-token'], undefined);
      assert.equal(failure.headers['set-cookie'], undefined);
      assert.doesNotMatch(JSON.stringify(failure.body), /auth_test_session_failure|insert into|user_id/);
      const [unchanged] = await database.db.select().from(user).where(eq(user.id, pending.id));
      assert.equal(unchanged.emailVerified, false);
    } finally {
      await database.db.execute(sql`alter table "session" drop constraint auth_test_session_failure`);
    }
    assert.equal((await f.verify(id)).status, 200);
  });

  it('可信浏览器可完成注册；HTTPS 会话 Cookie 为 Secure/HttpOnly，退出校验来源', async (t) => {
    const f = fixture(t, { ...config, baseURL: 'https://api.example.test', trustedOrigins: ['https://admin.example.test'] });
    const origin = 'https://admin.example.test';
    const start = await f.agent.post('/api/v1/auth/register').set('Origin', origin).send({ email: f.email, password });
    const finish = await f.agent.post('/api/v1/auth/verify-registration').set('Origin', origin).send({ email: f.email, registrationId: registrationId(start), otp: f.otp() });
    assert.equal(finish.status, 200);
    const cookies = z.array(z.string()).parse(finish.headers['set-cookie']);
    assert.ok(cookies.some((cookie) => cookie.startsWith('__Secure-better-auth.session_token=') && /HttpOnly/i.test(cookie) && /; Secure/i.test(cookie) && /SameSite=Lax/i.test(cookie)));
    const cookie = cookies.map((value) => value.split(';')[0]).join('; ');
    assert.equal((await f.agent.post('/api/auth/sign-out').set('Cookie', cookie).send({})).status, 403);
    assert.equal((await f.agent.post('/api/auth/sign-out').set('Origin', origin).set('Cookie', cookie).send({})).status, 200);
    assert.equal((await f.agent.get('/api/v1/me').set('Cookie', cookie)).status, 401);
  });

  it('原生登录校验回调来源、隐藏输入错误详情，邮箱限流不能靠变换大小写绕过', async (t) => {
    const f = fixture(t);
    assert.equal((await f.agent.post('/api/auth/sign-in/email').send({ email: f.email, password, callbackURL: 'https://evil.example' })).status, 403);
    const invalid = await f.agent.post('/api/auth/sign-in/email').send({ email: f.email, password: { secret: 'SENSITIVE_INPUT' } });
    assert.equal(invalid.status, 400);
    assert.doesNotMatch(JSON.stringify(invalid.body), /SENSITIVE_INPUT|secret/);
    for (let i = 0; i < 10; i++) {
      await f.agent.post('/api/auth/sign-in/email').send({ email: i % 2 ? f.email.toUpperCase() : f.email, password });
    }
    const limited = await f.agent.post('/api/auth/sign-in/email').send({ email: f.email, password });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers['retry-after']) > 0);
    assert.deepEqual(limited.body, { code: 'RATE_LIMITED', message: '请求过于频繁，请稍后重试。' });
  });

  it('初始禁用域名及子域名不可注册，相似域名可注册', async (t) => {
    const f = fixture(t);
    for (const domain of ['outlook.com', 'HOTMAIL.COM', 'mail.live.com']) {
      const response = await f.register(`registration-${randomUUID()}@${domain}`);
      assert.equal(response.status, 403);
      assert.equal(z.object({ error: z.object({ code: z.string() }) }).parse(response.body).error.code, 'EMAIL_DOMAIN_BLOCKED');
    }
    const email = `registration-${randomUUID()}@notoutlook.com`;
    emails.push(email);
    assert.equal((await f.register(email)).status, 200);
  });

  it('发码后新增域名禁用规则，验证仍受限；既有已验证用户仍可登录', async (t) => {
    const f = fixture(t);
    const domain = `registration-${randomUUID()}.test`;
    domains.push(domain);
    const address = `owner@${domain}`;
    emails.push(address);
    const start = await f.register(address);
    await database.db.insert(blockedEmailDomain).values({ domain });
    assert.equal((await f.verify(registrationId(start), f.otp(), address)).status, 403);
    await database.db.update(blockedEmailDomain).set({ enabled: false }).where(eq(blockedEmailDomain.domain, domain));
    assert.equal((await f.verify(registrationId(start), f.otp(), address)).status, 200);
    await database.db.update(blockedEmailDomain).set({ enabled: true }).where(eq(blockedEmailDomain.domain, domain));
    assert.equal((await f.agent.post('/api/auth/sign-in/email').send({ email: address, password })).status, 200);
  });

  it('原始注册/验证码登录/链接验证/密码重置/管理入口不可绕过项目规则', async (t) => {
    const f = fixture(t);
    for (const path of ['/sign-up/email', '/sign-in/email-otp', '/email-otp/send-verification-otp', '/email-otp/verify-email', '/email-otp/check-verification-otp', '/send-verification-email', '/verify-email', '/email-otp/reset-password', '/change-email', '/open-api/generate-schema']) {
      assert.equal((await f.agent.post(`/api/auth${path}`).send({ email: f.email, password, name: 'test', otp: '123456' })).status, 404);
    }
    assert.equal((await f.agent.post('/api/admin/v1/email-domains').send({ domain: 'example.test' })).status, 404);
    const start = await f.register();
    const users = await database.db.select().from(user).where(eq(user.email, f.email));
    assert.equal((await database.db.select().from(registrationAttempt).where(eq(registrationAttempt.userId, users[0].id)))[0].id, registrationId(start));
  });

  it('拒绝恶意浏览器来源和超大 JSON；伪造 IP 头不能绕过入口限流', async (t) => {
    const f = fixture(t);
    assert.equal((await f.agent.post('/api/v1/auth/register').set('Origin', 'https://evil.example').send({ email: f.email, password })).status, 403);
    assert.equal((await f.agent.post('/api/v1/auth/register').set('Content-Type', 'text/plain').send('test')).status, 415);
    assert.equal((await f.agent.post('/api/v1/auth/register').send({ email: f.email, password: 'x'.repeat(1_100_000) })).status, 413);
    let limited = false;
    for (let i = 0; i < 130; i++) {
      const response = await f.agent.post('/api/v1/auth/register').set('X-Forwarded-For', `192.0.2.${i}`).set('x-folinel-client-ip', `192.0.2.${i}`).send({});
      if (response.status === 429) { limited = true; break; }
    }
    assert.equal(limited, true);
    const count = await database.db.execute(sql`select count(*)::int as count from "user" where email = ${f.email}`);
    assert.equal(count[0].count, 0);
  });

  it('可信代理后的访客分别限流，伪造的链首和内部 IP 头不能更换限流身份', async (t) => {
    const f = fixture(t, config, ['127.0.0.1', '::1']);
    for (let i = 0; i < 120; i++) {
      const response = await f.agent.get('/api/auth/not-exposed')
        .set('X-Forwarded-For', `192.0.2.${i}, 198.51.100.10`)
        .set('x-folinel-client-ip', `192.0.2.${i}`);
      assert.equal(response.status, 404);
    }
    const limited = await f.agent.get('/api/auth/not-exposed')
      .set('X-Forwarded-For', '203.0.113.20, 198.51.100.10')
      .set('x-folinel-client-ip', '203.0.113.20');
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers['retry-after']) > 0);
    assert.equal((await f.agent.get('/api/auth/not-exposed')
      .set('X-Forwarded-For', '198.51.100.11')).status, 404);
  });

  it('配置代理后仍忽略非可信直连的转发头', async (t) => {
    const f = fixture(t, config, ['192.0.2.1']);
    for (let i = 0; i < 120; i++) {
      assert.equal((await f.agent.get('/api/auth/not-exposed')
        .set('X-Forwarded-For', `198.51.100.${i}`)).status, 404);
    }
    assert.equal((await f.agent.get('/api/auth/not-exposed')
      .set('X-Forwarded-For', '203.0.113.1')).status, 429);
  });

  it('通过可信代理注册建会话时，保存解析后的真实访客 IP', async (t) => {
    const f = fixture(t, config, ['127.0.0.1', '::1']);
    const start = await f.register();
    const finish = await f.agent.post('/api/v1/auth/verify-registration')
      .set('X-Forwarded-For', '198.51.100.25')
      .set('x-folinel-client-ip', '203.0.113.99')
      .send({ email: f.email, registrationId: registrationId(start), otp: f.otp() });
    assert.equal(finish.status, 200);
    const { user: current } = authenticated(finish);
    const sessions = await database.db.select().from(session).where(eq(session.userId, current.id));
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].ipAddress, '198.51.100.25');
  });
});
