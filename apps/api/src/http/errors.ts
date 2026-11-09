import { APIError } from 'better-auth/api';

import { EmailDeliveryError } from '../email/smtp.ts';

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfter?: number;

  constructor(status: number, code: string, message: string, retryAfter?: number) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

const authMessages: Record<string, string> = {
  INVALID_OTP: '验证码无效，请检查或重新获取。',
  OTP_EXPIRED: '验证码已过期，请重新获取。',
  TOO_MANY_ATTEMPTS: '验证码尝试次数已用完，请重新获取。',
  EMAIL_NOT_VERIFIED: '请先完成邮箱验证。',
  INVALID_EMAIL_OR_PASSWORD: '邮箱或密码不正确。',
  INVALID_EMAIL: '邮箱格式无效。',
  INVALID_CALLBACK_URL: '回调地址不受信任。',
  INVALID_ORIGIN: '请求来源不受信任。',
  MISSING_OR_NULL_ORIGIN: '缺少有效的请求来源。',
  RATE_LIMITED: '请求过于频繁，请稍后重试。',
};

/** 只映射固定文案；不透传 Zod、SQL、SMTP 或认证库的原始异常。 */
export function publicError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  if (error instanceof EmailDeliveryError) return new HttpError(503, 'EMAIL_UNAVAILABLE', error.message);
  if (error instanceof APIError && error.statusCode < 500) {
    const code = error.body?.code;
    if (typeof code === 'string' && Object.hasOwn(authMessages, code)) {
      return new HttpError(error.statusCode, code, authMessages[code]);
    }
    return new HttpError(error.statusCode, 'AUTH_REQUEST_FAILED', '认证请求未通过，请检查输入或重新登录。');
  }
  return new HttpError(500, 'INTERNAL_ERROR', '服务暂时不可用，请稍后重试。');
}

export async function publicAuthError(response: Response): Promise<HttpError> {
  if (response.status >= 500) return publicError(null);
  const body: unknown = await response.json().catch(() => null);
  const code = body && typeof body === 'object' && 'code' in body && typeof body.code === 'string' ? body.code : '';
  if (Object.hasOwn(authMessages, code)) return new HttpError(response.status, code, authMessages[code]);
  return new HttpError(response.status, 'AUTH_REQUEST_FAILED', '认证请求未通过，请检查输入或重新登录。');
}
