# folinel-server 开发约定

## 项目范围

这是 Folinel 的 API 和 React 管理后台 workspace。`apps/api` 是 Express + TypeScript + PostgreSQL + Drizzle，`apps/admin` 是 React + Vite + shadcn/ui。后端已有邮箱密码注册、邮件验证码、Cookie/Bearer 会话及注册域名限制；管理后台仍为基础界面。

## 开发原则

- 独立开发时保持实现范围小：一次只完成一个可验证的功能。
- 先定义行为和接口，再写实现；项目成功响应使用 `{ data: ... }`，错误使用 `{ error: { code, message } }`。基础错误已统一；`/api/auth` 原生成功/错误遵循库契约，前置检查仍为项目错误格式。
- 业务代码、测试说明和关键注释使用中文；变量、函数、类型和数据库字段使用清晰的英文命名。
- API 契约采用 OpenAPI，位于 `docs/api/`，用 `pnpm api:generate` 更新；管理后台和 Flutter 据此接入。不强制维护共享 TypeScript 类型包。
- 密钥、数据库密码、用户正文、笔记正文和 AI 输入不得进入代码、Git、日志或错误响应。

## 第三方库优先（每项功能必须执行）

- 开始实现功能前，先检查项目现有依赖，再查阅官方文档、官方插件和维护中的第三方库；确认能否满足当前行为与失败场景，不能先手写一套再补选型。
- 有适用、维护可靠且许可证兼容的实现时，必须优先使用。检查 Node.js 24 / ESM / Express 5 / Drizzle / PostgreSQL 的兼容性，以及 Flutter 与 React 的实际接入方式。涉及平台登录时，区分网页、原生应用和小程序，不能只根据功能名称推断支持。
- 密码哈希、会话、验证码生成与验证、SMTP 协议、OAuth 流程、限流等通用能力优先交给成熟库及其官方插件，不重复实现；只写必要的业务规则和接入代码，例如后台可配置的邮箱域名限制。
- 新增依赖前在功能文档记录用途、核对的版本/日期、官方依据、适用范围和缺口。不为了很小的需求引入整套无关框架，也不同时保留功能重复的库。
- 库无法完整覆盖需求时，先记录实际缺口，优先用官方配置、hook 或 adapter 扩展，再实现最小业务补充；不能虚称“完全原生支持”，也不能默认复制旧项目实现。
- 使用第三方库仍要编写项目级行为测试，包括成功、失败、权限和不可绕过的业务限制。测试 SMTP 使用替身或本地测试服务，避免把自动化测试变成真实发信。
- 初始化、组件安装、认证 schema 和数据库迁移优先使用对应工具命令生成，随后审查结果。

## 已确认的账户需求

- 第一版登录使用邮箱和密码。
- Flutter 注册只输入邮箱和密码；点击注册后发送邮件验证码，验证成功由服务端建立会话，用户直接进入应用，不再输入密码登录。验证前不得获得可访问业务的会话。
- 禁用邮箱域名支持管理后台配置，后端执行限制；初始为 `outlook.com`、`hotmail.com`、`live.com` 及其子域名，只限制新注册和更换邮箱，已有用户仍可登录和找回密码。
- SMTP 仅通过环境变量配置，发件地址为 `noreply@whisprea.ink`；前期使用 Resend，后期可切换到其他 SMTP 服务。使用 Nodemailer，禁止明文传输和关闭证书校验；密钥不进入代码、日志、文档或数据库。
- 后续需要手机号和微信登录，统一以内部 user ID 关联登录方式，不以邮箱作为不可更改的业务主键。平台接入和账号绑定策略在对应功能开始前核对。
- SMTP、注册验证/登录/退出、认证迁移和域名检查已实现；域名管理界面、找回密码及改邮箱尚未实现。详见 `docs/05-registration.md` 与 `docs/api/README.md`。
- 注册必须绑定当前 `registrationId`，同邮箱流程由 PostgreSQL 事务锁串行化。发码用库的 server-only `createVerificationOTP` 后显式等待 SMTP；不能改回会吞掉发信异常的 `sendVerificationOTP`。原生路由保持白名单，避免绕过项目策略。

## 已安装的 skill

- `supabase-postgres-best-practices`：数据库设计与查询时按需使用，项目仍支持普通 PostgreSQL。
- `vercel-react-best-practices`：管理后台 React 开发时按需使用，只采用 React/Vite 适用的规则。
- Skill 不替代上述依赖核对、测试和项目业务规则；具体用户要求优先。

## 后端目录

- `apps/api/src/main.ts`：读取环境变量、检查数据库、启动和关闭 HTTP 服务。
- `apps/api/src/server.ts`：Express 实例、中间件、公开基础路由和错误处理。
- `apps/api/src/config/`：进程级环境配置。
- `apps/api/src/email/`：SMTP 配置、邮件适配器、注册邮件模板及连接检查；只有 send/verify 才联网，注册使用此模块。
- `apps/api/src/db/`：数据库连接、配置、错误映射；不在启动时自动建表或迁移。
- `apps/api/src/modules/auth/`：注册、域名策略、限流、认证配置及 HTTP 边界。其他领域按 `routes.ts`、`service.ts`、`repository.ts`、`validation.ts` 拆分；简单功能可以合并文件。
- `apps/api/tests/`：API、配置和数据库测试。真实数据库测试只使用 `TEST_DATABASE_URL` 指向的独立测试库。

## 一个功能的完成顺序

1. 先完成第三方库能力核对，再在功能文档中写清楚目标、边界、请求、响应、失败情况及复用方式。
2. 如果需要数据，先设计 Drizzle schema，再用 `pnpm db:generate` 生成迁移；认证 schema 用 `pnpm auth:schema` 生成后审查。禁止手改 `drizzle/meta/`。
3. 为新增业务和 bug 修复写能表达行为的测试，再实现功能；小型可逆改动不写只重复实现细节的测试。
4. 功能实现时同步维护 OpenAPI，更新步骤文档和 `docs/README.md` 索引。鉴权库自带的接口按其实际契约记录，不强行包装。
5. 运行 API typecheck、lint、相关测试和完整测试；真实数据库测试必须明确使用独立库。
6. 检查日志、错误响应和配置中没有泄露密钥或用户内容。

## 命令

在 workspace 根目录执行：

```bash
pnpm dev
pnpm db:check
pnpm test:db
pnpm test:email
pnpm test:auth
pnpm api:generate
pnpm db:generate
pnpm db:migrate    # 显式迁移当前开发库
pnpm smtp:check  # 连接及认证检查，不发送邮件
pnpm typecheck
pnpm lint
pnpm test
```

认证集成测试自动迁移独立测试库；未配置 `TEST_DATABASE_URL` 时明确跳过。运行中服务不会自动迁移。生产迁移使用 `pnpm db:migrate:production`。
