# 第三步准备：账户、验证码和邮件

日期：2026-11-06；2026-11-07 更新。状态：SMTP、注册验证、邮箱登录和会话、注册域名限制、认证表及迁移已实现；域名管理界面尚未实现。实际实现与验证见 [第五步](05-registration.md)。

## 已确认需求

- 登录使用邮箱和密码。
- Flutter 注册：输入邮箱和密码 → 注册发码 → 输入正确验证码 → 服务端建立会话 → 直接进入应用，不再要求输入密码登录。
- 注册页不增加必填昵称；初始昵称使用“Folinel 用户”。未验证邮箱不能获得业务访问权限。
- 初始禁止 `outlook.com`、`hotmail.com`、`live.com` 及其子域名注册，三个域名作为不同条目，由管理后台维护。
- 禁用规则只限制新注册及更换邮箱，不影响已有用户登录、找回密码和正常使用。
- SMTP 通过 API 环境变量配置，后台不编辑 SMTP 密钥。发件地址为 `noreply@whisprea.ink`，前期使用 Resend，后期可更换其他 SMTP 服务商。
- 以后支持手机号、微信等方式；业务关联内部 user ID，登录方式可绑定到同一账号。本阶段不实现这些入口。

## 第三方库复用

| 能力 | 方案 | 当前状态 |
| --- | --- | --- |
| SMTP、TLS 和 MIME | Nodemailer 10.3.1 | 已安装、自带 TypeScript 类型；配置、发送适配、模板和本地测试见 [SMTP 步骤](04-smtp.md) |
| 邮箱密码、会话 | Better Auth 1.7.18 | 已接入，独立 PostgreSQL 行为测试 |
| 邮箱验证码 | Better Auth Email OTP | 哈希存储、验证后自动建会话；发信异常处理缺口见第五步 |
| Express / PostgreSQL | Better Auth handler + Drizzle adapter | 已接入；CLI schema、Drizzle Kit 迁移 |
| Flutter 会话 | Bearer 插件 | 服务端返回、鉴权与退出失效已验证；Flutter UI 待接入 |
| 手机号、微信 | 官方插件和平台适配库 | 接入时再核对；Flutter 原生授权、网页扫码和小程序需分别评估 |
| 接口文档 | OpenAPI | 优先复用认证库生成能力，并与实际响应核对 |
| 域名限制 | 官方 hook + 项目规则存储和管理界面 | 属于业务规则，不能通过隐藏前端入口代替服务端限制 |

依赖版本、官方资料和实际缺口见 [第五步](05-registration.md)。SMTP 真实送达与客户端界面不在本轮自动化验证范围。

## 注册行为及默认值

- 六位数字验证码，有效期 10 分钟；单码最多尝试 5 次，同一邮箱重发间隔 60 秒，增加邮箱/IP 维度限流。
- 验证码生成、哈希存储和验证交给库；重发让旧码失效。模板只接收验证码，不生成或保存密码/验证码。
- 评估 `requireEmailVerification`、`overrideDefaultEmailVerification` 和 `autoSignInAfterVerification` 对选定版本的作用，测试验证前无业务会话、验证后可直接访问当前用户接口。
- 第一版只开放邮箱密码登录，需检查插件附带的验证码登录入口是否可以绕过，不能只从 UI 隐藏；不要把限制自动注册的配置当作禁用验证码登录。
- 检查内部 API 调用是否经过 HTTP 限流；必要时在实际入口复用成熟限流实现。
- 重复注册、发信失败后的恢复、未验证账号再次注册需要测试凭据归属，避免验证后保留他人预先设置的密码。
- 管理后台先按单管理员规划，受控初始化；管理员认证方式在实现后台前确定。
- 未来新增登录方式需验证凭据归属，不按相似邮箱或昵称自动合并账号。

## 域名规则

- 完整域名归一化后按标签边界匹配；例如 `outlook.com` 和 `mail.outlook.com` 被限制，`notoutlook.com` 不受该条影响。
- 发码前和完成注册时都检查；配置改变后仍不能绕过，也不能把已有已验证账号误当成新注册。
- 管理员可查看、新增、启停和删除规则；普通用户不可编辑，操作留记录。
- 以后手机号/微信创建账号及邮箱绑定应遵循同一策略；不对库生成的临时邮箱盲目套用域名规则。

## SMTP 配置与范围

环境文件已经加入 Resend 示例设置，发件人为 `noreply@whisprea.ink`；`SMTP_PASSWORD` 留空供本地填写。实际发信前仍需在 Resend 确认 `whisprea.ink` 发信域名验证状态。

连接检查 `pnpm smtp:check` 只验证网络、TLS 和认证，不代表 From 已获允许或邮件已送达。自动化测试用 Nodemailer 内存 transport，不发送真实邮件。

切换供应商需更改环境变量、完成新平台域名验证，再检查连接和真实送达；不用 Resend 专属 HTTP API 固化业务。

## 分阶段实现与测试

1. SMTP 基础：已实现配置、发送适配、注册模板和连接检查命令，验证结果见 [第四步](04-smtp.md)。
2. 认证注册：已核对依赖、生成 schema 和迁移，实现注册发码、重发、验证并创建会话、登录、当前用户及退出。
3. 注册策略与后台：域名限制已生效；后续完成受保护的管理接口和 React 页面。
4. 后续单独实现找回密码、手机号、微信及账号绑定。

核心验收：正确注册无需再次登录；错码、过期、重放、超限及未验证不可进入；SMTP 失败可恢复；重复注册不接管账号；域名规则不可绕过；普通用户不可修改规则；退出后会话失效。

## 实现前查阅的官方资料

- 邮箱密码：`https://better-auth.com/docs/authentication/email-password`
- Email OTP：`https://better-auth.com/docs/plugins/email-otp`
- Express：`https://better-auth.com/docs/integrations/express`
- Drizzle：`https://better-auth.com/docs/adapters/drizzle`
- Hooks：`https://better-auth.com/docs/concepts/hooks`
- Bearer：`https://better-auth.com/docs/plugins/bearer`
- Phone Number：`https://better-auth.com/docs/plugins/phone-number`
- WeChat：`https://better-auth.com/docs/authentication/wechat`
- OpenAPI：`https://better-auth.com/docs/plugins/open-api`
- 限流：`https://better-auth.com/docs/concepts/rate-limit`
