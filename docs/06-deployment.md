# 第六步：Ubuntu 单机部署

日期：2026-11-09。适用 Ubuntu 24.04、2 核 2GB 起步，PostgreSQL 与应用同机。

## 目标与行为

- GitHub Actions 检查代码并构建 API、Web 两个镜像，发布到 GHCR；Ubuntu 只拉取和运行镜像。
- Caddy 在同一个域名提供管理后台静态文件，将 `/api`、`/api/*`、`/health` 原路径转发给 API，自动申请和续期 HTTPS 证书。
- PostgreSQL 使用命名卷保存数据；应用用独立的非超级用户 `folinel` 连接。数据库和 API 只在容器网络内提供服务。
- 首次部署按“数据库健康 → 显式迁移 → API 健康 → Web”执行。迁移失败必须停止发布，运行中的 API 不自动迁移。
- API 保持单进程。只信任 Caddy 的固定容器 IP；默认直连模式忽略客户端转发头。限流和 Better Auth 使用同一个解析后的客户端 IP。
- API 请求、成功和错误格式沿用 [OpenAPI](api/README.md)。`/health` 是存活检查，不能替代持续的数据库或 SMTP 可用性监测。
- 本步骤按新建生产数据库部署。开发库的数据不会自动复制；需要保留已有数据时，先单独安排数据导出、恢复和核对。

## 依赖核对与复用

2026-11-09 核对现有依赖及下列官方文档；不新增 npm 运行依赖。

| 工具 | 版本 / 许可 | 复用与边界 |
| --- | --- | --- |
| Node.js / pnpm | Node 24（MIT）、pnpm 12.15.0（MIT） | Node 原生运行 ESM TypeScript；`pnpm deploy --prod` 输出独立 API 运行目录，保留迁移文件；前端由现有 Vite 构建 |
| Docker Engine / Compose | Ubuntu 官方软件源版本；校验用 Compose 5.7.0（Apache-2.0） | 多阶段构建、健康依赖、命名卷、日志轮换；使用支持 `up --wait` 的当前 Compose 插件 |
| Caddy | `caddy:2-alpine`，校验用 2.11.9（Apache-2.0） | 官方静态站点、SPA fallback、反向代理与自动 HTTPS；本配置面向公网直连 Caddy，域名 DNS 使用直连模式 |
| PostgreSQL | `postgres:17-alpine`（PostgreSQL License） | 固定 17 主版本；官方初始化脚本创建应用角色和库；仅空数据卷执行初始化 |
| Express / Zod | 现有 Express 5.3.0 / Zod 4.6.5（MIT） | Express 原生 `trust proxy` 解析可信代理链，Zod 验证明确的 IP/CIDR；不自行解析 `X-Forwarded-For` |
| GitHub / Docker Actions | checkout/setup-node v7（MIT），Docker login/buildx/qemu v4、build-push v7（Apache-2.0） | 内置 `GITHUB_TOKEN` 发布镜像；服务器用有包读取权限的账号拉取。CI 在独立 PostgreSQL 上测试，SMTP 使用替身 |

官方依据：

- https://docs.docker.com/engine/install/ubuntu/
- https://docs.docker.com/compose/how-tos/startup-order/
- https://pnpm.io/docker
- https://pnpm.io/cli/deploy
- https://hub.docker.com/_/postgres
- https://caddyserver.com/docs/caddyfile/patterns
- https://caddyserver.com/docs/caddyfile/directives/reverse_proxy
- https://expressjs.com/en/guide/behind-proxies.html
- https://docs.docker.com/build/ci/github-actions/push-multi-registries/
- https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry

基础镜像跟随所选主版本的更新，发布镜像用 `sha-完整提交号` 标识。应用升级不会自动升级 PostgreSQL 主版本；主版本升级需安排数据迁移。

## 1. 本地提交，再到 GitHub 构建

管理后台已经并入主仓库。原嵌套仓库历史保存在本地 `.git/local-backups/admin.git`，后台现有文件按普通 workspace 文件提交。

在本地项目根目录审查并提交本次部署文件和后台源码，然后推送 `main`。GitHub → **Actions → 构建和发布镜像** 会自动运行，也支持手动触发。工作流需要仓库允许 GitHub Actions 和 `packages: write`；生产数据库、SMTP 和服务器 SSH 密钥都不用交给这个工作流。

```bash
git add Dockerfile .dockerignore .github deploy apps/admin apps/api docs README.md
git commit -m "配置单机部署与镜像发布"
git push origin main
```

全部任务通过后，在发布任务摘要中复制：

```dotenv
IMAGE_PREFIX=ghcr.io/你的账号/你的仓库
IMAGE_TAG=sha-完整提交号
```

镜像名称统一小写，分别为 `${IMAGE_PREFIX}-api:${IMAGE_TAG}` 和 `${IMAGE_PREFIX}-web:${IMAGE_TAG}`。两个镜像都支持 Linux amd64 / arm64。只有整个工作流成功后才部署该版本。

## 2. 服务器安装 Docker

在 Ubuntu 服务器的 SSH 终端执行：

```bash
sudo apt update
sudo apt install -y ca-certificates curl git python3
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
sudo tee /etc/apt/sources.list.d/docker.sources > /dev/null <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo docker run --rm hello-world
sudo docker compose version
```

将域名的 A 记录指向服务器 IPv4；只有服务器确实支持 IPv6 时才设置 AAAA。云服务器安全组和已启用的主机防火墙应允许 SSH、TCP 80/443；HTTP/3 可另外开放 UDP 443。保持 DNS 直连，Caddy 自动处理证书。

## 3. 将部署文件放到服务器

在本地将 `deploy/` 上传到服务器，例如（替换登录用户和服务器地址）：

```bash
ssh 用户名@服务器地址 'mkdir -p ~/folinel-deploy'
scp deploy/compose.yaml deploy/postgres-init.sql deploy/.env.example 用户名@服务器地址:~/folinel-deploy/
```

之后在服务器执行，以下命令始终在这个目录运行：

```bash
cd ~/folinel-deploy
umask 077
cp -n .env.example .env
chmod 600 .env
```

用 Python 的标准随机库直接填入三个空白密钥字段，不在终端输出密钥；重复执行保留已有值：

```bash
python3 - <<'PY'
from pathlib import Path
import secrets

path = Path('.env')
keys = {'POSTGRES_ADMIN_PASSWORD', 'APP_DB_PASSWORD', 'AUTH_SECRET'}
lines = []
for line in path.read_text().splitlines():
    key, sep, value = line.partition('=')
    if sep and key in keys and not value.strip():
        line = f'{key}={secrets.token_hex(32)}'
    lines.append(line)
path.write_text('\n'.join(lines) + '\n')
path.chmod(0o600)
PY
```

编辑 `.env`：

```bash
nano .env
```

必填项：

| 配置 | 填法 |
| --- | --- |
| `IMAGE_PREFIX`、`IMAGE_TAG` | 复制 GitHub 成功构建任务的摘要 |
| `SITE_DOMAIN` | 一个真实域名，例如 `app.example.com`，不带协议和路径 |
| `POSTGRES_ADMIN_PASSWORD` | 上一步生成，供数据库管理角色使用 |
| `APP_DB_PASSWORD` | 上一步生成的十六进制密码，用于组装应用连接串 |
| `AUTH_SECRET` | 上一步生成，后续发布保持不变 |
| `SMTP_PASSWORD` | Resend API key；只填服务器 `.env` |

默认 SMTP 是 `smtp.resend.com:587`，`SMTP_SECURE=false` 表示强制 STARTTLS，发件地址固定为 `noreply@whisprea.ink`。先在 Resend 验证发信域名。密码含 `$` 等字符时用 dotenv 单引号包裹。

Compose 自动设置 `AUTH_BASE_URL=https://你的域名`、相同的 `AUTH_TRUSTED_ORIGINS`、容器数据库地址和 `TRUST_PROXY`；数据库通信只走同机私有容器网络，所以本配置 `DATABASE_SSL=false`。这是独立生产环境，不使用本地开发 `.env`。

`PROXY_SUBNET` / `PROXY_IP` 默认无需修改；如果与服务器现有网络重叠，选择一个空闲子网，并把代理 IP 一起改到该子网内。仅 Caddy 接入该固定 IP，API 不发布宿主机端口。以后接 CDN 时，要先重新核对边缘代理的可信 IP 与真实客户端 IP 策略。

## 4. 登录 GHCR 并首次启动

在 GitHub 创建具有 `read:packages` 权限的 **Personal access token (classic)**，所属账号必须有这两个包的读取权限。在服务器交互式登录，Password 提示处粘贴 token：

```bash
sudo docker login ghcr.io -u 你的GitHub用户名
```

顺序执行，每步成功后再继续：

```bash
sudo docker compose config --quiet
sudo docker compose pull
sudo docker compose up -d --wait db
sudo docker compose run --rm --no-deps api node src/db/migrate.ts
sudo docker compose run --rm --no-deps api node src/email/check.ts
sudo docker compose up -d --wait api web
sudo docker compose ps
curl --fail --show-error https://你的域名/health
```

迁移命令与 `pnpm db:migrate:production` 使用同一入口；镜像已经设置生产环境。SMTP 检查只验证连接和认证，不发送邮件。健康请求应返回：

```json
{ "data": { "status": "ok" } }
```

浏览器打开 `https://你的域名` 查看管理后台。当前后台仍是基础界面，管理登录和域名管理是后续业务功能；部署成功不会额外生成管理员账号。Flutter 的 API 源也配置为同一 HTTPS 域名。

## 5. 之后如何更新

1. 本地提交代码并推送 `main`，等待整个镜像工作流成功。
2. 部署配置有变化时同步对应文件，保留服务器 `.env`。
3. 在服务器 `.env` 更新 `IMAGE_TAG`，先备份数据库，再按以下顺序执行。

```bash
sudo docker compose pull api web
sudo docker compose run --rm --no-deps api node src/db/migrate.ts
sudo docker compose up -d --no-deps --wait api web
curl --fail --show-error https://你的域名/health
```

单实例更新存在短暂中断。迁移必须兼容更新期间仍在运行的旧 API；破坏性迁移需另行安排维护窗口。应用回退可改回旧 `IMAGE_TAG` 后拉取、更新容器，但数据库迁移不会自动回退；只有旧应用兼容当前 schema 时才能直接回退。

## 数据保存、备份与排查

- 数据在 `postgres_data` 命名卷中，证书在 `caddy_data` / `caddy_config` 中；普通容器更新保留这些卷。`docker compose down -v` 会删除数据卷，日常更新使用上述 `up` 流程。
- 首次初始化后，修改 `.env` 的数据库密码不会修改已有数据库角色密码；更换密码需要先在 PostgreSQL 中轮换，再同步应用配置。
- 按低负载起步设置 PostgreSQL 30 个连接、API 连接池 5；2GB 服务器不执行镜像构建。使用 `sudo docker stats --no-stream` 观察实际内存，再决定升级到 4GB。
- Compose 日志自动轮换。API 不记录请求正文，Caddy 不启用访问日志；PostgreSQL 关闭 SQL 错误语句和参数记录。

备份（服务器部署目录执行；数据库导出含用户数据，文件只保存在受控位置，并另存服务器之外）：

```bash
umask 077
mkdir -p backups
sudo docker compose exec -T db pg_dump -U postgres -d folinel -Fc > "backups/folinel-$(date +%Y%m%d-%H%M%S).dump"
```

定期执行备份，并在独立数据库验证恢复；仅保存同机文件不能覆盖服务器故障。

排查命令：

```bash
sudo docker compose ps
sudo docker compose logs --tail=100 api web
sudo docker compose run --rm --no-deps api node src/db/check.ts
sudo docker stats --no-stream
```

常见失败：GHCR `denied` 检查账号的包读取权限；找不到镜像检查工作流是否全部成功及标签大小写；HTTPS 失败检查域名解析和 80/443；API 启动失败检查环境字段及迁移结果。生产排查使用 `config --quiet` 验证配置，不把展开后的环境配置粘贴到日志或讨论中。

## 本次验证结果

2026-11-09：

- `pnpm typecheck`、`pnpm lint`、`pnpm build` 通过；OpenAPI 重新生成后没有契约变化。
- 显式注入临时独立 PostgreSQL 17 的 `TEST_DATABASE_URL`，`pnpm test` **44 项通过、0 跳过**；SMTP 均使用替身。
- 使用真实 `psql` 执行 `postgres-init.sql`，确认应用角色不是超级用户；以该角色执行生产迁移成功。
- `pnpm deploy --prod` 生成的独立目录包含生产依赖、源码和迁移；从该目录以生产配置启动、访问 `/health`、未登录访问业务入口返回 401、SIGTERM 正常退出均通过。
- Compose 5.7.0 完整配置及必填变量缺失检查通过；actionlint 1.7.12 校验工作流通过。
- Caddy 2.11.9 配置验证及本地实际 HTTP 请求通过：API 路径保留、未知 API 返回 JSON 404、转发头覆盖、SPA 深链、静态资源和缓存头。
- 本地校验工具只放 `/tmp/opencode/`，数据库使用 `embedded-postgres 17.11.0-beta.19`（MIT，二进制 Apache-2.0），未增加项目依赖。测试集群已停止并清理。
- 当前本地环境没有 Docker Engine，完整镜像构建、容器组合启动由提交后的 GitHub 构建及服务器部署验收；公网证书、真实 SMTP 连接与送达仍待服务器配置后验证。
