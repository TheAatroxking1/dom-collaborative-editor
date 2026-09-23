import type { Editor } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import type { Ref, ShallowRef } from 'vue'
import type { WebsocketProvider } from 'y-websocket'
import * as Y from 'yjs'

/**
 * 段落的稳定引用与当前测量。
 *
 * 选区、鼠标指针和远端高亮都只保存**引用**，不保存数组下标——前者在别人于前面
 * 插入或删除段落时仍然指向同一段，后者会悄悄指向别的段。
 *
 * 不引入持久 Block ID：引用直接用 Yjs 的相对位置（RelativePosition），它由 CRDT
 * 自己维护，删除后会自然失效而不是退化成邻段。
 */

/** 段落的稳定引用：Yjs 相对位置的 JSON 形式，锚在段落自身的末尾。 */
export type ParagraphRef = {
  type: { client: number; clock: number }
  assoc: 0
}

/** 某一时刻的段落快照：引用、编辑器位置、节点与对应 DOM。 */
export type ParagraphSnapshot = {
  ref: ParagraphRef
  /** 该段在编辑器文档中的起止位置，来自当前这一帧的遍历。 */
  from: number
  to: number
  node: PMNode
  element: HTMLElement
}

/** 覆盖层需要的运行环境。三个协作者状态模块共用同一份。 */
export type OverlayContext = {
  editor: ShallowRef<Editor | undefined>
  doc: Y.Doc
  provider: WebsocketProvider
  connected: Readonly<Ref<boolean>>
  surface: Ref<HTMLElement | null>
}

/** 测量与绘制共用的上下文。 */
export type OverlayRect = {
  left: number
  top: number
  width: number
  height: number
}

/** 指针在本机段落内的归一化位置，x/y 都在 [0,1]。 */
export type PointerPosition = {
  ref: ParagraphRef
  x: number
  y: number
}

const BODY_ROOT = 'body'
const PARAGRAPH = 'paragraph'

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/**
 * 校验来自网络的引用。
 *
 * Awareness 的内容由别的客户端写入，不能直接相信：类型不对、坐标为负数或非整数
 * 都当作无效引用忽略，而不是让解析抛异常。
 */
export function isParagraphRef(value: unknown): value is ParagraphRef {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { type?: unknown; assoc?: unknown }
  if (candidate.assoc !== 0) return false
  if (typeof candidate.type !== 'object' || candidate.type === null) return false
  const type = candidate.type as { client?: unknown; clock?: unknown }
  return isNonNegativeSafeInteger(type.client) && isNonNegativeSafeInteger(type.clock)
}

/**
 * 为已加入共享文档的段落生成引用。
 *
 * 尚未集成的段落（游离节点）没有可序列化的身份，直接报错而不是返回一个假引用。
 */
export function paragraphRef(node: Y.XmlElement): ParagraphRef {
  let serialized: unknown
  try {
    serialized = Y.relativePositionToJSON(
      Y.createRelativePositionFromTypeIndex(node, node.length),
    )
  } catch {
    // 游离节点的相对位置无法序列化，库内部会抛错；换成可读原因。
    throw new Error('该段落尚未加入共享文档，无法生成引用')
  }

  const value = serialized as { type?: { client: number; clock: number } | null } | null
  if (value === null || value === undefined || !value.type) {
    throw new Error('该段落尚未加入共享文档，无法生成引用')
  }
  return { type: { client: value.type.client, clock: value.type.clock }, assoc: 0 }
}

/**
 * 把引用解析回当前文档里的段落。
 *
 * 只有解析结果**确实是 body 下的顶层 paragraph** 才返回它；段落已被删除、被合并，
 * 或引用指向的不是段落（例如文本节点）时一律返回 null——绝不能退化成下标去选邻段。
 */
export function resolveParagraph(doc: Y.Doc, ref: unknown): Y.XmlElement | null {
  if (!isParagraphRef(ref)) return null
  try {
    const absolute = Y.createAbsolutePositionFromRelativePosition(
      Y.createRelativePositionFromJSON(ref),
      doc,
    )
    if (absolute === null) return null
    const node = absolute.type as unknown
    if (!(node instanceof Y.XmlElement)) return null
    if (node.nodeName !== PARAGRAPH) return null
    const root = doc.getXmlFragment(BODY_ROOT)
    return root.toArray().includes(node) ? node : null
  } catch {
    // 远端引用解析失败属于正常情况（对方版本不同或引用已损坏），忽略即可。
    return null
  }
}

/**
 * 读取当前帧的段落快照。
 *
 * 返回 null 表示**此刻不能测量**——中文组合输入中，或 Y 根与编辑器顶层节点暂时
 * 对不上。调用方必须把 null 当作「稍后重试」，不能当作「所有段落都被删了」。
 */
export function readParagraphs(editor: Editor, doc: Y.Doc): ParagraphSnapshot[] | null {
  // 组合输入期间视图与文档可能不一致，不测量、不画、不做批量动作。
  if (editor.view.composing) return null

  const root = doc.getXmlFragment(BODY_ROOT)
  const shared = root.toArray()
  const topLevel: PMNode[] = []
  editor.state.doc.forEach((node) => topLevel.push(node))

  // 数量或类型对不上说明两种视图尚未一致：跳过这一帧，不猜位置。
  if (shared.length !== topLevel.length) return null
  for (const node of topLevel) {
    if (node.type.name !== PARAGRAPH) return null
  }

  const snapshots: ParagraphSnapshot[] = []
  let from = 0
  for (let index = 0; index < shared.length; index += 1) {
    const yNode = shared[index]
    const pmNode = topLevel[index]
    if (!(yNode instanceof Y.XmlElement) || pmNode === undefined) return null

    const dom = editor.view.nodeDOM(from)
    if (!(dom instanceof HTMLElement)) return null

    snapshots.push({
      ref: paragraphRef(yNode),
      from,
      to: from + pmNode.nodeSize,
      node: pmNode,
      element: dom,
    })
    from += pmNode.nodeSize
  }
  return snapshots
}

/** 段落自身在视口中的矩形。查询失败返回 null，调用方跳过这一帧。 */
export function measureParagraph(
  element: HTMLElement,
  host: HTMLElement,
): OverlayRect | null {
  const rect = element.getBoundingClientRect()
  const hostRect = host.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return null
  return {
    left: rect.left - hostRect.left,
    top: rect.top - hostRect.top,
    width: rect.width,
    height: rect.height,
  }
}

/**
 * 把屏幕坐标换算成「某个段落内的归一化位置」。
 *
 * 原始 clientX/clientY 只在发送端本机有效；接收端排版不同，必须按自己那份段落矩形
 * 还原。这里回答的是段落内的**大致位置**，不是精确字符位置——字符位置由文字光标
 * 负责。
 */
export function locatePointer(
  paragraphs: ParagraphSnapshot[],
  clientX: number,
  clientY: number,
): PointerPosition | null {
  for (const snapshot of paragraphs) {
    const rect = snapshot.element.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) continue
    if (
      clientX < rect.left ||
      clientX > rect.right ||
      clientY < rect.top ||
      clientY > rect.bottom
    ) {
      continue
    }
    return {
      ref: snapshot.ref,
      x: (clientX - rect.left) / rect.width,
      y: (clientY - rect.top) / rect.height,
    }
  }
  return null
}

/** 接收端按本机矩形还原归一化位置；坐标无效时返回 null。 */
export function projectPointer(
  paragraph: ParagraphSnapshot,
  host: HTMLElement,
  x: number,
  y: number,
): OverlayRect | null {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  if (x < 0 || x > 1 || y < 0 || y > 1) return null

  const rect = paragraph.element.getBoundingClientRect()
  const hostRect = host.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return null

  return {
    left: rect.left - hostRect.left + x * rect.width,
    top: rect.top - hostRect.top + y * rect.height,
    width: 0,
    height: 0,
  }
}
