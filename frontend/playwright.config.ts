import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from '@playwright/test'

/**
 * 端到端配置：启动真实后端与真实 Vite，使用一次性临时数据库。
 *
 * workers 固定为 1：两种浏览器上下文共享同一次服务进程与数据库，
 * 并行执行会让故障注入和端口绑定互相干扰。
 */
const backendDirectory = fileURLToPath(new URL('../backend', import.meta.url))
const pythonExecutable = join(backendDirectory, '.venv', 'Scripts', 'python.exe')

// 刻意避开 8000/8001/5173 这类常用端口：开发机上也常有其他服务占用它们，
// 而端到端测试不应该为此去终止不属于自己的进程。
const BACKEND_PORT = Number(process.env.COLLAB_E2E_BACKEND_PORT ?? 8791)
const FRONTEND_PORT = Number(process.env.COLLAB_E2E_FRONTEND_PORT ?? 5473)

const databasePath = join(mkdtempSync(join(tmpdir(), 'collab-e2e-')), 'collab.db')

/**
 * 受限网络下无法下载官方浏览器时，可用 PLAYWRIGHT_CHROMIUM_PATH 指向本机已有
 * 的 Chromium。默认留空，走 Playwright 标准行为。
 */
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH

export default defineConfig({
  testDir: './e2e',
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
    launchOptions: executablePath === undefined ? {} : { executablePath },
  },
  webServer: [
    {
      command: `"${pythonExecutable}" -m uvicorn app.main:app --app-dir "${backendDirectory}" --host 127.0.0.1 --port ${BACKEND_PORT}`,
      url: `http://127.0.0.1:${BACKEND_PORT}/api/health`,
      env: { COLLAB_DB_PATH: databasePath },
      reuseExistingServer: false,
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 60_000,
    },
    {
      command: `npm run dev -- --host 127.0.0.1 --port ${FRONTEND_PORT}`,
      url: `http://127.0.0.1:${FRONTEND_PORT}`,
      env: { COLLAB_BACKEND_URL: `http://127.0.0.1:${BACKEND_PORT}` },
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
})
