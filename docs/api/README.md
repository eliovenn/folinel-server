# API 契约与客户端接入

契约：[openapi.json](openapi.json)（OpenAPI 3.1.1）。运行 `pnpm api:generate` 更新：项目请求取自实际 Zod schema，原生认证请求及响应取自 Better Auth OpenAPI 插件，再根据配置、路由白名单和实测结果修正。生成不读取真实配置，也不连接数据库或 SMTP。

## 注册顺序

1. `POST /api/v1/auth/register`：`{ "email": "user@example.com", "password": "..." }`。保存 `data.registrationId`；此时没有业务会话。
2. 用户输入邮件中六位验证码，调用 `POST /api/v1/auth/verify-registration`：`{ "email": "user@example.com", "registrationId": "注册响应中的 ID", "otp": "六位数字" }`。
3. 成功后 `data.user` 为已验证用户，凭会话调用 `GET /api/v1/me`，直接进入应用。
4. 重发使用 `POST /api/v1/auth/resend`，传邮箱和当前 `registrationId`。重新注册会换申请 ID，必须同步更新客户端状态。

项目成功响应 `{ data: ... }`，错误 `{ error: { code, message } }`。根据 HTTP 状态和 `code` 处理错误，不解析文案。429 按 `Retry-After`（秒）等待。常用错误：`VALIDATION_ERROR`、`REGISTRATION_INVALID`、`EMAIL_DOMAIN_BLOCKED`、`INVALID_OTP`、`OTP_EXPIRED`、`TOO_MANY_ATTEMPTS`、`RATE_LIMITED`、`EMAIL_UNAVAILABLE`、`UNAUTHENTICATED`。

## Flutter

- 普通 HTTPS JSON 请求即可；注册页只收邮箱和密码。
- 验证和登录响应头 `set-auth-token` 是签名会话凭据；放入平台安全存储，之后发送 `Authorization: Bearer <凭据>`。不要记录到日志。
- 登录：`POST /api/auth/sign-in/email`，发送邮箱和密码。成功响应为库的 `{ redirect, token, user, url? }`，没有 `data` 包装。
- 退出：`POST /api/auth/sign-out`，JSON `{}`；服务端吊销会话后清除本地凭据。
- 不需要伪造浏览器 Origin/Cookie。默认持久会话有效期 7 天，活动会话按库默认 1 天更新；过期后重新登录。

## React / 浏览器

- 使用同源 `/api/...`。Vite 已配置 `/api` 转发到 `http://localhost:3000`；生产反向代理保持前端与 API 同源。
- JSON 请求使用 `credentials: 'include'`；浏览器自动处理 HttpOnly Cookie，无需把 token 放入 localStorage。可使用 Better Auth 官方 React 客户端登录、查询会话和退出；自定义注册三步直接调用项目路由。
- `AUTH_TRUSTED_ORIGINS` 填实际页面来源（开发默认为 `http://localhost:5173`），多个来源用逗号分隔。来源信任不等于 CORS；当前采用同源代理。
- HTTPS Cookie 使用 `Secure`、`HttpOnly`、`SameSite=Lax`。携带 Cookie 的 POST 需要可信 Origin，防止跨站请求。
- 原生认证错误保持 `{ code, message }`；来源/限流等项目前置检查可能返回 `{ error: { code, message } }`，客户端同时识别两种，详见 OpenAPI。

当前只开放契约列出的入口。验证码登录、原生注册、链接验证、改邮箱、找回密码、域名管理及在线 OpenAPI 页面需在各自功能完成后开放。
