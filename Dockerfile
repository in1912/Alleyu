# 游巷 Alleyu —— Node 22（node:sqlite 需要 >= 22.5）
FROM node:22-alpine

WORKDIR /app

# 前端构建产物随仓库分发（web/dist/<时间戳>/），不需要在镜像里重复构建
COPY server ./server
COPY package.json ./
COPY web/dist ./web/dist

RUN npm install --omit=dev --no-audit --no-fund

ENV PORT=9610
ENV DATA_DIR=/app/data
VOLUME /app/data

EXPOSE 9610
CMD ["node", "--no-warnings", "server/index.js"]
