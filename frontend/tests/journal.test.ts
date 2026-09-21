import 'fake-indexeddb/auto'
import * as Y from 'yjs'
import { afterEach, describe, expect, test } from 'vitest'
import {
  RESTORE_ORIGIN,
  completed,
  openJournal,
  type Journal,
} from '../src/collab/journal'

const open: Journal[] = []

afterEach(() => {
  while (open.length > 0) open.pop()?.close()
})

async function freshJournal(): Promise<Journal> {
  // 每个用例使用独立数据库，避免残留状态掩盖隔离缺陷。
  const journal = await openJournal(crypto.randomUUID())
  open.push(journal)
  return journal
}

/** 造一个只含 Y.Text 的更新，内容可以是中文与 emoji。 */
function updateWith(text: string): { doc: Y.Doc; update: Uint8Array } {
  const doc = new Y.Doc()
  doc.getText('probe').insert(0, text)
  return { doc, update: Y.encodeStateAsUpdate(doc) }
}

describe('本地日志', () => {
  test('确认后清空待发送状态但保留恢复数据', async () => {
    const journal = await freshJournal()
    const source = new Y.Doc()
    source.getText('probe').insert(0, '恢复中文🙂')
    const tx = await journal.appendLocal('doc-a', Y.encodeStateAsUpdate(source))
    await journal.acknowledge('doc-a', tx.txId)
    expect(await journal.pending('doc-a')).toEqual([])
    const restored = new Y.Doc()
    await journal.restore('doc-a', restored)
    expect(restored.getText('probe').toString()).toBe('恢复中文🙂')
  })

  test('未确认记录在重新打开后 txId 与字节完全相同', async () => {
    const name = crypto.randomUUID()
    const first = await openJournal(name)
    const { update } = updateWith('离线内容')
    const tx = await first.appendLocal('doc-a', update)
    first.close()

    const second = await openJournal(name)
    open.push(second)
    const pending = await second.pending('doc-a')
    expect(pending).toHaveLength(1)
    expect(pending[0]?.txId).toBe(tx.txId)
    expect(Array.from(pending[0]?.update ?? [])).toEqual(Array.from(update))
    expect(pending[0]?.kind).toBe('edit')
  })

  test('补同步事务与普通编辑事务可区分', async () => {
    const journal = await freshJournal()
    const { update } = updateWith('差量')
    const edit = await journal.appendLocal('doc-a', update, 'edit')
    const catchup = await journal.appendLocal('doc-a', update, 'catchup')
    const pending = await journal.pending('doc-a')
    expect(pending.map((entry) => entry.kind)).toEqual(['edit', 'catchup'])
    expect(pending.map((entry) => entry.txId)).toEqual([edit.txId, catchup.txId])
  })

  test('待发送记录按数据库分配的顺序返回', async () => {
    const journal = await freshJournal()
    const txIds: string[] = []
    for (const text of ['一', '二', '三']) {
      const { update } = updateWith(text)
      txIds.push((await journal.appendLocal('doc-a', update)).txId)
    }
    const pending = await journal.pending('doc-a')
    expect(pending.map((entry) => entry.txId)).toEqual(txIds)
    expect(pending.map((entry) => entry.order)).toEqual(
      [...pending.map((entry) => entry.order)].sort((left, right) => left - right),
    )
  })

  test('远端更新不进入待发送队列，但仍然可恢复', async () => {
    const journal = await freshJournal()
    const { update } = updateWith('来自对端')
    await journal.appendRemote('doc-a', update)
    expect(await journal.pending('doc-a')).toEqual([])
    const restored = new Y.Doc()
    await journal.restore('doc-a', restored)
    expect(restored.getText('probe').toString()).toBe('来自对端')
  })

  test('确认未知 txId 不影响其他记录', async () => {
    const journal = await freshJournal()
    const { update } = updateWith('保留')
    const tx = await journal.appendLocal('doc-a', update)
    await journal.acknowledge('doc-a', crypto.randomUUID())
    expect((await journal.pending('doc-a')).map((entry) => entry.txId)).toEqual([tx.txId])
  })

  test('确认只作用于同一文档的同一事务', async () => {
    const journal = await freshJournal()
    const { update } = updateWith('同标识')
    const first = await journal.appendLocal('doc-a', update)
    const second = await journal.appendLocal('doc-b', update)
    // 两个文档各自持有独立记录，确认其中一个不影响另一个。
    expect(first.txId).not.toBe(second.txId)
    await journal.acknowledge('doc-a', first.txId)
    expect(await journal.pending('doc-a')).toEqual([])
    expect((await journal.pending('doc-b')).map((entry) => entry.txId)).toEqual([second.txId])
  })

  test('不同文档恢复时互不串内容', async () => {
    const journal = await freshJournal()
    await journal.appendLocal('doc-a', updateWith('甲文档').update)
    await journal.appendLocal('doc-b', updateWith('乙文档').update)

    const left = new Y.Doc()
    const right = new Y.Doc()
    await journal.restore('doc-a', left)
    await journal.restore('doc-b', right)
    expect(left.getText('probe').toString()).toBe('甲文档')
    expect(right.getText('probe').toString()).toBe('乙文档')

    const empty = new Y.Doc()
    await journal.restore('doc-c', empty)
    expect(empty.getText('probe').toString()).toBe('')
  })

  test('恢复重放使用 RESTORE_ORIGIN 作为来源', async () => {
    const journal = await freshJournal()
    await journal.appendLocal('doc-a', updateWith('来源').update)

    const doc = new Y.Doc()
    const origins: unknown[] = []
    doc.on('update', (_update: Uint8Array, origin: unknown) => {
      origins.push(origin)
    })
    await journal.restore('doc-a', doc)
    expect(origins).toEqual([RESTORE_ORIGIN])
  })

  test('恢复的记录不会因为重放而产生新的待发送事务', async () => {
    const journal = await freshJournal()
    await journal.appendRemote('doc-a', updateWith('服务端内容').update)

    const doc = new Y.Doc()
    await journal.restore('doc-a', doc)
    expect(await journal.pending('doc-a')).toEqual([])
  })

  test('同一文档的多个活动副本身份不同', async () => {
    const journal = await freshJournal()
    await journal.appendLocal('doc-a', updateWith('共享').update)

    const first = new Y.Doc()
    const second = new Y.Doc()
    await journal.restore('doc-a', first)
    await journal.restore('doc-a', second)
    expect(first.clientID).not.toBe(second.clientID)
    expect(first.getText('probe').toString()).toBe('共享')
    expect(second.getText('probe').toString()).toBe('共享')
  })

  test('同一个 Y.Doc 重复恢复不会重复应用内容', async () => {
    const journal = await freshJournal()
    const { update } = updateWith('幂等恢复')
    await journal.appendLocal('doc-a', update)

    const doc = new Y.Doc()
    await journal.restore('doc-a', doc)
    await journal.restore('doc-a', doc)
    expect(doc.getText('probe').toString()).toBe('幂等恢复')
  })

  test('写入的字节是副本，调用方之后复用缓冲区不会影响日志', async () => {
    const journal = await freshJournal()
    const buffer = new Uint8Array(updateWith('副本').update)
    const tx = await journal.appendLocal('doc-a', buffer)
    buffer.fill(0)

    const pending = await journal.pending('doc-a')
    expect(pending[0]?.txId).toBe(tx.txId)
    expect(pending[0]?.update.byteLength).toBeGreaterThan(1)
    expect(Array.from(pending[0]?.update ?? [])).not.toEqual(Array.from(buffer))
  })

  test('数据库关闭后写入失败会抛出，而不是假装保存成功', async () => {
    const journal = await freshJournal()
    journal.close()
    await expect(journal.appendLocal('doc-a', updateWith('失败').update)).rejects.toThrow()
  })

  test('事务中止时 completed 拒绝', async () => {
    const journal = await freshJournal()
    const request = indexedDB.open(crypto.randomUUID(), 1)
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      request.addEventListener('upgradeneeded', () => {
        request.result.createObjectStore('updates', {
          keyPath: 'order',
          autoIncrement: true,
        })
      })
      request.addEventListener('success', () => resolve(request.result), { once: true })
      request.addEventListener('error', () => reject(request.error), { once: true })
    })
    try {
      const transaction = database.transaction('updates', 'readwrite')
      const done = completed(transaction)
      transaction.abort()
      await expect(done).rejects.toThrow()
    } finally {
      database.close()
      journal.close()
    }
  })
})
