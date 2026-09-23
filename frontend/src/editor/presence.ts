import type { Editor } from '@tiptap/core'
import { onBeforeUnmount, ref, shallowRef, watch, type Ref, type ShallowRef } from 'vue'
import type { WebsocketProvider } from 'y-websocket'
import type * as Y from 'yjs'

import {
  isParagraphRef,
  locatePointer,
  projectPointer,
  readParagraphs,
  type ParagraphRef,
  type ParagraphSnapshot,
} from './paragraphs'

/**
 * 协作者临时状态：访客身份、远端鼠标指针的发布与投影。
 *
 * 所有内容只放 Awareness，不写正文、不进数据库、不进备份或撤销栈。Awareness 本身
 * 是临时状态：断线或离开时它自然消失，不需要另外的心跳协议。
 */

/** 固定调色板。颜色只用于显示，不参与任何业务判断。 */
const GUEST_COLORS = ['#2563eb', '#9333ea', '#0f766e', '#c2410c', '#be185d'] as const

/** 指针最多每 50ms 发布一次，保留最后一次位置。 */
export const POINTER_THROTTLE_MS = 50

export type GuestUser = { name: string; color: string }

/**
 * 由客户端 ID 生成固定的访客名与颜色。
 *
 * 不做昵称设置页：同一份文档里不同客户端拿到不同的名字与颜色，足够区分即可。
 * clientID 是 Yjs 随机生成的，因此名字形如「访客 1a2b3c」而不是序号。
 */
export function guestUser(clientId: number): GuestUser {
  return {
    name: `访客 ${clientId.toString(36)}`,
    color: GUEST_COLORS[clientId % GUEST_COLORS.length] as string,
  }
}

/** 测量与绘制共用的上下文。 */
export type OverlayContext = {
  editor: ShallowRef<Editor | undefined>
  doc: Y.Doc
  provider: WebsocketProvider
  connected: Readonly<Ref<boolean>>
  surface: Ref<HTMLElement | null>
}

/** 画在覆盖层上的远端指针。 */
export type RemotePointer = {
  clientId: number
  name: string
  color: string
  left: number
  top: number
}

/** Awareness 里的鼠标字段。 */
type PointerState = {
  paragraph: ParagraphRef | null
  x: number
  y: number
}

export type Presence = {
  pointers: Ref<RemotePointer[]>
  onPointerMove: (event: PointerEvent) => void
  onPointerLeave: () => void
}

const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/

function isPointerState(value: unknown): value is PointerState {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { paragraph?: unknown; x?: unknown; y?: unknown }
  if (candidate.paragraph !== null && !isParagraphRef(candidate.paragraph)) return false
  if (candidate.paragraph === null) return false
  if (typeof candidate.x !== 'number' || typeof candidate.y !== 'number') return false
  if (!Number.isFinite(candidate.x) || !Number.isFinite(candidate.y)) return false
  return candidate.x >= 0 && candidate.x <= 1 && candidate.y >= 0 && candidate.y <= 1
}

/**
 * 远端鼠标指针的发布与投影。
 *
 * 发布的是「所在段落的引用 + 段内归一化坐标」，不是原始 clientX/clientY：接收端
 * 排版不同，只有按自己那份段落矩形还原才画得对。这也意味着它表达的是段内**大致
 * 位置**，不是精确字符位置——精确位置由文字光标负责。
 */
export function usePresence(context: OverlayContext): Presence {
  const pointers = ref<RemotePointer[]>([])
  const paragraphs = shallowRef<ParagraphSnapshot[] | null>(null)

  let frame: number | null = null
  let pendingPublish: ReturnType<typeof setTimeout> | null = null
  let lastPosition: PointerPosition | null = null
  let disposed = false

  /** 重新读取段落快照并重画面。用一帧合并，不每帧永久轮询。 */
  const measure = (): void => {
    if (disposed) return
    const editor = context.editor.value
    const surface = context.surface.value
    if (editor === undefined || surface === null) return
    paragraphs.value = readParagraphs(editor, context.doc)
    render(surface)
  }

  const schedule = (): void => {
    if (disposed || frame !== null) return
    frame = requestAnimationFrame(() => {
      frame = null
      measure()
    })
  }

  const render = (surface: HTMLElement): void => {
    const current = paragraphs.value
    if (current === null || !context.connected.value) {
      pointers.value = []
      return
    }

    const byRef = new Map(
      current.map((snapshot) => [
        `${snapshot.ref.type.client}:${snapshot.ref.type.clock}`,
        snapshot,
      ]),
    )

    const next: RemotePointer[] = []
    for (const [clientId, state] of context.provider.awareness.getStates()) {
      if (clientId === context.doc.clientID) continue
      const pointer = (state as Record<string, unknown>).pointer
      if (!isPointerState(pointer) || pointer.paragraph === null) continue

      const user = (state as Record<string, unknown>).user as
        | { name?: unknown; color?: unknown }
        | undefined
      const paragraph = byRef.get(
        `${pointer.paragraph.type.client}:${pointer.paragraph.type.clock}`,
      )
      // 尚未收到对应正文时暂不画；正文更新后会重新测量并补上。
      if (paragraph === undefined) continue

      const rect = projectPointer(paragraph, surface, pointer.x, pointer.y)
      if (rect === null) continue

      next.push({
        clientId,
        name: typeof user?.name === 'string' ? user.name : '协作者',
        color:
          typeof user?.color === 'string' && COLOR_PATTERN.test(user.color)
            ? user.color
            : '#888888',
        left: rect.left,
        top: rect.top,
      })
    }
    pointers.value = next
  }

  /** 立即清空本地指针并取消待发消息，防止延迟回调把旧位置重新发出去。 */
  const clearLocalPointer = (): void => {
    if (pendingPublish !== null) {
      clearTimeout(pendingPublish)
      pendingPublish = null
    }
    lastPosition = null
    context.provider.awareness.setLocalStateField('pointer', null)
  }

  const publish = (position: PointerPosition | null): void => {
    // 字段名必须与 isPointerState 读取的一致：线上的形状是 { paragraph, x, y }。
    // 内部类型用 ref 命名更贴近语义，转换只在这一处。
    context.provider.awareness.setLocalStateField(
      'pointer',
      position === null
        ? null
        : { paragraph: position.ref, x: position.x, y: position.y },
    )
  }

  const onPointerMove = (event: PointerEvent): void => {
    if (disposed) return
    const current = paragraphs.value
    const position = current === null ? null : locatePointer(current, event.clientX, event.clientY)
    lastPosition = position
    if (pendingPublish !== null) return

    pendingPublish = setTimeout(() => {
      pendingPublish = null
      if (disposed) return
      publish(lastPosition)
    }, POINTER_THROTTLE_MS)
  }

  const onPointerLeave = (): void => {
    clearLocalPointer()
  }

  const onVisibility = (): void => {
    if (document.hidden) clearLocalPointer()
  }

  const onWindowBlur = (): void => {
    clearLocalPointer()
  }

  const awarenessHandler = (): void => schedule()

  context.provider.awareness.on('change', awarenessHandler)
  window.addEventListener('scroll', schedule, { passive: true })
  window.addEventListener('resize', schedule)
  window.addEventListener('blur', onWindowBlur)
  document.addEventListener('visibilitychange', onVisibility)

  const observer =
    typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => schedule())
  // surface 是模板引用，setup 阶段还是 null：等它挂载后再观察，并在到位时先测一次。
  const stopSurfaceWatch = watch(
    () => context.surface.value,
    (element, previous) => {
      if (previous !== null && previous !== undefined) observer?.unobserve(previous)
      if (element === null) return
      observer?.observe(element)
      schedule()
    },
    { immediate: true },
  )

  // 正文事务完成后才测量；组合输入中 readParagraphs 会返回 null。
  const editorWatch = (): void => schedule()
  const stopEditorWatch = watch(
    () => context.editor.value,
    (editor, previous) => {
      previous?.off('transaction', editorWatch)
      editor?.on('transaction', editorWatch)
      schedule()
    },
    { immediate: true },
  )

  // 连接状态变化要立刻重画面：断网时隐藏远端覆盖层，重连后等新的移动事件。
  //
  // 断线时还要清掉**本地**指针：Awareness 会在重连时重新广播，留着旧坐标就等于
  // 让一个不再成立的像素位置复活——用户的手早就离开了那里。
  const stopConnectionWatch = watch(
    () => context.connected.value,
    (connected) => {
      if (!connected) clearLocalPointer()
      schedule()
    },
    { immediate: true },
  )

  onBeforeUnmount(() => {
    disposed = true
    if (frame !== null) cancelAnimationFrame(frame)
    if (pendingPublish !== null) clearTimeout(pendingPublish)
    observer?.disconnect()
    stopSurfaceWatch()
    stopEditorWatch()
    stopConnectionWatch()
    context.editor.value?.off('transaction', editorWatch)
    context.provider.awareness.off('change', awarenessHandler)
    window.removeEventListener('scroll', schedule)
    window.removeEventListener('resize', schedule)
    window.removeEventListener('blur', onWindowBlur)
    document.removeEventListener('visibilitychange', onVisibility)
    // 共享 Awareness 可能已被会话置空；再置一次不会复活离线身份。
    context.provider.awareness.setLocalStateField('pointer', null)
  })

  schedule()

  return { pointers, onPointerMove, onPointerLeave }
}

type PointerPosition = { ref: ParagraphRef; x: number; y: number }
