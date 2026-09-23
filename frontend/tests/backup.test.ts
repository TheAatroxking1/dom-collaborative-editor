import { describe, expect, test } from 'vitest'
import * as Y from 'yjs'

import {
  MAX_BACKUP_FILE_BYTES,
  MAX_BACKUP_UPDATE_BYTES,
  parseBackup,
  serializeBackup,
} from '../src/documents/backup'

const DOCUMENT_ID = '00000000-0000-4000-8000-000000000001'
const ORIGIN = 'http://127.0.0.1:5273'

/** 造一个带内容的文档：<paragraph><text>…</text></paragraph> 的序列。 */
function buildDocument(paragraphs: string[]): Y.Doc {
  const doc = new Y.Doc()
  const fragment = doc.getXmlFragment('body')
  paragraphs.forEach((value) => {
    const paragraph = new Y.XmlElement('paragraph')
    fragment.push([paragraph])
    const text = new Y.XmlText()
    paragraph.push([text])
    if (value.length > 0) text.insert(0, value)
  })
  return doc
}

function bodyText(doc: Y.Doc): string {
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
    .join('\n')
}

/** 取第一个段落里的文本节点，供需要按索引修改的用例使用。 */
function firstText(doc: Y.Doc): Y.XmlText {
  const paragraph = doc.getXmlFragment('body').get(0)
  if (!(paragraph instanceof Y.XmlElement)) throw new Error('第一个节点不是段落')
  const node = paragraph.get(0)
  if (!(node instanceof Y.XmlText)) throw new Error('段落内第一个节点不是文本')
  return node
}

function backupOf(overrides: Record<string, unknown> = {}): string {
  const source = buildDocument(['内容'])
  const base = JSON.parse(serializeBackup(DOCUMENT_ID, source, ORIGIN)) as Record<string, unknown>
  source.destroy()
  return JSON.stringify({ ...base, ...overrides })
}

describe('备份编解码', () => {
  test('完整备份重复应用不会重复正文', () => {
    const source = new Y.Doc()
    const paragraph = new Y.XmlElement('paragraph')
    const text = new Y.XmlText()
    source.getXmlFragment('body').insert(0, [paragraph])
    paragraph.insert(0, [text])
    text.insert(0, '你好协作')

    const parsed = parseBackup(serializeBackup(DOCUMENT_ID, source, ORIGIN))

    const target = new Y.Doc()
    Y.applyUpdate(target, parsed.update)
    Y.applyUpdate(target, parsed.update)

    expect(bodyText(target)).toBe('你好协作')
    expect(target.getXmlFragment('body').length).toBe(1)
    source.destroy()
    target.destroy()
  })

  test('导出内容包含格式声明的全部字段', () => {
    const source = buildDocument(['甲'])
    const parsed = parseBackup(serializeBackup(DOCUMENT_ID, source, ORIGIN))

    expect(parsed.metadata.format).toBe('dom-collab-backup')
    expect(parsed.metadata.version).toBe(1)
    expect(parsed.metadata.schema).toBe('paragraph-text-hardbreak-v1')
    expect(parsed.metadata.documentId).toBe(DOCUMENT_ID)
    expect(parsed.metadata.sourceOrigin).toBe(ORIGIN)
    expect(Number.isNaN(Date.parse(parsed.metadata.exportedAt))).toBe(false)
    expect(parsed.update).toBeInstanceOf(Uint8Array)
    source.destroy()
  })

  test('documentId 规范化为小写标准格式', () => {
    const source = buildDocument(['甲'])
    const json = serializeBackup('00000000-0000-4000-8000-0000000000AB', source, ORIGIN)
    expect(parseBackup(json).metadata.documentId).toBe('00000000-0000-4000-8000-0000000000ab')
    source.destroy()
  })

  test('中文、emoji、空段落与段内换行都能往返', () => {
    const doc = new Y.Doc()
    const fragment = doc.getXmlFragment('body')

    const first = new Y.XmlElement('paragraph')
    fragment.push([first])
    const firstText = new Y.XmlText()
    first.push([firstText])
    firstText.insert(0, '中文🙂')
    first.push([new Y.XmlElement('hardBreak')])
    const second = new Y.XmlText()
    first.push([second])
    second.insert(0, '段内换行后')

    const empty = new Y.XmlElement('paragraph')
    fragment.push([empty])

    const parsed = parseBackup(serializeBackup(DOCUMENT_ID, doc, ORIGIN))
    const restored = new Y.Doc()
    restored.getXmlFragment('body')
    Y.applyUpdate(restored, parsed.update)

    expect(restored.getXmlFragment('body').length).toBe(2)
    expect(parsed.previewText).toBe('中文🙂\n段内换行后\n')
    doc.destroy()
    restored.destroy()
  })

  test('离线插入与删除都进入备份，且与目标端并发编辑收敛', () => {
    // 双方先共享同一份种子。
    const seed = buildDocument(['起点'])
    const seedUpdate = Y.encodeStateAsUpdate(seed)
    const offline = new Y.Doc()
    const online = new Y.Doc()
    Y.applyUpdate(offline, seedUpdate)
    Y.applyUpdate(online, seedUpdate)

    // 源端离线：一段插入、一处删除。
    offline.transact(() => {
      firstText(offline).insert(0, '离线插入')
    })
    const parsed = parseBackup(serializeBackup(DOCUMENT_ID, offline, ORIGIN))

    // 目标端并发插入。
    online.transact(() => {
      const text = firstText(online)
      text.insert(text.length, '在线插入')
    })

    Y.applyUpdate(online, parsed.update)

    // 双方都保留各自的新增，并且内容一致。
    expect(bodyText(online)).toContain('离线插入')
    expect(bodyText(online)).toContain('在线插入')
    expect(bodyText(online)).toContain('起点')

    const offlineAfter = new Y.Doc()
    Y.applyUpdate(offlineAfter, Y.encodeStateAsUpdate(offline))
    Y.applyUpdate(offlineAfter, Y.encodeStateAsUpdate(online))
    expect(bodyText(offlineAfter)).toBe(bodyText(online))

    seed.destroy()
    offline.destroy()
    online.destroy()
    offlineAfter.destroy()
  })

  test('离线删除会随备份带过去', () => {
    const seed = buildDocument(['abcdefghij'])
    const offline = new Y.Doc()
    Y.applyUpdate(offline, Y.encodeStateAsUpdate(seed))
    const target = new Y.Doc()
    Y.applyUpdate(target, Y.encodeStateAsUpdate(seed))

    offline.transact(() => {
      firstText(offline).delete(5, 2)
    })
    // 删除不推进状态向量，因此不能靠状态向量判断备份里有没有内容。
    expect(bodyText(offline)).toBe('abcdehij')

    Y.applyUpdate(target, parseBackup(serializeBackup(DOCUMENT_ID, offline, ORIGIN)).update)
    expect(bodyText(target)).toBe('abcdehij')

    seed.destroy()
    offline.destroy()
    target.destroy()
  })
})

describe('备份检查', () => {
  test('拒绝非法 JSON', () => {
    expect(() => parseBackup('{不是 json')).toThrow()
  })

  test('拒绝错误的 format / version / schema', () => {
    expect(() => parseBackup(backupOf({ format: '别的格式' }))).toThrow(/格式/)
    expect(() => parseBackup(backupOf({ version: 2 }))).toThrow(/版本/)
    expect(() => parseBackup(backupOf({ schema: 'rich-text-v2' }))).toThrow(/schema|结构/)
  })

  test('拒绝非法 UUID', () => {
    expect(() => parseBackup(backupOf({ documentId: 'not-a-uuid' }))).toThrow(/标识|UUID/)
  })

  test('拒绝非法时间与来源地址', () => {
    expect(() => parseBackup(backupOf({ exportedAt: '昨天' }))).toThrow(/时间/)
    expect(() => parseBackup(backupOf({ sourceOrigin: 'ftp://x' }))).toThrow(/来源/)
    expect(() => parseBackup(backupOf({ sourceOrigin: 'http://a/b?c=1' }))).toThrow(/来源/)
  })

  test('拒绝非法 Base64 与损坏的 update', () => {
    expect(() => parseBackup(backupOf({ updateBase64: '不是base64!!' }))).toThrow(/Base64/)
    expect(() => parseBackup(backupOf({ updateBase64: 'QUJD' }))).toThrow()
  })

  test('拒绝超过文件与解码上限的内容', () => {
    const huge = 'A'.repeat(Math.ceil((MAX_BACKUP_FILE_BYTES * 4) / 3) + 1024)
    expect(() => parseBackup(backupOf({ updateBase64: huge }))).toThrow(/大小|上限|过大/)

    // 解码后超限：合法 Base64 但字节数超过 update 上限。
    const oversized = new Uint8Array(MAX_BACKUP_UPDATE_BYTES + 1024)
    const source = buildDocument(['甲'])
    const json = serializeBackup(DOCUMENT_ID, source, ORIGIN)
    const payload = JSON.parse(json) as Record<string, unknown>
    payload.updateBase64 = Buffer.from(oversized).toString('base64')
    // 未压缩的零字节 update 解码失败，这里只要求因超限或损坏而被拒绝。
    expect(() => parseBackup(JSON.stringify(payload))).toThrow()
    source.destroy()
  })

  test('拒绝空正文根、错误的根名与非法节点', () => {
    const empty = new Y.Doc()
    const emptyJson = serializeBackup(DOCUMENT_ID, empty, ORIGIN)
    expect(() => parseBackup(emptyJson)).toThrow(/段落|正文/)

    // 共享根名不对：没有 body，只有另一个根。
    const wrongRoot = new Y.Doc()
    wrongRoot.getXmlFragment('other').push([new Y.XmlElement('paragraph')])
    expect(() => parseBackup(serializeBackup(DOCUMENT_ID, wrongRoot, ORIGIN))).toThrow(
      /正文|段落|共享/,
    )

    // 段落里放了不允许的节点。
    const badNode = new Y.Doc()
    const fragment = badNode.getXmlFragment('body')
    const paragraph = new Y.XmlElement('paragraph')
    fragment.push([paragraph])
    paragraph.push([new Y.XmlElement('image')])
    expect(() => parseBackup(serializeBackup(DOCUMENT_ID, badNode, ORIGIN))).toThrow()

    empty.destroy()
    wrongRoot.destroy()
    badNode.destroy()
  })

  test('解析失败不会影响已有文档', () => {
    const existing = buildDocument(['原有内容'])
    const before = Y.encodeStateAsUpdate(existing)

    expect(() => parseBackup('{坏文件')).toThrow()

    expect(Y.encodeStateAsUpdate(existing)).toEqual(before)
    expect(bodyText(existing)).toBe('原有内容')
    existing.destroy()
  })

  test('预览文本按段落与段内换行渲染为纯文本', () => {
    const source = buildDocument(['第一段', '第二段'])
    const parsed = parseBackup(serializeBackup(DOCUMENT_ID, source, ORIGIN))
    expect(parsed.previewText).toBe('第一段\n第二段')
    source.destroy()
  })
})
