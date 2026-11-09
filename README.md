# folinel-server

Folinel 的后端 API 和 React 管理后台 workspace，面向单人开发和后续单机部署。

- `apps/api`：Express + TypeScript + PostgreSQL + Drizzle。
- `apps/admin`：React + Vite + shadcn/ui。
- `docs`：逐步实现记录和配置说明。

使用 Node.js 24 和 pnpm。数据库配置见 [docs/01-database.md](docs/01-database.md)。

Ubuntu 单机部署使用 GitHub Actions + GHCR + Docker Compose，包含 API、Caddy 管理后台和 PostgreSQL。首次配置、迁移与更新步骤见 [部署文档](docs/06-deployment.md)。

```bash
pnpm db:check       # 只读验证 PostgreSQL 连接
pnpm test:db        # 数据库配置测试
pnpm test:email     # SMTP 本地测试，不发信
pnpm smtp:check     # SMTP 连接及认证检查，需本地填凭据
pnpm db:migrate    # 显式执行开发库迁移
pnpm test:auth     # 认证测试；真实集成测试需要独立测试库
pnpm api:generate  # 更新 OpenAPI
pnpm dev            # 同时启动 API 和管理后台
pnpm typecheck
pnpm lint
pnpm test
```

已实现邮箱密码注册、验证码重发/验证、自动建立会话、登录/当前用户/退出，以及注册域名限制。配置和迁移步骤见 [docs/05-registration.md](docs/05-registration.md)，接口与 Flutter/React 接入见 [docs/api/README.md](docs/api/README.md)。

启动前在 API 环境中配置数据库、SMTP、`AUTH_SECRET`、`AUTH_BASE_URL` 和页面可信来源，并执行迁移。示例见 `apps/api/config/.env.example`；服务启动不会自动建表。管理后台目前仍为基础界面。

真实环境文件已被 `.gitignore` 排除，数据库凭据只放在 API 配置中，不放入管理后台的 `VITE_*` 变量。

开发流程和完成标准见 [docs/development.md](docs/development.md)，项目自动化协作规则见 [AGENTS.md](AGENTS.md)。
