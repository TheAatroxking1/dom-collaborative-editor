import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { VitePWA } from 'vite-plugin-pwa'

// 默认端口刻意避开 5173 与 8000：这两个端口在开发机上经常被其他项目或
// Docker 占用，本项目不应该和它们抢。需要时用环境变量或 --port 覆盖。
const backendTarget = process.env.COLLAB_BACKEND_URL ?? 'http://127.0.0.1:8787'
const devPort = Number(process.env.COLLAB_DEV_PORT ?? 5273)

export default defineConfig({
  plugins: [
    vue(),
    /**
     * 只缓存页面外壳，不缓存任何正文数据。
     *
     * 正文继续由 y-indexeddb 与 y-websocket 负责；这里预缓存的是构建产物本身，
     * 目的是让「整站断网后刷新」还能打开页面。API 与 WebSocket 一律不进缓存
     * （runtimeCaching 为空），否则离线时会拿到过期的接口响应或伪装的连接成功。
     */
    VitePWA({
      strategies: 'generateSW',
      // prompt 模式：诊断到新版本时只提示，不自动刷新，不打断正在编辑的人。
      registerType: 'prompt',
      // 由 src/offline.ts 手动注册，避免注入脚本在开发模式也生效。
      injectRegister: false,
      // 本轮不做「安装到桌面」，不生成 manifest 与图标。
      manifest: false,
      // 开发模式不注册 SW：生产 SW 会接管同源下的所有页面，包括开发页面。
      devOptions: { enabled: false },
      workbox: {
        globPatterns: ['**/*.{html,js,css,svg,png,ico,woff2}'],
        // 只允许根路径与 index.html（含查询参数）回退到页面外壳。
        // 其余路径——包括 /api/*、/ws/*、缺失资源——保持原样失败。
        navigateFallback: 'index.html',
        navigateFallbackAllowlist: [/^\/(?:index\.html)?(?:\?.*)?$/],
        runtimeCaching: [],
        cleanupOutdatedCaches: true,
        // 不自动接管：新版本要等用户关闭全部页面后重新打开才生效。
        skipWaiting: false,
        clientsClaim: true,
      },
    }),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    host: '0.0.0.0',
    port: devPort,
    strictPort: true,
    proxy: {
      '/api': { target: backendTarget, changeOrigin: true },
      '/ws': { target: backendTarget, ws: true, changeOrigin: true },
    },
  },
})
