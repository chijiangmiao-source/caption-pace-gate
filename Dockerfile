# 构建阶段
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# 运行阶段：零依赖 Node 静态服务器（无需 node_modules / vite 工具链）
FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/dist ./dist
COPY --from=build /app/server.mjs ./server.mjs
EXPOSE 4173
# 容器级健康探针，供编排据此判断页面真正可服务
HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=12 \
  CMD node -e "require('http').get('http://127.0.0.1:4173/healthz',(r)=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
CMD ["node", "server.mjs"]
