import { betterAuth } from 'better-auth';
import { randomBytes } from 'node:crypto';

import { createAuthOptions } from './src/modules/auth/options.ts';

/** 仅供 CLI 生成 schema；不读取真实配置、不连接数据库或 SMTP。 */
export const auth = betterAuth(createAuthOptions({
  secret: randomBytes(32).toString('hex'),
  baseURL: 'http://localhost:3000',
  trustedOrigins: [],
}, {
  send() { throw new Error('生成 schema 时不能发送邮件。'); },
}));
