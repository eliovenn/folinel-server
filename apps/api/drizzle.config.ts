import { defineConfig } from 'drizzle-kit';

/** 生成迁移无需真实数据库凭据；执行迁移由 src/db/migrate.ts 复用严格配置。 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
});
