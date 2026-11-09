import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';

import { readProxyConfig } from '#src/config/proxy.ts';
import { readAuthConfig } from '#src/modules/auth/config.ts';
import { createAuthLimits } from '#src/modules/auth/limits.ts';
import { matchesBlockedDomain, registerSchema } from '#src/modules/auth/validation.ts';

describe('注册配置与边界', () => {
  it('代理默认不受信任，只接受明确的 IP 或网段，配置错误不回显输入', () => {
    assert.deepEqual(readProxyConfig({}), []);
    assert.deepEqual(readProxyConfig({ TRUST_PROXY: ' 172.30.20.2, ::1, 192.0.2.0/24 ' }), ['172.30.20.2', '::1', '192.0.2.0/24']);
    for (const value of ['true', '1', '*', 'loopback', 'https://TOP_SECRET@example.com']) {
      assert.throws(() => readProxyConfig({ TRUST_PROXY: value }), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.doesNotMatch(error.message, /TOP_SECRET/);
        return true;
      });
    }
  });

  it('域名按完整标签匹配，大小写归一化，不能误伤相似域名', () => {
    for (const domain of ['outlook.com', 'mail.outlook.com', 'MAIL.OUTLOOK.COM']) {
      assert.equal(matchesBlockedDomain(domain, 'outlook.com'), true);
    }
    for (const domain of ['notoutlook.com', 'outlook.com.example.org']) {
      assert.equal(matchesBlockedDomain(domain, 'outlook.com'), false);
    }
  });

  it('注册只接受邮箱密码，拒绝提权字段与过长输入', () => {
    assert.deepEqual(registerSchema.parse({ email: ' User@Example.com ', password: 'test-password' }), {
      email: 'user@example.com', password: 'test-password',
    });
    for (const body of [
      { email: 'bad', password: 'test-password' },
      { email: 'user@example.com', password: 'short' },
      { email: 'user@example.com', password: 'x'.repeat(129) },
      { email: 'user@example.com', password: 'test-password', emailVerified: true },
      { email: 'user@example.com', password: 'test-password', role: 'admin' },
    ]) assert.equal(registerSchema.safeParse(body).success, false);
  });

  it('认证配置要求独立密钥和明确来源，生产必须 HTTPS，异常不携带输入', () => {
    const env = {
      NODE_ENV: 'development',
      AUTH_SECRET: randomBytes(32).toString('hex'),
      AUTH_BASE_URL: 'http://localhost:3000',
      AUTH_TRUSTED_ORIGINS: 'http://localhost:5173',
    };
    assert.equal(readAuthConfig(env).baseURL, env.AUTH_BASE_URL);
    for (const patch of [
      { AUTH_SECRET: '' }, { AUTH_SECRET: 'TOP_SECRET' },
      { AUTH_BASE_URL: 'https://user:TOP_SECRET@example.com' },
      { AUTH_TRUSTED_ORIGINS: '*' },
      { NODE_ENV: 'production' },
    ]) {
      assert.throws(() => readAuthConfig({ ...env, ...patch }), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.doesNotMatch(error.message, /TOP_SECRET/);
        return true;
      });
    }
  });

  it('同一邮箱的注册和重发共用 60 秒冷却，过期后恢复', async (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
    const limits = createAuthLimits();
    await limits.send('user@example.com');
    await assert.rejects(limits.send('user@example.com'), { code: 'RATE_LIMITED' });
    t.mock.timers.tick(60_001);
    await limits.send('user@example.com');
  });
});
