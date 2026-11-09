# 第四步：SMTP 邮件模块

日期：2026-11-06。状态：实现与本地验证完成；尚未连接 Resend 或发送真实邮件。

## 目标和边界

邮件模块已在 [注册流程](05-registration.md) 中接入，保留内部发送适配器。SMTP 由环境变量配置，发件地址为 `noreply@whisprea.ink`。禁用域名属于注册业务层，不能在通用发信层拦截，否则会误伤已有用户的找回密码邮件。

## 依赖核对

使用 `pnpm --filter @folinel/api add nodemailer@^10.3.1` 安装，锁文件锁定 10.3.1。2026-11-06 核对包元数据和官方资料：MIT-0 许可证、Node >=20、自带 TypeScript 类型，项目 Node 24 可用；提供 SMTP、TLS、MIME、连接检查和内存 transport，不引入重复的类型包或 Resend API SDK。

参考：`https://nodemailer.com/smtp`、`https://nodemailer.com/transports/stream`、`https://resend.com/docs/send-with-smtp`。自动化测试验证项目行为，真实域名许可和送达仍依赖供应商。

## 文件和调用顺序

- `apps/api/src/email/smtp.ts`：`readSmtpConfig` 用现有 Zod 校验环境变量；`createSmtpTransport` 交给 Nodemailer 连接；`createSmtpMailer` 提供 `send/verify/close`。导入和创建对象均不联网。
- `apps/api/src/email/registration.ts`：`registrationEmail(to, otp)` 生成中文主题、纯文本及 HTML。验证码限定六位数字，只展示，不生成、存储或验证验证码有效性。展示的 10 分钟须与后续认证插件 600 秒配置同步。
- `apps/api/src/email/check.ts`：读取当前环境 → 创建 mailer → `verify()` → 始终关闭；不调用 `send()`。
- `apps/api/tests/email.test.ts`：官方 stream transport 生成 MIME、替身模拟失败，避免真实发信。

失败分三类：`SmtpConfigError`、`EmailInputError`、`EmailDeliveryError`，消息固定且不带原异常 `cause`。发送成功只返回 `messageId`，不返回正文或原始供应商响应；SMTP 接收不等于邮箱送达。注册路由将发送失败映射为 503 `EMAIL_UNAVAILABLE`。

## 环境变量

本地开发文件 `apps/api/config/.env.development`、生产模板 `.env.production` 和 `.env.example` 已补缺失字段，已有配置不覆盖。

```env
SMTP_HOST=smtp.resend.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=resend
SMTP_PASSWORD=
SMTP_FROM=noreply@whisprea.ink
```

本地填写 `SMTP_PASSWORD` 为 Resend API key；生产通过部署环境注入密钥。环境文件不提交，密钥不进入后台的 `VITE_*` 变量。

`SMTP_SECURE=false` 强制 STARTTLS；`true` 用于隐式 TLS（例如 Resend 465），两种方式均校验证书且最低 TLS 1.2。不提供明文认证开关。连接、DNS、问候等待 10 秒，连接空闲超时 15 秒；这些是不同阶段的限制，不是邮件送达承诺。关闭 SMTP 调试日志，禁止邮件读取本地文件或远程 URL。

## 执行和验证

```bash
pnpm test:email             # 不依赖数据库，不联网发信
pnpm typecheck
pnpm lint
pnpm test

# 填好本地 SMTP 密码后自行执行：
pnpm smtp:check             # 开发配置，只连接及认证
pnpm smtp:check:production  # 生产配置，只连接及认证
```

连接检查不会验证发件地址是否允许、收件箱是否收到；真实发送前需在 Resend 确认 `whisprea.ink` 已验证，并指定测试收件地址。本次不会自动执行真实连接或发信。

验证结果：

- `pnpm test:email`：9 项通过；包括 CLI 配置失败返回非零状态、TLS 配置、实际 MIME 内容、收件人及参数限制、SMTP 拒绝和原始错误脱敏。
- `pnpm typecheck`：API 和管理后台均通过。
- `pnpm lint`：API 和管理后台均通过。
- `pnpm test`：21 项通过、1 项跳过；未配置 `TEST_DATABASE_URL`，因此不连接真实数据库。

测试包含 Node 子进程和 Supertest 本地监听，需在允许这些操作的环境运行。未运行真实 SMTP 连接或送达验证。

## 未完成范围

2026-11-07 已挂入 `main.ts`，API 启动需要有效 SMTP 配置，但启动本身不连接 SMTP。注册及失败恢复见 [第五步](05-registration.md)；真实 SMTP 连接和送达仍待验证。以上测试数字为本步骤完成时的历史记录。
