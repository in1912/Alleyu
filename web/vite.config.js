// 构建产物进 dist/<时间戳>/（服务端 latestDist() 挑最新目录，与工作台同款升级包约定）
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import fs from 'node:fs';
import path from 'node:path';

const distRoot = path.resolve(__dirname, 'dist');
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
fs.mkdirSync(distRoot, { recursive: true });
fs.writeFileSync(path.join(distRoot, '.latest'), stamp);

export default defineConfig({
  base: './',
  plugins: [vue()],
  build: {
    outDir: `dist/${stamp}`,
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
  },
  server: {
    port: 5180,
    proxy: {
      '/api': { target: 'http://localhost:9610', changeOrigin: true },
    },
  },
});
