import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { betterAuth } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import type { Database, Transaction } from '../../db/client.ts';
import * as schema from '../../db/schema.ts';
import { registrationEmail } from '../../email/registration.ts';
import { HttpError } from '../../http/errors.ts';
import { createAuthLimits } from './limits.ts';
import { type AuthConfig, createAuthOptions, type RegistrationMailer } from './options.ts';
import { assertEmailAllowed, findPendingRegistration, lockRegistration } from './repository.ts';
import { emailSchema, type registerSchema, type resendSchema, type verifyRegistrationSchema } from './validation.ts';

export function createAuthService(db: Database, config: AuthConfig, mailer: RegistrationMailer) {
  const limits = createAuthLimits();

  function createAuth(connection: Database | Transaction) {
    const options = createAuthOptions(config, mailer);
    return betterAuth({
      ...options,
      database: drizzleAdapter(connection, { provider: 'pg', schema, transaction: true }),
      hooks: {
        before: createAuthMiddleware(async (ctx) => {
          if (ctx.path !== '/sign-in/email') return;
          const parsed = z.looseObject({ email: emailSchema }).safeParse(ctx.body);
          if (!parsed.success) throw new APIError('BAD_REQUEST', { code: 'INVALID_EMAIL', message: '邮箱格式无效。' });
          try {
            await limits.login(parsed.data.email);
          } catch (error: unknown) {
            if (!(error instanceof HttpError)) throw error;
            throw new APIError('TOO_MANY_REQUESTS', { code: error.code, message: error.message }, { 'Retry-After': String(error.retryAfter) });
          }
          return { context: { body: parsed.data } };
        }),
      },
      emailVerification: {
        ...options.emailVerification,
        // 库在更新 emailVerified 前再检查一次当前域名策略。
        beforeEmailVerification: async (user) => {
          if (!user.emailVerified) await assertEmailAllowed(connection, user.email);
        },
      },
    });
  }

  const nativeAuth = createAuth(db);

  async function rotateOTP(auth: ReturnType<typeof createAuth>, email: string) {
    const context = await auth.$context;
    // 使用库 adapter，不依赖验证码哈希格式；标识格式对应已锁定的 Email OTP 版本。
    await context.internalAdapter.deleteVerificationByIdentifier(`email-verification-otp-${email}`);
    // sendVerificationOTP 的后台封装会吞掉发送异常；使用官方 server-only 生成接口后显式等待 SMTP。
    const otp = await auth.api.createVerificationOTP({ body: { email, type: 'email-verification' } });
    await mailer.send(registrationEmail(email, otp));
  }

  return {
    nativeAuth,
    limits,
    config,
    async register(input: z.infer<typeof registerSchema>) {
      await limits.send(input.email);
      const registrationId = randomUUID();
      await db.transaction(async (tx) => {
        await lockRegistration(tx, input.email);
        const auth = createAuth(tx);
        const context = await auth.$context;
        const existing = await context.internalAdapter.findUserByEmail(input.email);
        if (existing?.user.emailVerified) {
          // 库对已有账号执行等价密码哈希并返回模拟成功，不变更其凭据。
          await auth.api.signUpEmail({ body: { ...input, name: 'Folinel 用户' } });
          return;
        }
        await assertEmailAllowed(tx, input.email);
        let userId: string;
        if (existing) {
          userId = existing.user.id;
          await context.internalAdapter.updatePassword(userId, await context.password.hash(input.password));
        } else {
          const result = await auth.api.signUpEmail({ body: { ...input, name: 'Folinel 用户' } });
          userId = result.user.id;
        }
        await tx.insert(schema.registrationAttempt).values({ userId, id: registrationId })
          .onConflictDoUpdate({ target: schema.registrationAttempt.userId, set: { id: registrationId, createdAt: new Date() } });
        await rotateOTP(auth, input.email);
      });
      return registrationId;
    },
    async resend(input: z.infer<typeof resendSchema>) {
      await limits.send(input.email);
      await db.transaction(async (tx) => {
        await lockRegistration(tx, input.email);
        await findPendingRegistration(tx, input.email, input.registrationId);
        await assertEmailAllowed(tx, input.email);
        await rotateOTP(createAuth(tx), input.email);
      });
    },
    async verifyRegistration(input: z.infer<typeof verifyRegistrationSchema>, headers: Headers) {
      await limits.verify(input.email);
      return db.transaction(async (tx) => {
        await lockRegistration(tx, input.email);
        const pending = await findPendingRegistration(tx, input.email, input.registrationId);
        await assertEmailAllowed(tx, input.email);
        const response = await createAuth(tx).api.verifyEmailOTP({
          body: { email: input.email, otp: input.otp }, headers, asResponse: true,
        });
        // 4xx 返回值让事务提交错误尝试次数；服务故障则回滚验证码消费和会话写入。
        if (response.status >= 500) throw new HttpError(500, 'INTERNAL_ERROR', '验证暂时失败，请稍后重试。');
        if (response.ok) await tx.delete(schema.registrationAttempt).where(eq(schema.registrationAttempt.userId, pending.userId));
        return response;
      });
    },
  };
}

export type AuthService = ReturnType<typeof createAuthService>;
