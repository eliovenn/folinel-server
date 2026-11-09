/* eslint-disable no-process-env */
import { createDatabase } from './client.ts';
import { readDatabaseConfig } from './config.ts';
import { databaseErrorMessage } from './errors.ts';

/** 执行只读连接检查；调用方负责处理输出和进程退出。 */
async function runDatabaseCheck(env: NodeJS.ProcessEnv): Promise<void> {
  const database = createDatabase(readDatabaseConfig(env));
  try {
    await database.check();
  } finally {
    await database.close();
  }
}

try {
  await runDatabaseCheck(process.env);
  process.stdout.write('数据库连接成功（SELECT 1），未修改任何数据。\n');
} catch (error: unknown) {
  process.stderr.write(`数据库检查失败：${databaseErrorMessage(error)}\n`);
  process.exitCode = 1;
}
