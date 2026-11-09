/* eslint-disable no-process-env */
import logger from 'jet-logger';
import { z } from 'zod';

const EnvironmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']),
  PORT: z.coerce.number().int().min(1).max(65_535),
});

export type NodeEnvironment = z.infer<typeof EnvironmentSchema>['NODE_ENV'];

/** API 进程启动所需的环境变量；数据库配置由 db/config.ts 单独读取。 */
export const Env = (() => {
  const result = EnvironmentSchema.safeParse({
    NODE_ENV: process.env.NODE_ENV?.toLowerCase(),
    PORT: process.env.PORT,
  });
  if (!result.success) {
    logger.err('API 环境变量无效：需要 NODE_ENV 和 1 到 65535 的 PORT。');
    throw new Error('API 环境变量无效。');
  }
  return result.data;
})();
