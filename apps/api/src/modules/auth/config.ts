import { z } from 'zod';

import type { AuthConfig } from './options.ts';

export class AuthConfigError extends Error {
  constructor() {
    super('认证配置无效，请检查 AUTH_SECRET、AUTH_BASE_URL 和 AUTH_TRUSTED_ORIGINS；生产环境必须使用 HTTPS。');
  }
}

const originSchema = z.url().refine((value) => {
  const url = new URL(value);
  return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/';
});

export function readAuthConfig(env: NodeJS.ProcessEnv): AuthConfig {
  const parsed = z.object({
    secret: z.string().min(32),
    baseURL: originSchema,
    trustedOrigins: z.array(originSchema),
  }).safeParse({
    secret: env.AUTH_SECRET,
    baseURL: env.AUTH_BASE_URL,
    trustedOrigins: (env.AUTH_TRUSTED_ORIGINS ?? '').split(',').map((value) => value.trim()).filter(Boolean),
  });
  if (!parsed.success) throw new AuthConfigError();
  const { secret, baseURL, trustedOrigins } = parsed.data;
  if (env.NODE_ENV === 'production' && [baseURL, ...trustedOrigins].some((url) => !url.startsWith('https://'))) {
    throw new AuthConfigError();
  }
  return { secret, baseURL: new URL(baseURL).origin, trustedOrigins: trustedOrigins.map((url) => new URL(url).origin) };
}
