# @folinel/api

Folinel 的 Node.js API，已实现邮箱密码注册、邮件验证码及 Cookie/Bearer 会话。

## 命令

```bash
pnpm dev                 # 开发模式，启动前检查数据库连接
pnpm start               # 生产模式，启动前检查数据库连接
pnpm db:check            # 只执行 SELECT 1，不建表、不迁移
pnpm test:db             # 数据库配置测试；有独立测试库时执行连接测试
pnpm test:auth           # 注册及会话行为测试
pnpm db:migrate          # 显式执行开发库迁移
pnpm db:generate         # 从 Drizzle schema 生成迁移
pnpm api:generate        # 更新 OpenAPI 契约
pnpm typecheck
pnpm lint
pnpm test
```

数据库配置和 Supabase / 自建 PostgreSQL 的填写方式见 [../../docs/01-database.md](../../docs/01-database.md)。真实环境文件不提交到仓库。

## 当前接口

- `GET /health`：返回 `{ "data": { "status": "ok" } }`。
- `/api/v1/auth/register`、`/resend`、`/verify-registration`：注册流程。
- `/api/auth/sign-in/email`、`/get-session`、`/sign-out`：Better Auth 原生会话接口。
- `GET /api/v1/me`：已验证的当前用户。

启动配置、数据表及验证范围见 [注册步骤](../../docs/05-registration.md)。请求与响应以 [OpenAPI](../../docs/api/openapi.json) 为准。尚未开放管理员、找回密码、改邮箱、手机号或微信入口。
