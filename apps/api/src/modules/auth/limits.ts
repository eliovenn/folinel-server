import { RateLimiterMemory, RateLimiterRes } from 'rate-limiter-flexible';

import { HttpError } from '../../http/errors.ts';
import { RESEND_SECONDS } from './options.ts';

async function consume(limiter: RateLimiterMemory, key: string) {
  try {
    await limiter.consume(key);
  } catch (error: unknown) {
    if (error instanceof RateLimiterRes) {
      throw new HttpError(429, 'RATE_LIMITED', '请求过于频繁，请稍后重试。', Math.max(1, Math.ceil(error.msBeforeNext / 1000)));
    }
    throw error;
  }
}

/** 当前部署为单进程。计数由库管理，IP 使用 Express 按可信代理配置解析的地址。 */
export function createAuthLimits() {
  const ip = new RateLimiterMemory({ points: 120, duration: 60 });
  const sends = new RateLimiterMemory({ points: 10, duration: 3600 });
  const cooldown = new RateLimiterMemory({ points: 1, duration: RESEND_SECONDS });
  const verifies = new RateLimiterMemory({ points: 30, duration: 600 });
  const logins = new RateLimiterMemory({ points: 10, duration: 600 });
  return {
    ip: (address: string) => consume(ip, address),
    async send(email: string) {
      await consume(cooldown, email);
      await consume(sends, email);
    },
    verify: (email: string) => consume(verifies, email),
    login: (email: string) => consume(logins, email),
  };
}
