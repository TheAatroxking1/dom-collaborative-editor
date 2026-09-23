import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { WebsocketProvider } from 'y-websocket'
import * as Y from 'yjs'

/**
 * 前端库与真实 Python 服务端的互通验证。
 *
 * 这里刻意不使用 mock 服务：起一个真实的 uvicorn 进程，让 y-websocket 用标准
 * Yjs 二进制协议连上去，再用独立进程中的官方 store 读数据库确认内容真的落盘了。
 * 这是本次重构「先验证锁定版本的库真的能跑」这一步的前端半边。
 */

const backendDirectory = resolve(fileURLToPath(new URL('../../backend', import.meta.url)))
const pythonExecutable = join(backendDirectory, '.venv', 'Scripts', 'python.exe')

const TEST_TIMEOUT_MS = 40_000
const READY_TIMEOUT_MS = 30_000
const SYNC_TIMEOUT_MS = 20_000

let server: ChildProcess | null = null
let dataDirectory = ''
let origin = ''

async function findFreePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer()
    probe.once('error', fail)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      probe.close(() => done(port))
    })
  })
}

async function waitForHealth(deadline: number): Promise<void> {
  for (;;) {
    try {
      const response = await fetch(`${origin}/api/health`)
      if (response.ok) return
    } catch {
      // 进程还没开始监听，继续轮询。
    }
    if (Date.now() > deadline) throw new Error(`后端未在预期时间内就绪：${origin}`)
    await new Promise((settle) => setTimeout(settle, 100))
  }
}

async function createDocument(): Promise<string> {
  const created = await fetch(`${origin}/api/documents`, { method: 'POST' })
  if (created.status !== 201) throw new Error(`创建文档失败：HTTP ${created.status}`)
  return ((await created.json()) as { documentId: string }).documentId
}

function waitForSync(provider: WebsocketProvider, label: string): Promise<void> {
  if (provider.synced) return Promise.resolve()
  return new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`${label} 同步超时`)), SYNC_TIMEOUT_MS)
    provider.on('sync', (state: boolean) => {
      if (!state) return
      clearTimeout(timer)
      done()
    })
  })
}

function paragraphTexts(doc: Y.Doc): string[] {
  return doc
    .getXmlFragment('body')
    .toArray()
    .map((node) =>
      node instanceof Y.XmlElement
        ? node
            .toArray()
            .map((child) => (child instanceof Y.XmlText ? child.toString() : ''))
            .join('')
        : '',
    )
}

function firstParagraph(doc: Y.Doc): Y.XmlElement {
  const node = doc.getXmlFragment('body').get(0)
  if (!(node instanceof Y.XmlElement)) throw new Error('正文首个节点不是段落')
  return node
}

function firstText(doc: Y.Doc): Y.XmlText {
  const node = firstParagraph(doc).get(0)
  if (!(node instanceof Y.XmlText)) throw new Error('段落内首个节点不是文本')
  return node
}

function writeIntoFirstParagraph(doc: Y.Doc, value: string): void {
  const paragraph = firstParagraph(doc)
  let node = paragraph.get(0)
  if (!(node instanceof Y.XmlText)) {
    node = new Y.XmlText()
    paragraph.insert(0, [node])
  }
  node.insert(node.length, value)
}

type Peer = { doc: Y.Doc; provider: WebsocketProvider }

const peers: Peer[] = []

async function connectPeer(documentId: string): Promise<Peer> {
  const doc = new Y.Doc()
  const provider = new WebsocketProvider(
    `${origin.replace('http', 'ws')}/ws/documents`,
    documentId,
    doc,
    // 关闭跨标签页广播：测试必须经过真实 Python 服务端。
    { disableBc: true },
  )
  const peer = { doc, provider }
  peers.push(peer)
  await waitForSync(provider, `peer-${peers.length}`)
  return peer
}

/** 用独立进程里的官方 store 读回正文，证明内容确实落盘。 */
function readStoredText(documentId: string): Promise<string> {
  const script = `
import asyncio, sys
from pathlib import Path
from app.collaboration import read_document_state
from pycrdt import XmlFragment

async def main():
    document = await read_document_state(Path(sys.argv[1]), sys.argv[2])
    fragment = document.get("body", type=XmlFragment)
    print("".join(str(c) for c in fragment.children[0].children))

asyncio.run(main())
`
  return new Promise((done, fail) => {
    const reader = spawn(
      pythonExecutable,
      ['-c', script, join(dataDirectory, 'updates.sqlite3'), documentId],
      { cwd: backendDirectory, env: { ...process.env, PYTHONUTF8: '1' } },
    )
    let out = ''
    let err = ''
    reader.stdout.on('data', (chunk) => (out += chunk))
    reader.stderr.on('data', (chunk) => (err += chunk))
    reader.once('error', fail)
    reader.once('exit', (code) => (code === 0 ? done(out.trim()) : fail(new Error(err))))
  })
}

beforeAll(async () => {
  dataDirectory = mkdtempSync(join(tmpdir(), 'collab-library-'))
  const port = await findFreePort()
  origin = `http://127.0.0.1:${port}`

  server = spawn(
    pythonExecutable,
    [
      '-m',
      'uvicorn',
      'app.main:app',
      '--app-dir',
      backendDirectory,
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
    ],
    {
      cwd: backendDirectory,
      env: { ...process.env, COLLAB_DATA_DIR: dataDirectory, PYTHONUTF8: '1' },
      stdio: 'ignore',
    },
  )

  await waitForHealth(Date.now() + READY_TIMEOUT_MS)
}, TEST_TIMEOUT_MS)

afterAll(async () => {
  for (const peer of peers) {
    peer.provider.destroy()
    peer.doc.destroy()
  }
  peers.length = 0
  if (server !== null) {
    const child = server
    server = null
    child.kill()
    await new Promise((done) => {
      if (child.exitCode !== null || child.signalCode !== null) return done()
      child.once('exit', () => done())
    })
  }
  if (dataDirectory.startsWith(tmpdir())) {
    try {
      rmSync(dataDirectory, { recursive: true, force: true })
    } catch {
      // 刚结束的进程可能还持有数据库文件句柄；临时目录由系统回收，
      // 清理失败不应判定测试失败。
    }
  }
})

describe('y-websocket 与 Python 服务端互通', () => {
  test(
    '客户端连上后拿到服务端的唯一种子段落',
    async () => {
      const documentId = await createDocument()
      const peer = await connectPeer(documentId)

      expect(paragraphTexts(peer.doc)).toEqual([''])
      expect(peer.doc.getXmlFragment('body').length).toBe(1)
    },
    TEST_TIMEOUT_MS,
  )

  test(
    '一端输入中文与 emoji，另一端收到相同内容',
    async () => {
      const documentId = await createDocument()
      const first = await connectPeer(documentId)
      const second = await connectPeer(documentId)

      first.doc.transact(() => writeIntoFirstParagraph(first.doc, '中文English🙂'))

      await expect
        .poll(() => paragraphTexts(second.doc).join(''), { timeout: SYNC_TIMEOUT_MS })
        .toBe('中文English🙂')
      expect(paragraphTexts(first.doc)).toEqual(paragraphTexts(second.doc))
    },
    TEST_TIMEOUT_MS,
  )

  test(
    '同段并发插入后两端收敛且都保留',
    async () => {
      const documentId = await createDocument()
      const first = await connectPeer(documentId)
      const second = await connectPeer(documentId)

      // 两端基于同一基线各自插入，不等待对方。
      first.doc.transact(() => writeIntoFirstParagraph(first.doc, '甲'))
      second.doc.transact(() => writeIntoFirstParagraph(second.doc, '乙'))

      await expect
        .poll(
          () => paragraphTexts(first.doc).join('') === paragraphTexts(second.doc).join(''),
          { timeout: SYNC_TIMEOUT_MS },
        )
        .toBe(true)

      const merged = paragraphTexts(first.doc).join('')
      expect(merged).toContain('甲')
      expect(merged).toContain('乙')
    },
    TEST_TIMEOUT_MS,
  )

  test(
    '一端删除后另一端看到删除结果',
    async () => {
      const documentId = await createDocument()
      const first = await connectPeer(documentId)
      const second = await connectPeer(documentId)

      first.doc.transact(() => writeIntoFirstParagraph(first.doc, 'abcdef'))
      await expect
        .poll(() => paragraphTexts(second.doc).join(''), { timeout: SYNC_TIMEOUT_MS })
        .toBe('abcdef')

      second.doc.transact(() => firstText(second.doc).delete(0, 2))

      await expect
        .poll(() => paragraphTexts(first.doc).join(''), { timeout: SYNC_TIMEOUT_MS })
        .toBe('cdef')
    },
    TEST_TIMEOUT_MS,
  )

  test(
    '内容通过库的存储落盘，可用独立进程读回',
    async () => {
      const documentId = await createDocument()
      const peer = await connectPeer(documentId)

      peer.doc.transact(() => writeIntoFirstParagraph(peer.doc, '库能读回来'))
      await expect
        .poll(() => readStoredText(documentId), { timeout: SYNC_TIMEOUT_MS })
        .toBe('库能读回来')
    },
    TEST_TIMEOUT_MS,
  )

  test(
    '不存在的文档会被服务端拒绝',
    async () => {
      const missing = '00000000-0000-4000-8000-000000000000'
      const doc = new Y.Doc()
      const provider = new WebsocketProvider(
        `${origin.replace('http', 'ws')}/ws/documents`,
        missing,
        doc,
        { disableBc: true },
      )
      peers.push({ doc, provider })

      const code = await new Promise<number>((done, fail) => {
        const timer = setTimeout(() => fail(new Error('没有收到关闭事件')), SYNC_TIMEOUT_MS)
        provider.on('closed', (event: { code: number }) => {
          clearTimeout(timer)
          done(event.code)
        })
      })
      expect(code).toBe(4404)
    },
    TEST_TIMEOUT_MS,
  )
})
