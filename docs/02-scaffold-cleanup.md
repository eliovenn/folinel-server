# 第二步：移除初始化演示代码

数据库连接成功后，清理 Express 初始化模板，保留下一项业务开发需要的基础。

## 已完成

- 删除模板 User 路由、服务、实体、JSON 仓储及其测试。
- 删除 Bootstrap 静态页面、浏览器 live reload 和演示工具函数。
- 移除 `express-zod-safe`、`uuid`、`connect-livereload`、`livereload` 及两个 live reload 类型包，同步更新锁文件。
- 删除当前未使用的空部署目录、接口文档目录和迁移目录，实施对应功能时再创建。
- 保留数据库配置、严格 TLS 校验、只读检查和独立测试库隔离。
- 保留管理后台 React/shadcn 初始化项目；本步骤只清理 API。
- 新增 `/health` 存活接口与基础 HTTP 测试；`src/config/env.ts` 统一服务环境校验。

## 当前接口

`GET /health` 返回 `{ "data": { "status": "ok" } }`。它只表示 API 进程可响应；数据库在启动前检查一次，不代表运行期间数据库始终可用。未知路径返回 JSON 404，错误 JSON 返回 400，过大 JSON 返回 413。

还未实现业务 schema、迁移脚本、鉴权、OpenAPI、统一业务错误格式。后续按 [开发规范](development.md) 逐项添加。

## 验证

API 类型检查与 lint 已通过；当前完整 API 测试为 12 项通过，1 项因未配置独立测试库跳过。真实 Supabase 连接已由用户确认成功。

执行 `pnpm typecheck`、`pnpm lint` 和 `pnpm test` 验证基础；`pnpm db:check` 单独验证开发数据库，不会创建表或修改数据。
