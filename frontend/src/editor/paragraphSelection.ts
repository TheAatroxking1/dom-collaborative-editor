import { computed, onBeforeUnmount, ref, watch, type ComputedRef, type Ref } from 'vue'

import {
  isParagraphRef,
  measureParagraph,
  readParagraphs,
  type OverlayContext,
  type OverlayRect,
} from './paragraphs'
import type { ParagraphRef, ParagraphSnapshot } from './paragraphs'

/**
 * 从正文左侧留白直接拖动选择整段。
 *
 * 正文内部的拖动仍然选中文字，这里只接管留白区域；没有「框选段落」模式按钮。
 * 选择状态只保存段落引用并放进 Awareness，不加锁，别人仍然可以在同一段里输入。
 */

/** 留白宽度。必须小于正文左内边距，留白才不会盖住文字。 */
export const GUTTER_WIDTH = 24

/** 移动超过这个距离才认为是在框选，避免把一次普通点击当成拖动。 */
export const DRAG_THRESHOLD = 4

/** 拖动中最多每 50ms 发布一次，松手后立即发布最终值。 */
export const SELECTION_THROTTLE_MS = 50

/** 一条高亮：本机的或远端的。 */
export type SelectionRect = {
  /** 远端才有 clientId；本机为 null。 */
  clientId: number | null
  ref: ParagraphRef
  rect: OverlayRect
  color: string
  local: boolean
}

export type ParagraphSelection = {
  selectedCount: ComputedRef<number>
  rectangles: Ref<SelectionRect[]>
  /** 本机拖动中的矩形，只有拖动时才存在。 */
  dragRect: Ref<OverlayRect | null>
  onPointerDown: (event: PointerEvent) => void
  onPointerMove: (event: PointerEvent) => void
  onPointerUp: (event: PointerEvent) => void
  onPointerCancel: (event: PointerEvent) => void
  /** 抑制紧随拖动产生的那一次 click，否则它会立刻清掉刚选的内容。 */
  onClickCapture: (event: MouseEvent) => void
  clear: () => void
  /** 当前选中的段落，按文档顺序；快照不可用时为 null。 */
  selectedSnapshots: () => ParagraphSnapshot[] | null
}

const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/

function refKey(ref: ParagraphRef): string {
  return `${ref.type.client}:${ref.type.clock}`
}

/** 两个矩形是否相交。命中判定包含段落左侧留白，所以纯竖向拖动也能选段。 */
function intersects(a: OverlayRect, b: OverlayRect): boolean {
  return (
    a.left <= b.left + b.width &&
    a.left + a.width >= b.left &&
    a.top <= b.top + b.height &&
    a.top + a.height >= b.top
  )
}

function normalizeDrag(startX: number, startY: number, x: number, y: number): OverlayRect {
  return {
    left: Math.min(startX, x),
    top: Math.min(startY, y),
    width: Math.abs(x - startX),
    height: Math.abs(y - startY),
  }
}

export function useParagraphSelection(context: OverlayContext): ParagraphSelection {
  /** 本机选中的段落，按文档顺序去重。 */
  const selectedRefs = ref<ParagraphRef[]>([])
  const rectangles = ref<SelectionRect[]>([])
  const dragRect = ref<OverlayRect | null>(null)
  const paragraphs = ref<ParagraphSnapshot[]>([])

  let pointerId: number | null = null
  let dragStart: { x: number; y: number } | null = null
  let dragging = false
  let suppressClick = false
  let frame: number | null = null
  let pendingPublish: ReturnType<typeof setTimeout> | null = null
  let disposed = false

  const selectedCount = computed(() => selectedRefs.value.length)

  /** 重新读取段落快照并重画高亮。用一帧合并，不每帧永久轮询。 */
  const measure = (): void => {
    if (disposed) return
    const editor = context.editor.value
    const surface = context.surface.value
    if (editor === undefined || surface === null) return

    const snapshot = readParagraphs(editor, context.doc)
    if (snapshot === null) {
      // 组合输入中或视图尚未一致：保留选区，稍后重测，不猜位置。
      return
    }
    paragraphs.value = snapshot

    // 引用已解析为 null 的段落从选区里移除；但整体快照不可用时不这么做，
    // 否则会把「暂时读不到」误当成「段落被删了」。
    const alive = new Set(snapshot.map((entry) => refKey(entry.ref)))
    const kept = selectedRefs.value.filter((ref) => alive.has(refKey(ref)))
    if (kept.length !== selectedRefs.value.length) {
      selectedRefs.value = kept
      publishSelection()
    }

    draw(surface)
  }

  const draw = (surface: HTMLElement): void => {
    const local: SelectionRect[] = []
    const byRef = new Map(paragraphs.value.map((entry) => [refKey(entry.ref), entry]))

    for (const ref of selectedRefs.value) {
      const entry = byRef.get(refKey(ref))
      if (entry === undefined) continue
      const rect = measureParagraph(entry.element, surface)
      if (rect === null) continue
      local.push({ clientId: null, ref, rect, color: 'transparent', local: true })
    }

    const remote: SelectionRect[] = []
    if (context.connected.value) {
      for (const [clientId, state] of context.provider.awareness.getStates()) {
        if (clientId === context.doc.clientID) continue
        const payload = (state as Record<string, unknown>).paragraphSelection
        if (!Array.isArray(payload)) continue
        const user = (state as Record<string, unknown>).user as
          | { color?: unknown }
          | undefined
        const color =
          typeof user?.color === 'string' && COLOR_PATTERN.test(user.color)
            ? user.color
            : '#888888'
        for (const candidate of payload) {
          if (!isParagraphRef(candidate)) continue
          const entry = byRef.get(refKey(candidate))
          if (entry === undefined) continue
          const rect = measureParagraph(entry.element, surface)
          if (rect === null) continue
          remote.push({ clientId, ref: candidate, rect, color, local: false })
        }
      }
    }

    rectangles.value = [...local, ...remote]
  }

  const schedule = (): void => {
    if (disposed || frame !== null) return
    frame = requestAnimationFrame(() => {
      frame = null
      measure()
    })
  }

  const publishSelection = (): void => {
    context.provider.awareness.setLocalStateField(
      'paragraphSelection',
      selectedRefs.value,
    )
  }

  /** 拖动中节流发布；松手时立即发布最终值。 */
  const publishThrottled = (immediate = false): void => {
    if (immediate) {
      if (pendingPublish !== null) {
        clearTimeout(pendingPublish)
        pendingPublish = null
      }
      publishSelection()
      return
    }
    if (pendingPublish !== null) return
    pendingPublish = setTimeout(() => {
      pendingPublish = null
      if (disposed) return
      publishSelection()
    }, SELECTION_THROTTLE_MS)
  }

  /** 命中测试：拖动矩形与「段落矩形向左扩展到留白左边缘」相交。 */
  const hitTest = (drag: OverlayRect, surface: HTMLElement): ParagraphRef[] => {
    const hostRect = surface.getBoundingClientRect()
    const hits: ParagraphRef[] = []
    for (const entry of paragraphs.value) {
      const rect = entry.element.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) continue
      // 命中区域 = 该段矩形向左扩展到容器的左边缘，也就是把整条留白算进来。
      // 只扩到「段落左边再往左 GUTTER_WIDTH」是不够的：正文左内边距比留白宽，
      // 纯竖向拖动（宽度为 0）会整条落在扩展区左侧，永远不相交。
      const left = rect.left - hostRect.left
      const reachable: OverlayRect = {
        left: left - Math.max(left, GUTTER_WIDTH),
        top: rect.top - hostRect.top,
        width: rect.width + Math.max(left, GUTTER_WIDTH),
        height: rect.height,
      }
      if (intersects(drag, reachable)) hits.push(entry.ref)
    }
    return hits
  }

  const onPointerDown = (event: PointerEvent): void => {
    if (disposed) return
    // 只接管鼠标主键在留白里的按下；触屏保留原有文本编辑。
    if (event.button !== 0 || event.pointerType !== 'mouse') return
    const surface = context.surface.value
    if (surface === null) return

    const hostRect = surface.getBoundingClientRect()
    const x = event.clientX - hostRect.left
    // 正文内部：直接返回，不 preventDefault，让原本的文字选择照常工作。
    if (x > GUTTER_WIDTH) return

    pointerId = event.pointerId
    dragStart = { x, y: event.clientY - hostRect.top }
    dragging = false
  }

  const onPointerMove = (event: PointerEvent): void => {
    if (disposed || pointerId === null || event.pointerId !== pointerId) return
    const surface = context.surface.value
    if (surface === null) return

    const hostRect = surface.getBoundingClientRect()
    const current = { x: event.clientX - hostRect.left, y: event.clientY - hostRect.top }
    if (dragStart === null) return

    if (!dragging) {
      const moved = Math.hypot(current.x - dragStart.x, current.y - dragStart.y)
      if (moved < DRAG_THRESHOLD) return
      dragging = true
      // 真正开始拖动才接管：阻止原生文字选择，并捕获指针以便拖出容器后仍收到事件。
      event.preventDefault()
      surface.setPointerCapture(pointerId)
    }
    dragRect.value = normalizeDrag(dragStart.x, dragStart.y, current.x, current.y)

    const hits = hitTest(dragRect.value, surface)
    if (hits.length !== selectedRefs.value.length) {
      selectedRefs.value = hits
      draw(surface)
    } else {
      selectedRefs.value = hits
    }
    publishThrottled()
    schedule()
  }

  const finishDrag = (): void => {
    const surface = context.surface.value
    if (surface !== null && pointerId !== null && dragging) {
      surface.releasePointerCapture?.(pointerId)
      // 紧随拖动的那一次 click 会把刚选的内容清掉，抑制它。
      suppressClick = true
      // 让键盘操作（Esc / 删除 / 复制）可以直接作用在这个外壳上。
      surface.focus({ preventScroll: true })
    }
    pointerId = null
    dragStart = null
    dragging = false
    dragRect.value = null
    if (surface !== null) publishThrottled(true)
  }

  const onPointerUp = (event: PointerEvent): void => {
    if (pointerId === null || event.pointerId !== pointerId) return
    finishDrag()
  }

  const onPointerCancel = (event: PointerEvent): void => {
    if (pointerId === null || event.pointerId !== pointerId) return
    // 取消不执行任何操作，但也不保留半截拖动。
    const surface = context.surface.value
    if (surface !== null && dragging) surface.releasePointerCapture?.(pointerId)
    pointerId = null
    dragStart = null
    dragging = false
    dragRect.value = null
  }

  const onClickCapture = (event: MouseEvent): void => {
    if (!suppressClick) return
    suppressClick = false
    event.stopPropagation()
    event.preventDefault()
  }

  const clear = (): void => {
    if (selectedRefs.value.length === 0) return
    selectedRefs.value = []
    publishThrottled(true)
    schedule()
  }

  /** 点击选区外清除；工具栏、复制降级框与备份面板是操作区域，不能提前清空。 */
  const onDocumentPointerDown = (event: PointerEvent): void => {
    if (disposed) return
    const target = event.target as HTMLElement | null
    if (target === null) return
    if (target.closest('.editor-toolbar, .backup-panel, .plain-text-fallback') !== null) return
    clear()
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return
    if (selectedRefs.value.length === 0) return
    // 中文组合输入期间不处理。
    if (context.editor.value?.view.composing === true) return
    clear()
  }

  const awarenessHandler = (): void => schedule()

  context.provider.awareness.on('change', awarenessHandler)
  document.addEventListener('pointerdown', onDocumentPointerDown)
  window.addEventListener('scroll', schedule, { passive: true })
  window.addEventListener('resize', schedule)
  window.addEventListener('keydown', onKeyDown)

  const stopEditorWatch = watch(
    () => context.editor.value,
    (editor, previous) => {
      previous?.off('transaction', schedule)
      editor?.on('transaction', schedule)
      schedule()
    },
    { immediate: true },
  )
  const stopConnectionWatch = watch(() => context.connected.value, () => schedule(), {
    immediate: true,
  })
  const stopSurfaceWatch = watch(() => context.surface.value, () => schedule(), {
    immediate: true,
  })

  onBeforeUnmount(() => {
    disposed = true
    if (frame !== null) cancelAnimationFrame(frame)
    if (pendingPublish !== null) clearTimeout(pendingPublish)
    stopEditorWatch()
    stopConnectionWatch()
    stopSurfaceWatch()
    context.editor.value?.off('transaction', schedule)
    context.provider.awareness.off('change', awarenessHandler)
    document.removeEventListener('pointerdown', onDocumentPointerDown)
    window.removeEventListener('scroll', schedule)
    window.removeEventListener('resize', schedule)
    window.removeEventListener('keydown', onKeyDown)
    // 共享 Awareness 可能已被会话置空；再置一次不会复活离线身份。
    context.provider.awareness.setLocalStateField('paragraphSelection', [])
  })

  schedule()

  return {
    selectedCount,
    rectangles,
    dragRect,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    onClickCapture,
    clear,
    selectedSnapshots(): ParagraphSnapshot[] | null {
      const surface = context.surface.value
      if (surface === null) return null
      const editor = context.editor.value
      if (editor === undefined) return null
      const snapshot = readParagraphs(editor, context.doc)
      if (snapshot === null) return null
      const wanted = new Set(selectedRefs.value.map(refKey))
      return snapshot.filter((entry) => wanted.has(refKey(entry.ref)))
    },
  }
}
