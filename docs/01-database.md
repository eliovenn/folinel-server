# 第一步：配置 PostgreSQL

日期：2026-11-05。

## 当前状态

用户已确认 Supabase 连接成功。后面的验证与排错记录为过程记录，不代表现在仍有连接故障。独立测试库尚未配置，不能把开发库连通等同于业务数据库测试完成。

本步骤记录连接基础。后续 [第五步](05-registration.md) 已添加认证 schema 和显式迁移；Supabase 仍只作为 PostgreSQL 托管服务使用。

## 1. 填写开发环境

编辑 `apps/api/config/.env.development`，保留已有配置，在底部填写数据库项。可参考同目录 `.env.example`。

```dotenv
DATABASE_URL="postgresql://postgres.PROJECT_REF:URL_ENCODED_PASSWORD@POOLER_HOST:5432/postgres"
DATABASE_SSL=true
DATABASE_CA_CERT=
DATABASE_POOL_MAX=5
```

在 Supabase 控制台打开项目，点击 **Connect → Session pooler**，复制完整连接串。用户名、主机和区域以控制台实际显示为准；替换 `[YOUR-PASSWORD]` 为该项目的数据库密码。它不是 Supabase 登录密码，也不是 anon/service_role 等 HTTP API 密钥。

常驻 Node 服务可使用 Direct connection 或 Session pooler（端口 5432）。默认直连地址通常需要 IPv6；Session pooler 可用于 IPv4 网络。本次排查发现本机代理 DNS 返回的地址没有完成 PostgreSQL SSL 协商，而公开 DNS 返回的真实 IPv6 地址能回应，因此不能把超时直接判断为本机不支持 IPv6。可优先尝试 Connect 中的 Session pooler，地址和用户名一起完整复制，不要自己推算。切换后仍需实际验证，代理规则也可能影响 pooler。

当前客户端开启预处理语句，不要选共享的 Transaction pooler（通常端口 6543）。

密码中的特殊字符要先 URL 编码，例如 `@` → `%40`、`#` → `%23`、`/` → `%2F`、`%` → `%25`，只编码密码部分，不要编码整个连接串。真实连接串不要发到聊天、截图或提交到 Git。

连接串仅保留 `postgresql://用户名:密码@主机:端口/数据库`，不要带 `?sslmode=...` 等查询参数。SSL 由独立变量统一控制，防止出现两套相互覆盖的设置。

`DATABASE_SSL=true` 表示启用 TLS 并始终校验证书。`DATABASE_CA_CERT` 留空时使用 Node 默认信任库。如果提示证书不受信任，在 Supabase 控制台的数据库 SSL 配置处下载项目的 PEM 格式 CA 证书，将其**绝对路径**填入 `DATABASE_CA_CERT`。不要关闭 SSL 或证书验证来绕过错误。

`DATABASE_POOL_MAX` 是单个 API 进程的最大连接数，默认 5。连接超时为 10 秒，空闲连接在 20 秒后释放。连接检查最多等待 15 秒，退出时关闭连接池最多等待 5 秒。

## 2. 验证当前步骤

在 `folinel-server` 根目录执行：

```bash
pnpm db:check
pnpm test:db
pnpm --filter @folinel/api typecheck
pnpm --filter @folinel/api lint
```

`db:check` 只执行 `SELECT 1`，不会建表或修改业务数据；成功后输出“数据库连接成功（SELECT 1），未修改任何数据。”，随后关闭连接池。失败返回非零退出码，并输出不含连接串或密码的提示。

如果提示 `Supabase 连接池找不到租户或用户`，说明网络和 TLS 已经通过，优先重新复制同一个项目的完整 Session pooler URI。用户名通常是 `postgres.<项目标识>`，主机通常是 `aws-...pooler.supabase.com`，二者必须来自同一次 Connect 配置；不要把 Direct connection 的用户名或主机与 Session pooler 混用。

API 启动时执行同样的检查，成功后才开始监听端口。停止服务时先关闭 HTTP 服务，再关闭连接池。

配置测试无需数据库。真实连接测试仅在 `apps/api/config/.env.test` 或环境变量中设置了 `TEST_DATABASE_URL` 时执行；否则明确显示跳过，不能视为真实数据库已验证。

```dotenv
# 必须是独立测试库，不能填开发库或生产库。
TEST_DATABASE_URL="postgresql://folinel_test:URL_ENCODED_PASSWORD@127.0.0.1:5432/folinel_test"
TEST_DATABASE_SSL=false
TEST_DATABASE_CA_CERT=
TEST_DATABASE_POOL_MAX=1
```

当 `NODE_ENV=test` 时，连接模块只读取 `TEST_DATABASE_*`，不会回退到 `DATABASE_*`。连接测试只读；认证集成测试会迁移并写入测试用户，必须使用独立测试库。

## 3. 后续服务器配置

如果 API 和 PostgreSQL 都直接运行在同一台服务器上，在 `apps/api/config/.env.production` 或部署环境变量中填写：

```dotenv
DATABASE_URL="postgresql://folinel:URL_ENCODED_PASSWORD@127.0.0.1:5432/folinel"
DATABASE_SSL=false
DATABASE_CA_CERT=
DATABASE_POOL_MAX=5
```

这里的 `folinel` 数据库和登录角色需要提前创建。`DATABASE_SSL=false` 适用于服务器本机回环连接；跨主机连接应启用 SSL 并验证证书。容器部署时，`127.0.0.1` 指当前容器，应改为数据库服务名，例如 `db`，并根据实际网络配置 TLS。

```bash
pnpm db:check:production
pnpm start:api
```

生产检查读取 `.env.production`；部署平台注入的环境变量优先于文件中的值。更换连接配置不需要改业务代码，但不会自动把 Supabase 的数据复制到新服务器，数据迁移需要单独实施。

## 4. 实现边界

- `src/db/config.ts`：验证连接配置、隔离测试环境。
- `src/db/client.ts`：postgres.js 连接池、Drizzle 实例、只读检查和释放连接。
- `src/db/errors.ts`：将已知错误映射为中文提示，隐藏驱动原始错误内容。
- `src/db/check.ts`：可单独运行的连接检查命令。
- `src/main.ts`：API 启动检查与停止时的连接回收；Drizzle 实例保存在 `app.locals.db`。
- 本步骤没有引入表结构或登录；后续实现见第五步。初始化脚手架的 users/JSON 示例已删除。

核对依据：Supabase 官方 Connecting to Postgres、Postgres.js 指南和 SSL Enforcement 文档，以及已安装 postgres.js / Drizzle 的客户端接口。

## 5. 本次验证结果

- API 类型检查和 lint 通过。
- 数据库专项测试：9 项通过，1 项真实连接测试因缺少 `TEST_DATABASE_URL` 跳过。
- 完整 API 测试：32 项通过，1 项跳过。
- 在 `DATABASE_URL` 留空时执行 `pnpm db:check`，返回退出码 1 和“请填写 DATABASE_URL”，符合预期。
- 2026-11-06 排查：当前 Direct connection 的公开 DNS 只有 IPv6。本机代理 DNS 返回 198.18/15 范围地址，TCP 连接后 PostgreSQL SSL 协商超时；临时连接公开 DNS 返回的真实 IPv6 时能收到 SSL 响应，但证书校验返回 SELF_SIGNED_CERT_IN_CHAIN。没有发送数据库密码或执行 SQL，尚不能判断凭据是否正确。
- 尚未验证成功连接。建议先完整替换为 Connect 面板提供的 Session pooler 连接串，再执行 `pnpm db:check`；如果报告证书链错误，再配置控制台下载的 CA。直连也可以使用，但需要修复代理/DNS 路径并配置可信证书。

## 6. 配置 CA 后的排查记录

2026-11-06：本地 CA 文件可读取、未过期，当前连接串已经使用 Session pooler 的 5432 端口。保持严格 TLS 校验时，连接池返回 SQLSTATE `XX000` 和 `tenant/user ... not found`。这说明该次连接已通过网络与 TLS 阶段，尚未成功认证或执行 `SELECT 1`。

需要从同一 Supabase 项目的 Connect 面板重新核对完整 Session pooler URI，重点检查用户名中的项目标识与 Pooler 主机是否对应。错误处理现已为这个具体返回值提供固定中文提示，包含项目标识的原始错误不会输出。针对 Drizzle 包装错误、脱敏和无关 XX000 错误增加了回归断言。未修改真实连接串。
