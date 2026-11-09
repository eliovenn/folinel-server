/* eslint-disable no-process-env */
import logger from 'jet-logger';
import type { Server } from 'node:http';

import { Env } from './config/env.ts';
import { createDatabase } from './db/client.ts';
import { readDatabaseConfig } from './db/config.ts';
import { databaseErrorMessage } from './db/errors.ts';
import { createSmtpMailer, readSmtpConfig, SmtpConfigError } from './email/smtp.ts';
import { AuthConfigError, readAuthConfig } from './modules/auth/config.ts';
import { createAuthService } from './modules/auth/service.ts';
import { createApp } from './server.ts';

let database: ReturnType<typeof createDatabase> | undefined;
let mailer: ReturnType<typeof createSmtpMailer> | undefined;
let httpServer: Server | undefined;
let stopping = false;

/** 收到退出信号时先停止 HTTP 服务，再释放数据库连接。 */
async function shutdown() {
  if (stopping) return;
  stopping = true;
  // 毫秒；给现有请求 10 秒完成，避免退出时无限等待。
  const timer = setTimeout(() => httpServer?.closeAllConnections(), 10_000);
  timer.unref();
  try {
    if (httpServer?.listening) {
      await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
    }
    await database?.close();
  } finally {
    mailer?.close();
    clearTimeout(timer);
  }
}

try {
  const authConfig = readAuthConfig(process.env);
  mailer = createSmtpMailer(readSmtpConfig(process.env));
  database = createDatabase(readDatabaseConfig(process.env));
  // 验证成功后才开始接收请求；不自动创建表或执行迁移。
  await database.check();
  const app = createApp({ auth: createAuthService(database.db, authConfig, mailer) });
  app.locals.db = database.db;

  httpServer = app.listen(Env.PORT);
  await new Promise<void>((resolve, reject) => {
    httpServer!.once('listening', () => resolve());
    httpServer!.once('error', reject);
  });
  logger.info(`API 已启动，端口：${Env.PORT}；PostgreSQL 连接检查通过。`);

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void shutdown().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    });
  }
} catch (error: unknown) {
  const message = error instanceof AuthConfigError || error instanceof SmtpConfigError ? error.message : databaseErrorMessage(error);
  logger.err(`API 启动失败：${message}`);
  await shutdown();
  process.exit(1);
}
