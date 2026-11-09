import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';

import { type DatabaseConfig, DatabaseConfigError } from './config.ts';
import * as schema from './schema.ts';

/** 每个 API 进程只创建一个实例；创建时不联网，首次查询才建立连接。 */
export function createDatabase(config: DatabaseConfig) {
  let ca: string | undefined;
  if (config.caFile) {
    try {
      ca = readFileSync(config.caFile, 'utf8');
    } catch {
      throw new DatabaseConfigError(
        '无法读取数据库 CA 证书，请检查 CA_CERT 的路径和文件权限。',
      );
    }
    if (!ca.includes('-----BEGIN CERTIFICATE-----')) {
      throw new DatabaseConfigError('数据库 CA 证书需要使用 PEM 格式。');
    }
  }
  const client = postgres(config.url, {
    // 启用 TLS 时始终验证证书；私有 CA 通过 CA_CERT 显式配置。
    ssl: config.ssl
      ? { rejectUnauthorized: true, ...(ca ? { ca } : {}) }
      : false,
    max: config.max,
    // 以下时间的单位为秒；空闲连接及时归还给 Supabase 或本地 PostgreSQL。
    connect_timeout: 10,
    idle_timeout: 20,
    prepare: true,
    debug: false,
    onnotice: () => {},
    connection: { application_name: 'folinel-api' },
  });
  const db = drizzle({ client, schema, logger: false });

  return {
    db,
    /** 只读检查，不建表、不迁移、不读写业务数据；总等待上限为 15 秒。 */
    async check() {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          db.execute<{ ok: number }>(sql`select 1 as ok`),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              reject(
                Object.assign(new Error('数据库检查超时'), {
                  code: 'DATABASE_CHECK_TIMEOUT',
                }),
              );
            }, 15_000);
          }),
        ]);
        if (result[0]?.ok !== 1) throw new Error('数据库检查返回异常');
      } finally {
        clearTimeout(timer);
      }
    },
    /** 先停止接收 HTTP 请求，再关闭连接池；最多等待现有查询 5 秒。 */
    async close() {
      await client.end({ timeout: 5 });
    },
  };
}

export type Database = ReturnType<typeof createDatabase>['db'];
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
