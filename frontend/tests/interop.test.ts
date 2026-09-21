import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import * as Y from 'yjs'
import { describe, expect, test } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const backendDir = resolve(here, '../../backend')
const pythonExe = resolve(backendDir, '.venv/Scripts/python.exe')

const TEXT_SAMPLE = 'Hello中文🙂'

/**
 * 通过真实 Python 进程往返一组更新。
 *
 * 这里刻意不模拟 Python 侧行为：测试必须证明 Node 与 pycrdt 之间的二进制编码
 * 真正互通，而不是两个内存副本自说自话。
 */
function roundTrip(updates: Uint8Array[]): { update: Uint8Array; stateVector: Uint8Array } {
  const result = spawnSync(pythonExe, ['-m', 'tests.interop_bridge'], {
    cwd: backendDir,
    encoding: 'utf8',
    input: JSON.stringify({
      updates: updates.map((value) => Buffer.from(value).toString('base64')),
    }),
    timeout: 10000,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`interop bridge failed (status ${result.status}): ${result.stderr}`)
  }
  const parsed = JSON.parse(result.stdout) as { update: string; stateVector: string }
  return {
    update: Uint8Array.from(Buffer.from(parsed.update, 'base64')),
    stateVector: Uint8Array.from(Buffer.from(parsed.stateVector, 'base64')),
  }
}

/** 取正文第一个段落元素。 */
function firstParagraph(fragment: Y.XmlFragment): Y.XmlElement {
  const node = fragment.get(0)
  if (!(node instanceof Y.XmlElement)) throw new Error('正文首个节点不是段落元素')
  return node
}

/** 取段落内的文本节点；正文段落只使用单一 XmlText，便于按索引编辑。 */
function paragraphXmlText(fragment: Y.XmlFragment): Y.XmlText {
  const node = firstParagraph(fragment).get(0)
  if (!(node instanceof Y.XmlText)) throw new Error('段落内首个节点不是文本')
  return node
}

/** 用 XML 正文结构写入一段文字，返回承载文字的 Y.XmlText。 */
function writeParagraph(fragment: Y.XmlFragment, text: string): Y.XmlText {
  const paragraph = new Y.XmlElement('paragraph')
  fragment.push([paragraph])
  const xmlText = new Y.XmlText()
  paragraph.push([xmlText])
  xmlText.insert(0, text)
  return xmlText
}

function paragraphText(fragment: Y.XmlFragment): string {
  return fragment
    .toArray()
    .map((node) => {
      if (!(node instanceof Y.XmlElement)) return ''
      const inner = node.get(0)
      return inner instanceof Y.XmlText ? inner.toString() : ''
    })
    .join('\n')
}

describe('Yjs 与 pycrdt 二进制互通', () => {
  test('XML 正文结构经 Python 往返后保持一致', () => {
    const source = new Y.Doc()
    writeParagraph(source.getXmlFragment('body'), TEXT_SAMPLE)

    const { update } = roundTrip([Y.encodeStateAsUpdate(source)])
    const restored = new Y.Doc()
    Y.applyUpdate(restored, update)

    const root = restored.getXmlFragment('body')
    expect(root.length).toBe(1)
    expect(firstParagraph(root).nodeName).toBe('paragraph')
    expect(paragraphText(root)).toBe(TEXT_SAMPLE)
  })

  test('重复应用同一更新是幂等的', () => {
    const source = new Y.Doc()
    writeParagraph(source.getXmlFragment('body'), TEXT_SAMPLE)
    const full = Y.encodeStateAsUpdate(source)

    const { update } = roundTrip([full])
    const restored = new Y.Doc()
    Y.applyUpdate(restored, update)
    Y.applyUpdate(restored, update)
    Y.applyUpdate(restored, update)

    expect(restored.getXmlFragment('body').length).toBe(1)
    expect(paragraphText(restored.getXmlFragment('body'))).toBe(TEXT_SAMPLE)
  })

  test('相同基线上的并发插入经 Python 后无论顺序都收敛', () => {
    const base = new Y.Doc()
    writeParagraph(base.getXmlFragment('body'), 'AB')

    const left = new Y.Doc()
    const right = new Y.Doc()
    Y.applyUpdate(left, Y.encodeStateAsUpdate(base))
    Y.applyUpdate(right, Y.encodeStateAsUpdate(base))

    paragraphXmlText(left.getXmlFragment('body')).insert(1, '左')
    paragraphXmlText(right.getXmlFragment('body')).insert(1, '右')

    const leftViaPython = roundTrip([Y.encodeStateAsUpdate(left)]).update
    const rightViaPython = roundTrip([Y.encodeStateAsUpdate(right)]).update

    const forward = new Y.Doc()
    Y.applyUpdate(forward, leftViaPython)
    Y.applyUpdate(forward, rightViaPython)

    const backward = new Y.Doc()
    Y.applyUpdate(backward, rightViaPython)
    Y.applyUpdate(backward, leftViaPython)

    const forwardText = paragraphText(forward.getXmlFragment('body'))
    const backwardText = paragraphText(backward.getXmlFragment('body'))

    // 双方新增都保留，且与投递顺序无关。
    expect(forwardText).toBe(backwardText)
    expect(forwardText).toContain('左')
    expect(forwardText).toContain('右')
    expect(forwardText.length).toBe(4)
  })

  test('仅删除的更新在状态向量不变时仍跨 Python 传播', () => {
    const source = new Y.Doc()
    writeParagraph(source.getXmlFragment('body'), TEXT_SAMPLE)
    const baseline = Y.encodeStateAsUpdate(source)

    const before = Y.encodeStateVector(source)
    // 删除 "中文"：UTF-16 码元索引，Yjs 侧语义明确。
    paragraphXmlText(source.getXmlFragment('body')).delete(5, 2)

    // 删除不引入新的客户端时钟，因此前后状态向量完全相同。
    expect(Y.encodeStateVector(source)).toEqual(before)

    const { update } = roundTrip([baseline, Y.encodeStateAsUpdate(source)])
    const restored = new Y.Doc()
    Y.applyUpdate(restored, update)

    expect(paragraphText(restored.getXmlFragment('body'))).toBe('Hello🙂')
  })

  test('Python 返回的状态向量与 Node 一致', () => {
    const source = new Y.Doc()
    writeParagraph(source.getXmlFragment('body'), TEXT_SAMPLE)

    const { stateVector } = roundTrip([Y.encodeStateAsUpdate(source)])
    expect(Buffer.from(stateVector).toString('base64')).toBe(
      Buffer.from(Y.encodeStateVector(source)).toString('base64'),
    )
  })

  test('可用 Python 返回的状态向量计算差量补齐落后副本', () => {
    const source = new Y.Doc()
    writeParagraph(source.getXmlFragment('body'), TEXT_SAMPLE)

    // 服务端只有基线；客户端随后继续编辑。
    const baseline = Y.encodeStateAsUpdate(source)
    const serverStateVector = roundTrip([baseline]).stateVector

    const xmlText = paragraphXmlText(source.getXmlFragment('body'))
    xmlText.insert(xmlText.length, '追加')

    // 客户端按服务端状态向量编码上行差量。
    const diff = Y.encodeStateAsUpdate(source, serverStateVector)
    expect(diff.length).toBeGreaterThan(0)

    // 服务端基线加上该差量即得到完整文档。
    const server = new Y.Doc()
    Y.applyUpdate(server, baseline)
    Y.applyUpdate(server, diff)

    expect(paragraphText(server.getXmlFragment('body'))).toBe(`${TEXT_SAMPLE}追加`)
  })
})
