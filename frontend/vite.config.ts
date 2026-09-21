import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// 默认端口刻意避开 5173 与 8000：这两个端口在开发机上经常被其他项目或
// Docker 占用，本项目不应该和它们抢。需要时用环境变量或 --port 覆盖。
const backendTarget = process.env.COLLAB_BACKEND_URL ?? 'http://127.0.0.1:8787'
const devPort = Number(process.env.COLLAB_DEV_PORT ?? 5273)

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    host: '127.0.0.1',
    port: devPort,
    strictPort: true,
    proxy: {
      '/api': { target: backendTarget, changeOrigin: true },
      '/ws': { target: backendTarget, ws: true, changeOrigin: true },
    },
  },
})
