# 第五步：邮箱注册与验证会话

日期：2026-11-07。状态：服务端实现、OpenAPI 与隔离 PostgreSQL 验证完成；真实环境配置及 SMTP 送达待验证。

## 目标与接口

完成邮箱密码注册、重发、验证码验证并自动建立会话；提供邮箱密码登录、当前用户和退出作为会话验收入口。注册页只输入邮箱和密码，昵称由服务端设为“Folinel 用户”。

| 接口 | 输入 | 成功行为 |
| --- | --- | --- |
| `POST /api/v1/auth/register` | `email`、`password`（8–128 字符） | `{ data: { registrationId, expiresIn: 600, resendAfter: 60 } }`；尚无业务会话 |
| `POST /api/v1/auth/resend` | `email`、`registrationId` | `{ data: { expiresIn: 600, resendAfter: 60 } }`；旧码失效 |
| `POST /api/v1/auth/verify-registration` | `email`、`registrationId`、六位数字 `otp` | `{ data: { status: true, token, user } }`；保留库会话字段，同时返回 Cookie 和 `set-auth-token` |
| `POST /api/auth/sign-in/email` | Better Auth 邮箱密码契约 | Better Auth 会话响应；未验证不能登录 |
| `GET /api/auth/get-session` | Cookie 或 Bearer | Better Auth 会话响应或 `null` |
| `POST /api/auth/sign-out` | Cookie 或 Bearer | `{ success: true }`，会话立即失效 |
| `GET /api/v1/me` | Cookie 或 Bearer | `{ data: { id, email, name, emailVerified } }` |

项目接口错误统一为 `{ error: { code, message } }`。库原生错误保持 `{ code, message }`，项目前置来源/限流/格式检查仍返回项目格式。无效输入 400、未认证 401、域名禁用/来源错误 403、超限 429（`Retry-After` 秒）、邮件失败 503，未知错误不输出原文。完整契约与客户端步骤见 [API 接入](api/README.md)。

## 依赖核对与实际缺口

2026-11-07 已阅读下列官方文档及本地已安装版本源码。认证依赖此前已加入 package.json/锁文件，旧文档的“尚未安装”已过时。

- Better Auth / `@better-auth/drizzle-adapter` / CLI `auth` **1.7.18**，MIT；Node 24 + ESM、Express 5 官方集成、Drizzle 0.45.4 / PostgreSQL 适用。复用 scrypt、账号、会话、Email OTP、Bearer 和 OpenAPI 插件。CLI 生成认证 schema，Drizzle Kit **0.31.11** 生成迁移。
- Email OTP 配置 `storeOTP: 'hashed'`、600 秒、5 次尝试、rotate；`requireEmailVerification` 与 `autoSignInAfterVerification` 提供验证前禁止登录及验证后建会话。禁用邮件链接与验证码登录等未开放 HTTP 入口，不能把 `disableSignUp` 当作禁止 OTP 登录。
- 默认重复注册返回模拟成功，不替换未验证账号的原密码。这不能单独满足凭据归属要求：项目增加注册申请 ID，同一邮箱的注册、重发、验证使用 PostgreSQL 事务锁串行化；重新注册在事务中调用库的密码哈希及 `internalAdapter.updatePassword`，替换申请并轮换验证码。验证必须匹配当前申请 ID，避免验证码与另一轮注册的密码交叉使用。该 ID 只是流程关联值，不是业务会话。
- 默认验证码表允许同标识多条记录；发码前通过库 adapter 删除该标识的旧验证码，明确执行轮换。错误验证码的尝试计数必须提交，其他数据库/会话写入失败必须回滚。
- `auth.api` 内部调用不经过 HTTP 限流。复用已安装 **rate-limiter-flexible 11.3.0**（ISC，Node >=20、ESM 可导入）Memory limiter，对项目入口补 IP、邮箱及 60 秒重发间隔。适用当前单进程部署，重启清空计数；多进程部署前必须改用共享存储。PostgreSQL 事务负责流程并发，不自行实现验证码/限流算法。
- SMTP 复用现有 Nodemailer 适配器。实测库的 `sendVerificationOTP` 会通过 `runInBackgroundOrAwait` 吞掉发信异常，即使没有后台 handler 也如此。因此轮换时调用官方 server-only `createVerificationOTP` 生成并保存哈希，再由项目显式等待 SMTP；仍由库负责验证码生成、哈希及验证。SMTP 失败回滚本次注册数据，客户端稍后重试；供应商接收与数据库提交不是分布式事务，收到邮件不代表注册已提交。
- React 使用官方客户端登录/退出并依赖 HttpOnly Cookie，注册流程用普通 JSON 请求。Flutter 使用普通 HTTPS JSON 请求，保存响应头 `set-auth-token` 到平台安全存储，后续 `Authorization: Bearer ...`；不假定存在官方 Flutter SDK。
- OpenAPI 插件生成的可空模型字段、登录 `redirect`、Cookie 鉴权名称及安全方案存在缺口；生成脚本根据实测结果修正，只保留已开放接口和 User/Session 模型。项目请求从路由 Zod schema 生成；邮箱 trim/lowercase 和后续 pipe 校验另补说明，避免把生成结果当成完整运行时行为。
- 隔离集成验证工具 **embedded-postgres 18.6.0-beta.19**（MIT；二进制分发 Apache-2.0；Node >=16，Linux x64 支持）仅安装到临时工具目录，启动真实 PostgreSQL，显式传入 `TEST_DATABASE_URL`。不作为产品运行依赖。

官方依据：

- https://better-auth.com/docs/authentication/email-password
- https://better-auth.com/docs/plugins/email-otp
- https://better-auth.com/docs/plugins/bearer
- https://better-auth.com/docs/integrations/express
- https://better-auth.com/docs/adapters/drizzle
- https://better-auth.com/docs/concepts/hooks
- https://better-auth.com/docs/concepts/rate-limit
- https://better-auth.com/docs/plugins/open-api
- https://github.com/animir/node-rate-limiter-flexible/wiki/Overall-example
- https://orm.drizzle.team/docs/migrations
- https://github.com/leinelissen/embedded-postgres

## 数据与策略

认证表遵循 CLI schema；业务表 `registration_attempt` 保存当前申请与 user ID 关系，`blocked_email_domain` 保存可启停域名规则。默认三条禁用域名由迁移写入。按域名标签边界检查，发码与完成注册时均读取规则；已有已验证账号不受新注册规则影响。后台管理界面及管理员认证留到独立功能实现。

限流当前值：客户端 IP 共用 120 次/分钟；同邮箱注册/重发共用 60 秒冷却及 10 次/小时；验证 30 次/10 分钟；登录 10 次/10 分钟。失败请求也计数。默认取 socket 地址，忽略客户端伪造的转发头；配置 `TRUST_PROXY` 后，由 Express 仅沿显式信任的代理解析客户端 IP，限流与会话共用解析结果。Caddy 单机配置见 [部署步骤](06-deployment.md)。

## 本地运行与迁移

1. 参考 `apps/api/config/.env.example` 在本地环境文件或部署环境中设置数据库、SMTP 以及以下变量。真实配置文件本轮没有覆盖。
   - `AUTH_SECRET`：密码管理器生成至少 32 字符随机密钥；同一部署各次启动保持一致。
   - `AUTH_BASE_URL`：对客户端公开的 API 源，例如本地 `http://localhost:3000`；生产必须 HTTPS，不能带路径、查询、账号或密码。
   - `AUTH_TRUSTED_ORIGINS`：浏览器页面来源，逗号分隔；开发为 `http://localhost:5173`，生产也必须 HTTPS。API 自身来源默认受信任。
   - SMTP 按 [第四步](04-smtp.md) 配置，From 为 `noreply@whisprea.ink`。
2. 执行 `pnpm db:migrate`，将 `apps/api/drizzle/` 中的迁移应用到开发库。生产使用 `pnpm db:migrate:production`；服务启动不自动迁移。本轮仅对临时测试库执行过迁移。
3. 执行 `pnpm dev`。启动读取认证/SMTP 配置并检查数据库；SMTP 创建阶段不联网。

迁移包括四张认证表、两张项目表和初始域名规则。CLI 用 `pnpm auth:schema` 重新生成认证 schema；后续变更用 `pnpm db:generate` 生成迁移并审查。种子只执行一次，重启/重复迁移不会覆盖已有规则。

## 测试与契约命令

```bash
# apps/api/config/.env.test 或进程环境中显式设置独立 TEST_DATABASE_* 后：
pnpm db:migrate:test  # 可选；认证测试会自行执行迁移
pnpm test:auth
pnpm api:generate
pnpm typecheck
pnpm lint
pnpm test
```

认证测试会建表、插入测试用户和规则，并清理自己创建的数据；不能使用开发库/生产库。未配置 `TEST_DATABASE_URL` 时集成套件明确跳过。验证并发时建议 `TEST_DATABASE_POOL_MAX=5`。本轮使用临时目录内的 embedded-postgres 启动隔离 PostgreSQL，凭据由内存生成并通过子进程环境传入，运行结束已停止并移除临时数据目录。邮件始终使用替身。

## 验收

使用独立测试库及邮件替身，覆盖注册直达会话、Cookie/Bearer、退出、错误/过期/重放/并发验证码、五次尝试、重发轮换、SMTP 回滚恢复、重复注册密码归属、跨申请验证、域名与子域名、动态变更、输入、限流、伪造转发 IP、来源校验及未开放入口。

2026-11-07 结果：

- `pnpm typecheck`、`pnpm lint`：API 与管理后台均通过。
- `pnpm test`（显式注入独立测试库）：**40 项通过，0 跳过**，其中认证 18 项；包括会话写入失败回滚、并发错码累计、HTTPS Cookie 属性和原生登录限流。
- `pnpm api:generate`：生成成功，契约位于 `docs/api/openapi.json`。
- 未执行真实环境迁移或真实 SMTP 连接/发送；Flutter 页面和后台域名管理为后续接入工作。
