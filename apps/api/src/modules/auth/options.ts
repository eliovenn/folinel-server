import type { BetterAuthOptions } from 'better-auth';
import { bearer, emailOTP, openAPI } from 'better-auth/plugins';

import { registrationEmail } from '../../email/registration.ts';
import type { EmailMessage } from '../../email/smtp.ts';

export interface AuthConfig {
  secret: string;
  baseURL: string;
  trustedOrigins: string[];
}

export interface RegistrationMailer {
  send(message: EmailMessage): Promise<{ messageId: string }>;
}

export const OTP_EXPIRY_SECONDS = 600;
export const RESEND_SECONDS = 60;
export const AUTH_BASE_PATH = '/api/auth';

/** 生成 schema 与运行时共用配置；数据库及流程规则在 service 中注入。 */
export function createAuthOptions(config: AuthConfig, mailer: RegistrationMailer) {
  return {
    appName: 'Folinel',
    basePath: AUTH_BASE_PATH,
    baseURL: config.baseURL,
    secret: config.secret,
    trustedOrigins: config.trustedOrigins,
    telemetry: { enabled: false },
    // 库的原始日志可能含邮箱或数据库异常，项目边界统一记录固定消息。
    logger: { disabled: true },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      autoSignIn: false,
      minPasswordLength: 8,
      maxPasswordLength: 128,
    },
    emailVerification: {
      sendOnSignUp: false,
      sendOnSignIn: false,
      autoSignInAfterVerification: true,
    },
    session: { cookieCache: { enabled: false } },
    advanced: {
      disableOriginCheck: false,
      disableCSRFCheck: false,
      ipAddress: { ipAddressHeaders: ['x-folinel-client-ip'] },
      defaultCookieAttributes: { httpOnly: true, sameSite: 'lax' as const },
    },
    // HTTP 和内部调用统一由项目入口使用成熟 limiter，避免两套计数。
    rateLimit: { enabled: false },
    plugins: [
      emailOTP({
        otpLength: 6,
        expiresIn: OTP_EXPIRY_SECONDS,
        allowedAttempts: 5,
        storeOTP: 'hashed',
        resendStrategy: 'rotate',
        disableSignUp: true,
        overrideDefaultEmailVerification: true,
        async sendVerificationOTP({ email, otp, type }) {
          if (type !== 'email-verification') {
            throw new Error('当前只支持注册验证邮件。');
          }
          await mailer.send(registrationEmail(email, otp));
        },
      }),
      bearer(),
      openAPI({ disableDefaultReference: true }),
    ],
  } satisfies BetterAuthOptions;
}
