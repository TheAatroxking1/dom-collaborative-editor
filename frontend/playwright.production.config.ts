import { defineConfig } from '@playwright/test'

/**
 * 生产构建版的端到端配置。
 *
 * 与开发版套件分开的原因：
 * - 页面由真实 Python 进程提供（构建产物 + Service Worker），不经过 Vite dev；
 * - 必须允许 Service Worker 生效，否则证明不了离线刷新；
 * - 端口独立（5483），不与开发/构建运行端口冲突。
 *
 * 前置条件：先执行 npm --prefix frontend run build。
 */

const FRONTEND_PORT = Number(process.env.COLLAB_E2E_PRODUCTION_PORT ?? 5483)

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH

export default defineConfig({
  testDir: './e2e-production',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${FRONTEND_PORT}`,
    trace: 'retain-on-failure',
    permissions: ['clipboard-read', 'clipboard-write'],
    serviceWorkers: 'allow',
    launchOptions: executablePath === undefined ? {} : { executablePath },
  },
  // 服务由夹具按测试启动（需要临时数据目录与临时静态目录），这里不配 webServer。
})
