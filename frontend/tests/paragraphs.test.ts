import { describe, expect, test } from 'vitest'
import * as Y from 'yjs'

import { paragraphRef, resolveParagraph, type ParagraphRef } from '../src/editor/paragraphs'

/**
 * 段落引用的稳定性。
 *
 * 选区只保存引用，不保存数组下标——否则前面插入新段就会选错，删除后还会转而选中
 * 邻段。这些用例用真实的 Yjs 更新（不是算法的复制品）验证引用身份。
 */

function buildParagraph(text: string): Y.XmlElement {
  const paragraph = new Y.XmlElement('paragraph')
  paragraph.push([new Y.XmlText(text)])
  return paragraph
}

describe('段落引用', () => {
  test('前插不会选错段，原段删除后不能退到相邻段', () => {
    const a = new Y.Doc()
    const b = new Y.Doc()
    try {
      const body = a.getXmlFragment('body')
      const chosen = new Y.XmlElement('paragraph')
      body.push([chosen])
      const ref = paragraphRef(chosen)

      // 前面插入新段：引用必须仍然指向原来那一段。
      body.insert(0, [new Y.XmlElement('paragraph')])
      chosen.push([new Y.XmlText('保留我的身份')])
      Y.applyUpdate(b, Y.encodeStateAsUpdate(a))

      expect(resolveParagraph(b, ref)).toBe(b.getXmlFragment('body').get(1))

      // 原段被删除：引用失效，绝不能退化成下标而选中邻段。
      body.delete(1, 1)
      Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
      expect(resolveParagraph(b, ref)).toBeNull()
    } finally {
      a.destroy()
      b.destroy()
    }
  })

  test('中间插入不改变引用指向', () => {
    const a = new Y.Doc()
    const b = new Y.Doc()
    try {
      const body = a.getXmlFragment('body')
      body.push([buildParagraph('第一段')])
      const target = buildParagraph('目标段')
      body.push([target])
      body.push([buildParagraph('第三段')])
      const ref = paragraphRef(target)

      body.insert(1, [buildParagraph('插入段')])
      Y.applyUpdate(b, Y.encodeStateAsUpdate(a))

      const resolved = resolveParagraph(b, ref)
      expect(resolved).toBe(b.getXmlFragment('body').get(2))
      expect(resolved?.toString()).toContain('目标段')
    } finally {
      a.destroy()
      b.destroy()
    }
  })

  test('内容变化后引用仍然有效', () => {
    const a = new Y.Doc()
    const b = new Y.Doc()
    try {
      const body = a.getXmlFragment('body')
      const target = buildParagraph('原始内容')
      body.push([target])
      const ref = paragraphRef(target)

      // 改内容，包括删除与插入。
      ;(target.get(0) as Y.XmlText).delete(0, 2)
      ;(target.get(0) as Y.XmlText).insert(0, '改过的')
      Y.applyUpdate(b, Y.encodeStateAsUpdate(a))

      const resolved = resolveParagraph(b, ref)
      expect(resolved).not.toBeNull()
      expect(resolved?.toString()).toContain('改过的')
    } finally {
      a.destroy()
      b.destroy()
    }
  })

  test('尚未加入共享文档的段落无法生成引用', () => {
    const orphan = buildParagraph('游离段落')
    expect(() => paragraphRef(orphan)).toThrow(/共享文档/)
  })

  test('非法引用一律解析为 null，不抛异常', () => {
    const doc = new Y.Doc()
    try {
      const body = doc.getXmlFragment('body')
      body.push([buildParagraph('甲')])

      const malformed: unknown[] = [
        null,
        undefined,
        'not-an-object',
        {},
        { type: null, assoc: 0 },
        { type: { client: -1, clock: 0 }, assoc: 0 },
        { type: { client: 1.5, clock: 0 }, assoc: 0 },
        { type: { client: 0, clock: -3 }, assoc: 0 },
        { type: { client: 0, clock: 0 }, assoc: 1 },
        { type: { client: 'x', clock: 0 }, assoc: 0 },
      ]
      for (const value of malformed) {
        expect(resolveParagraph(doc, value as ParagraphRef)).toBeNull()
      }
    } finally {
      doc.destroy()
    }
  })

  test('引用只锚定顶层 paragraph：解析到的不是段落就作废', () => {
    const doc = new Y.Doc()
    try {
      const body = doc.getXmlFragment('body')
      body.push([buildParagraph('甲')])

      // 直接对 XmlText 建引用：它解析得到的是文本节点，不是段落。
      const paragraph = body.get(0)
      if (!(paragraph instanceof Y.XmlElement)) throw new Error('测试数据不是段落')
      const text = paragraph.get(0)
      if (!(text instanceof Y.XmlText)) throw new Error('测试数据不是文本节点')
      const ref = paragraphRef(text as unknown as Y.XmlElement)
      expect(resolveParagraph(doc, ref)).toBeNull()
    } finally {
      doc.destroy()
    }
  })

  test('另一端删除后，同一引用在两侧都失效', () => {
    const a = new Y.Doc()
    const b = new Y.Doc()
    try {
      const body = a.getXmlFragment('body')
      const target = buildParagraph('会被删除')
      body.push([target])
      Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
      const ref = paragraphRef(target)

      // 在另一侧删除该段，再同步回来。
      const bodyB = b.getXmlFragment('body')
      bodyB.delete(0, 1)
      Y.applyUpdate(a, Y.encodeStateAsUpdate(b))

      expect(resolveParagraph(a, ref)).toBeNull()
      expect(resolveParagraph(b, ref)).toBeNull()
    } finally {
      a.destroy()
      b.destroy()
    }
  })
})
