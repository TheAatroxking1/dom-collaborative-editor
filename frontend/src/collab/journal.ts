import { applyUpdate } from 'yjs'
import type * as Y from 'yjs'

/**
 * 浏览器端统一更新日志。
 *
 * 所有会影响文档内容的更新都会先落到这里，再考虑发送：本地输入、服务端广播
 * 和恢复重放共用一张表，用 source 区分来源。这样“刷新后能恢复”依赖的是同一
 * 份数据，而不是多条并行且互相竞速的持久化路径。
 *
 * 记录顺序由 IndexedDB 分配的自增主键决定，不能使用 Date.now 或内存计数器：
 * 同源标签页共享一个数据库，只有数据库分配的顺序才是全局一致的。
 */

export type JournalRecord = {
  documentId: string
  order: number
  source: 'local' | 'remote' | 'catchup'
  update: Uint8Array
  txId: string | null
  acknowledged: boolean
}

export type PendingTx = Pick<JournalRecord, 'order' | 'update'> & {
  txId: string
  kind: 'edit' | 'catchup'
}

export interface Journal {
  restore(documentId: string, doc: Y.Doc): Promise<void>
  appendLocal(
    documentId: string,
    update: Uint8Array,
    kind?: 'edit' | 'catchup',
  ): Promise<PendingTx>
  appendRemote(documentId: string, update: Uint8Array): Promise<void>
  pending(documentId: string): Promise<PendingTx[]>
  acknowledge(documentId: string, txId: string): Promise<void>
  close(): void
}

/** 恢复重放的 origin：既不是本地新输入，也不是对端广播。 */
export const RESTORE_ORIGIN = Symbol('restore')
/** 服务端广播的 origin。 */
export const REMOTE_ORIGIN = Symbol('remote')

export const DEFAULT_DATABASE_NAME = 'dom-collab-v1'

const STORE = 'updates'
const BY_DOCUMENT = 'by-document'
const BY_TRANSACTION = 'by-transaction'
const DATABASE_VERSION = 1

/** 数据库升级或删除记录时使用的内部形状；order 交给自增主键分配。 */
type StoredRecord = Omit<JournalRecord, 'order'> & { order?: number }

/**
 * 等待整个事务完成。
 *
 * 单个请求的 success 只说明那一条请求完成，不代表事务已提交；必须等到
 * complete 才能对外声称“已保存到本地”。监听器要在发出请求之前注册。
 */
export function completed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener('complete', () => resolve(), { once: true })
    transaction.addEventListener(
      'abort',
      () => reject(transaction.error ?? new Error('IndexedDB 事务被中止')),
      { once: true },
    )
    transaction.addEventListener(
      'error',
      () => reject(transaction.error ?? new Error('IndexedDB 事务失败')),
      { once: true },
    )
  })
}

function fromRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener('success', () => resolve(request.result), { once: true })
    request.addEventListener(
      'error',
      () => reject(request.error ?? new Error('IndexedDB 请求失败')),
      { once: true },
    )
  })
}

/** 复制字节，避免把调用方后续会复用的缓冲区直接存进数据库。 */
function copyBytes(update: Uint8Array): Uint8Array {
  const copy = new Uint8Array(update.byteLength)
  copy.set(update)
  return copy
}

function toPending(record: StoredRecord): PendingTx | null {
  if (record.txId === null || record.acknowledged || record.order === undefined) return null
  return {
    order: record.order,
    update: record.update,
    txId: record.txId,
    kind: record.source === 'catchup' ? 'catchup' : 'edit',
  }
}

export async function openJournal(
  name: string = DEFAULT_DATABASE_NAME,
): Promise<Journal> {
  const database = await openDatabase(name)
  return new IndexedDbJournal(database)
}

function openDatabase(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, DATABASE_VERSION)

    request.addEventListener('upgradeneeded', () => {
      const database = request.result
      const store = database.createObjectStore(STORE, {
        keyPath: 'order',
        autoIncrement: true,
      })
      store.createIndex(BY_DOCUMENT, 'documentId', { unique: false })
      // remote 记录的 txId 为 null，不是合法的 IndexedDB 键，
      // 因此不会进入这个唯一索引，也不会污染待确认队列。
      store.createIndex(BY_TRANSACTION, ['documentId', 'txId'], { unique: true })
    })

    request.addEventListener('success', () => resolve(request.result), { once: true })
    request.addEventListener(
      'error',
      () => reject(request.error ?? new Error('无法打开本地数据库')),
      { once: true },
    )
    // 另一个标签页正持有旧版本连接时不能无限等待，要让上层显示恢复失败与重试。
    request.addEventListener('blocked', () =>
      reject(new Error('本地数据库被其他标签页占用，无法升级')),
    )
  })
}

class IndexedDbJournal implements Journal {
  constructor(private readonly database: IDBDatabase) {}

  async restore(documentId: string, doc: Y.Doc): Promise<void> {
    const transaction = this.database.transaction(STORE, 'readonly')
    const done = completed(transaction)
    const index = transaction.objectStore(STORE).index(BY_DOCUMENT)

    // 先按主键顺序收集，再在事务结束后重放：这样不会在游标回调里
    // 长时间持有事务，也不会因为应用更新抛错而留下半开的事务。
    const collected: Uint8Array[] = []
    await new Promise<void>((resolve, reject) => {
      const cursorRequest = index.openCursor(IDBKeyRange.only(documentId))
      cursorRequest.addEventListener('success', () => {
        const cursor = cursorRequest.result
        if (cursor === null) {
          resolve()
          return
        }
        const record = cursor.value as StoredRecord
        collected.push(record.update)
        cursor.continue()
      })
      cursorRequest.addEventListener(
        'error',
        () => reject(cursorRequest.error ?? new Error('读取本地日志失败')),
        { once: true },
      )
    })
    await done

    for (const update of collected) {
      applyUpdate(doc, update, RESTORE_ORIGIN)
    }
  }

  async appendLocal(
    documentId: string,
    update: Uint8Array,
    kind: 'edit' | 'catchup' = 'edit',
  ): Promise<PendingTx> {
    // txId 与这条日志一起持久化，因此重连或刷新后重试仍复用同一个标识。
    const txId = crypto.randomUUID()
    const record: StoredRecord = {
      documentId,
      source: kind === 'catchup' ? 'catchup' : 'local',
      update: copyBytes(update),
      txId,
      acknowledged: false,
    }
    const order = await this.insert(record)
    return { order, update: copyBytes(update), txId, kind }
  }

  async appendRemote(documentId: string, update: Uint8Array): Promise<void> {
    await this.insert({
      documentId,
      source: 'remote',
      update: copyBytes(update),
      txId: null,
      acknowledged: true,
    })
  }

  async pending(documentId: string): Promise<PendingTx[]> {
    const transaction = this.database.transaction(STORE, 'readonly')
    const done = completed(transaction)
    const index = transaction.objectStore(STORE).index(BY_DOCUMENT)
    const records = (await fromRequest(
      index.getAll(IDBKeyRange.only(documentId)),
    )) as StoredRecord[]
    await done

    return records
      .map(toPending)
      .filter((entry): entry is PendingTx => entry !== null)
      .sort((left, right) => left.order - right.order)
  }

  async acknowledge(documentId: string, txId: string): Promise<void> {
    const transaction = this.database.transaction(STORE, 'readwrite')
    const done = completed(transaction)
    const store = transaction.objectStore(STORE)
    const record = (await fromRequest(
      store.index(BY_TRANSACTION).get([documentId, txId]),
    )) as StoredRecord | undefined

    // 未知 txId 不做任何事：确认只按标识更新状态，不删除原始更新，
    // 也不影响其他待确认记录。
    if (record !== undefined) {
      store.put({ ...record, acknowledged: true })
    }
    await done
  }

  close(): void {
    this.database.close()
  }

  private async insert(record: StoredRecord): Promise<number> {
    const transaction = this.database.transaction(STORE, 'readwrite')
    const done = completed(transaction)
    const order = await fromRequest(transaction.objectStore(STORE).add(record))
    await done
    return Number(order)
  }
}
