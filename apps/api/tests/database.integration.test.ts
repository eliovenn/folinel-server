/* eslint-disable no-process-env */
import { it } from 'node:test';

import { createDatabase } from '#src/db/client.ts';
import { readDatabaseConfig } from '#src/db/config.ts';

it(
  '独立 PostgreSQL 测试库可以执行只读连接检查',
  {
    skip: process.env.TEST_DATABASE_URL?.trim()
      ? false
      : '未配置 TEST_DATABASE_URL，跳过真实数据库连接',
    timeout: 25_000,
  },
  async () => {
    const database = createDatabase(
      readDatabaseConfig({ ...process.env, NODE_ENV: 'test' }),
    );
    try {
      await database.check();
    } finally {
      await database.close();
    }
  },
);
