/* eslint-disable no-process-env */
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { fileURLToPath } from 'node:url';

import { createDatabase, type Database } from './client.ts';
import { readDatabaseConfig } from './config.ts';
import { databaseErrorMessage } from './errors.ts';

export async function migrateDatabase(db: Database) {
  await migrate(db, { migrationsFolder: fileURLToPath(new URL('../../drizzle', import.meta.url)) });
}

if (import.meta.main) {
  let database: ReturnType<typeof createDatabase> | undefined;
  try {
    database = createDatabase(readDatabaseConfig(process.env));
    await migrateDatabase(database.db);
    process.stdout.write('数据库迁移完成。\n');
  } catch (error: unknown) {
    process.stderr.write(`数据库迁移失败：${databaseErrorMessage(error)}\n`);
    process.exitCode = 1;
  } finally {
    await database?.close();
  }
}
