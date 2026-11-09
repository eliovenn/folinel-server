# syntax=docker/dockerfile:1

FROM node:24-bookworm-slim AS build
WORKDIR /workspace
RUN npm install --global pnpm@12.15.0

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/admin/package.json apps/admin/package.json
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build
# pnpm 生成可移植的生产依赖；API 的 files 白名单保留源码及迁移。
RUN pnpm --filter @folinel/api deploy --prod /out/api

FROM node:24-bookworm-slim AS api
ENV NODE_ENV=production PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /out/api/ ./
USER node
EXPOSE 3000
CMD ["node", "src/main.ts"]

FROM caddy:2-alpine AS web
COPY --from=build /workspace/apps/admin/dist/ /srv/
COPY deploy/Caddyfile /etc/caddy/Caddyfile
