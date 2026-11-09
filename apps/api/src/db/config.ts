import { z } from 'zod';

/** 错误只包含配置项名称，不包含连接串、密码或解析器原始异常。 */
export class DatabaseConfigError extends Error {}

const optionsSchema = z.object({
  ssl: z.enum(['true', 'false']).default('true'),
  max: z.coerce.number().int().min(1).max(50).default(5),
});

export interface DatabaseConfig {
  url: string;
  ssl: boolean;
  caFile?: string;
  /** 单个 API 进程的最大连接数。 */
  max: number;
}

/** 测试环境只读 TEST_DATABASE_*，没有开发库回退。 */
export function readDatabaseConfig(env: NodeJS.ProcessEnv): DatabaseConfig {
  const prefix = env.NODE_ENV === 'test' ? 'TEST_DATABASE_' : 'DATABASE_';
  const url = env[`${prefix}URL`]?.trim();
  if (!url) {
    throw new DatabaseConfigError(`请填写 ${prefix}URL。`);
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
    // 提前检查错误的百分号编码，防止客户端在连接时才报出包含原值的异常。
    decodeURIComponent(parsed.username);
    decodeURIComponent(parsed.password);
    decodeURIComponent(parsed.pathname);
  } catch {
    throw new DatabaseConfigError(
      `${prefix}URL 不是有效的 PostgreSQL 连接串。`,
    );
  }
  if (
    !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
    !parsed.hostname ||
    !parsed.username ||
    !parsed.password ||
    parsed.pathname.length <= 1 ||
    parsed.hash ||
    parsed.port === '0'
  ) {
    throw new DatabaseConfigError(
      `${prefix}URL 需要包含 PostgreSQL 协议、用户名、密码、主机和数据库名；密码中的特殊字符需要 URL 编码。`,
    );
  }
  if (parsed.search) {
    throw new DatabaseConfigError(
      `${prefix}URL 请移除问号及其查询参数；SSL 使用 ${prefix}SSL 和 ${prefix}CA_CERT 配置。`,
    );
  }

  const result = optionsSchema.safeParse({
    ssl: env[`${prefix}SSL`],
    max: env[`${prefix}POOL_MAX`],
  });
  if (!result.success) {
    throw new DatabaseConfigError(
      `${prefix}SSL 只能填写 true 或 false，${prefix}POOL_MAX 必须是 1 到 50 的整数。`,
    );
  }
  const ssl = result.data.ssl === 'true';
  const caFile = env[`${prefix}CA_CERT`]?.trim() || undefined;
  if (caFile && !ssl) {
    throw new DatabaseConfigError(
      `${prefix}CA_CERT 需要同时启用 ${prefix}SSL。`,
    );
  }
  return { url, ssl, caFile, max: result.data.max };
}
