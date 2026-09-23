# Collaboration Presence and Paragraph Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 本次由 Claude 实施；已有工作目录，先核对状态，不自动再创建应用。

**Goal:** 增加协作者文字光标/选区、鼠标指针、从左侧留白直接拖动的整段框选，以及批量复制、删除和单次撤销。

**Architecture:** 文字协作用 Tiptap CollaborationCaret；所有临时状态复用现有 Provider 的 Awareness。自定义交互只增加段落引用、DOM 覆盖层和一次 ProseMirror 删除事务，继续使用现有 Yjs 同步、存储与 UndoManager。

**Tech Stack:** Vue 3.5.43、Tiptap 3.31.3、Yjs 13.6.32、y-websocket 3.1.0、y-indexeddb 9.0.12、现有 FastAPI/pycrdt 后端、Vitest、Playwright。

## Global Constraints

- 完整行为以 [设计文档](../specs/2026-09-24-collaboration-presence-selection-design.md) 为准。本计划是待实施说明，不是已通过的测试报告。
- 工作目录：`F:\基于DOM的协作编辑器\.claude\worktrees\confident-mclaren-506b7a`；核对基线 `6df4770`。所有命令默认在此执行；UTF-8。
- 正文拖动选字，左侧留白拖动选整段；没有模式按钮。点外清除，工具栏操作不能提前清空选区。
- 两人可在同段输入，选择不加锁。保留中文输入、HardBreak、粘贴、离线恢复、备份和 HTTP 局域网手动复制。
- 只新增 `@tiptap/extension-collaboration-caret@3.31.3`，不升级已有依赖，不加框选库或后端服务。
- 不改 schema、`body`、`dom-collab-v2:`、文档 UUID、数据库格式、开发 5273 / 构建 5274 端口。
- 不另建同步协议、ACK、重试队列、历史管理器或持久 Block ID。临时状态不写入正文，不进入撤销和备份。
- 只改完成本轮必需的文件。按下列四步分别提交；前置退出问题如需修复，单独提交。
- 不增加测试专用生产 API、调试面板或 `window.editor`；沿用现有两个独立浏览器上下文和真实 Python 测试夹具。

## 文件职责与共同接口

| 文件（相对应用根目录） | 责任 |
| --- | --- |
| `frontend/src/documents/session.ts` | 暴露现有 Provider，维护其生命周期 |
| `frontend/src/editor/extensions.ts` | 接入 CollaborationCaret |
| `frontend/src/editor/paragraphs.ts`（新） | 稳定段落引用、当前 PM 范围与 DOM 测量 |
| `frontend/src/editor/presence.ts`（新） | 自动访客信息、Awareness 鼠标发布和投影 |
| `frontend/src/editor/paragraphSelection.ts`（新） | 框选状态、远端段落高亮、批量操作 |
| `frontend/src/editor/EditorPane.vue` | 组装编辑器、按钮、DOM 覆盖层、复制反馈 |
| `frontend/src/App.vue` | 传入现有会话的 Provider 与连接状态 |
| `frontend/src/styles.css` | 光标、覆盖层、留白和选区样式 |
| `frontend/tests/paragraphs.test.ts`（新） | 引用在真正 Yjs 更新中的稳定性 |
| `frontend/e2e/presence.spec.ts`（新） | 两端文字光标、选区、鼠标和断线清理 |
| `frontend/e2e/paragraph-selection.spec.ts`（新） | 实际拖动、批量操作、并发与撤销 |
| `frontend/tests/session.test.ts`（修改） | 暴露对象与会话销毁的必要回归 |
| `frontend/e2e/fixtures.ts`、`frontend/e2e-production/fixtures.ts`（修改） | 既有正文读取 helper 排除新增光标装饰 DOM |
| `README.md`（修改） | 新交互、定位精度和验收边界 |

`paragraphs.ts` 的公共接口如下。类型声明只是模块间契约；实现不能停留在声明上。禁止为了遵守文件数量把一个模块写成数百行混合业务；确实出现独立职责时再拆，不提前搭框架。

```ts
import type { Editor } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import type { Ref, ShallowRef } from 'vue'
import type { WebsocketProvider } from 'y-websocket'
import type * as Y from 'yjs'

export type ParagraphRef = {
  type: { client: number; clock: number }
  assoc: 0
}
export type ParagraphSnapshot = {
  ref: ParagraphRef
  from: number
  to: number
  node: PMNode
  element: HTMLElement
}
export type OverlayContext = {
  editor: ShallowRef<Editor | undefined>
  doc: Y.Doc
  provider: WebsocketProvider
  connected: Readonly<Ref<boolean>>
  surface: Ref<HTMLElement | null>
}
export type OverlayRect = {
  left: number; top: number; width: number; height: number
}

export declare function paragraphRef(node: Y.XmlElement): ParagraphRef
export declare function resolveParagraph(doc: Y.Doc, ref: ParagraphRef): Y.XmlElement | null
export declare function readParagraphs(editor: Editor, doc: Y.Doc): ParagraphSnapshot[] | null
```

`surface` 是包住 EditorContent 和覆盖层的非滚动相对定位容器。`readParagraphs` 返回 null 表示组合输入中或快照暂不可用，不能把 null 当作“所有段落已删除”。组件不访问 `_item`、`_start`、绑定库私有字段。

## 开始前：核对已有修复，不扩大功能范围

- [ ] 在应用工作目录运行：

```powershell
git status --short
git log -4 --oneline
npm --prefix frontend run typecheck
```

记录实际 HEAD，保留未提交修改。预期 typecheck 退出 0；若失败，先区分已有问题，不能把失败藏进新功能提交。

- [ ] 检查 `frontend/e2e-production/fixtures.ts` 的 `stopGracefully()` 和 fixture finally。`6df4770` 在超时后只打印日志并 kill，仍可报告通过。若 Claude 已修复则直接使用，不重复改。
- [ ] 若未修复，单独修复测试的失败传播：正常退出必须 code=0；超时或非零退出先记录日志并清理自己启动的进程，随后使测试失败。保留原测试失败信息；继续调查实际退出卡住原因。不得以拉长超时、静默 kill 或不关闭会话代替修复。
- [ ] 此项独立记录结果。退出异常没解释清楚时，新功能可以继续开发，但最终报告不得写“全部验证无异常”。

## Task 1：接入文字光标与文字选区

**Files:** 修改 `frontend/package.json`、`frontend/package-lock.json`、session.ts、App.vue、extensions.ts、EditorPane.vue、styles.css、两套 e2e 的 fixtures.ts 正文读取 helper；创建 presence.ts、`frontend/e2e/presence.spec.ts`；补充 session.test.ts。

**Interfaces:** `DocumentSession` 新增 `readonly provider: WebsocketProvider`；`editorExtensions(doc, provider)` 使用同一个 Provider；`presence.ts` 导出 `guestUser(clientId: number): { name: string; color: string }`。此步不实现鼠标。

- [ ] 先在 presence.spec.ts 写真实两端回归，验证新行为当前缺失：

```ts
import {
  expect, test, openDocumentAt, focusEditor,
  selectLeadingCharacters, editorText,
} from './fixtures'

test('远端文字光标和选区可见，不改变正文', async ({ first, second, openDocument }) => {
  const id = await openDocument(first)
  await openDocumentAt(second, id)
  await focusEditor(first)
  await first.keyboard.insertText('协作测试')
  await expect.poll(() => editorText(second)).toBe('协作测试')
  await expect(second.locator('.collaboration-carets__caret')).toHaveCount(1)
  await selectLeadingCharacters(first, 2)
  await expect(second.locator('.ProseMirror-yjs-selection')).toContainText('协作')
  await expect.poll(() => editorText(second)).toBe('协作测试')
})
```

运行 `npm --prefix frontend run test:e2e -- presence.spec.ts`，预期新增光标断言失败。不要把浏览器缺失或服务启动失败当作有效的功能红灯。

- [ ] 安装唯一新依赖：

```powershell
npm --prefix frontend install --save-exact @tiptap/extension-collaboration-caret@3.31.3
```

核对 lock diff 不升级其他版本。npm registry 已确认 caret 3.31.3 要求 core/pm 3.31.3、y-tiptap ^3.0.7，与当前 3.0.9 匹配。

- [ ] 暴露既有 Provider；传入 EditorPane 的 `provider` 与 `connection`。session.close 在现有 destroy 前执行 `network?.awareness.setLocalState(null)`；不创建第二个 Awareness。自定义组件清理时取消订阅/定时器，不销毁共享 Provider。原 `doc.destroy()` 会结束该 doc 所属 Awareness 生命周期。
- [ ] 以固定调色板生成访客名，接入扩展：

```ts
// presence.ts
export function guestUser(clientId: number) {
  const colors = ['#2563eb', '#9333ea', '#0f766e', '#c2410c', '#be185d']
  return {
    name: `访客 ${clientId.toString(36)}`,
    color: colors[clientId % colors.length]!,
  }
}
```

```ts
// extensions.ts：保留现有 schema 和 Collaboration，追加这一项。
import CollaborationCaret from '@tiptap/extension-collaboration-caret'
import { guestUser } from './presence'

CollaborationCaret.configure({ provider, user: guestUser(doc.clientID) })
```

- [ ] styles.css 添加扩展所需样式。光标、名称不抢事件，不改变行高；名称无需新增可编辑表单。最低样式：

```css
.collaboration-carets__caret {
  border-left: 1px solid;
  margin-left: -1px;
  position: relative;
  pointer-events: none;
  word-break: normal;
}
.collaboration-carets__label {
  position: absolute;
  left: -1px;
  bottom: 100%;
  padding: 0.1rem 0.3rem;
  border-radius: 3px;
  color: white;
  font-size: 12px;
  line-height: 1.4;
  white-space: nowrap;
  user-select: none;
}
```

- [ ] 增补 session 测试：返回的是绑定该 session.doc 的现有 provider；close 后本地 Awareness 为 null；重复 close 不抛错。保留当前所有恢复/重连用例。
- [ ] 两套 fixtures.ts 的 `editorText` 当前使用 allInnerTexts，会把新增的访客名读成正文。只修改读取 helper 以排除装饰，并保留换行语义；不要为测试改变产品名称显示。用以下实现替换既有函数体：

```ts
const paragraphs = page.getByRole('textbox', { name: '文档正文' }).locator('p')
return paragraphs.evaluateAll(nodes => nodes.map(node => {
  const copy = node.cloneNode(true) as HTMLElement
  copy.querySelectorAll('.collaboration-carets__caret').forEach(caret => caret.remove())
  copy.querySelectorAll('br').forEach(br => br.replaceWith('\n'))
  return (copy.textContent ?? '').replace(/\n+$/, '')
}).join('\n'))
```

此 helper 保持此前去除段末展示换行的约定；需要检验 HardBreak/空段精确复制时应断言实际剪贴板值，不能只依赖它。顺便验证已有“复制正文”和原生文字复制都不带访客名。
- [ ] 跑 `npm --prefix frontend run test -- tests/session.test.ts`、presence.spec.ts、`npm --prefix frontend run typecheck`。验证同源双标签仍使用不同 clientID；失焦和离开页面按扩展行为清理光标。
- [ ] 单独提交：`feat: show collaborative text carets and selections`。

## Task 2：稳定段落引用与远端鼠标

**Files:** 创建 paragraphs.ts、paragraphs.test.ts；扩充 presence.ts、presence.spec.ts；修改 EditorPane.vue、styles.css。

**Interfaces:** 实现上述 paragraphs.ts 接口。presence.ts 增加 `usePresence(context: OverlayContext)`，返回 `pointers`（响应式远端指针数组）、`onPointerMove(event: PointerEvent)`、`onPointerLeave()`。每个指针包含 `clientId/name/color/left/top`，坐标相对 surface。

- [ ] 先写引用回归测试。它验证并发后对象身份，不验证一份算法的复制品：

```ts
import { expect, test } from 'vitest'
import * as Y from 'yjs'
import { paragraphRef, resolveParagraph } from '../src/editor/paragraphs'

test('前插不会选错段，原段删除后不能退到相邻段', () => {
  const a = new Y.Doc()
  const b = new Y.Doc()
  try {
    const body = a.getXmlFragment('body')
    const chosen = new Y.XmlElement('paragraph')
    body.push([chosen])
    const ref = paragraphRef(chosen)
    body.insert(0, [new Y.XmlElement('paragraph')])
    chosen.push([new Y.XmlText('保留我的身份')])
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
    expect(resolveParagraph(b, ref)).toBe(b.getXmlFragment('body').get(1))
    body.delete(1, 1)
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
    expect(resolveParagraph(b, ref)).toBeNull()
  } finally {
    a.destroy()
    b.destroy()
  }
})
```

运行 `npm --prefix frontend run test -- tests/paragraphs.test.ts`，预期因新模块未实现而失败。

- [ ] 用库的公开相对位置 API 实现核心，不读 Yjs 内部结构：

```ts
import * as Y from 'yjs'

export function paragraphRef(node: Y.XmlElement): ParagraphRef {
  const value = Y.relativePositionToJSON(
    Y.createRelativePositionFromTypeIndex(node, node.length),
  )
  if (!value.type) throw new Error('段落尚未加入共享文档')
  return { type: { client: value.type.client, clock: value.type.clock }, assoc: 0 }
}

export function resolveParagraph(doc: Y.Doc, ref: ParagraphRef): Y.XmlElement | null {
  try {
    const absolute = Y.createAbsolutePositionFromRelativePosition(
      Y.createRelativePositionFromJSON(ref), doc,
    )
    const node = absolute?.type
    if (!(node instanceof Y.XmlElement) || node.nodeName !== 'paragraph') return null
    return doc.getXmlFragment('body').toArray().includes(node) ? node : null
  } catch {
    return null
  }
}
```

Awareness 来的 unknown 在调用前验证：type 是对象、client/clock 为非负安全整数、assoc 为 0。这里的 catch 只处理远端引用解析失败，不包住整个功能以掩盖异常。

- [ ] 实现 `readParagraphs`：拒绝 `editor.view.composing`；读取当前 root.toArray 与 editor.state.doc 顶层节点，检查数量与 paragraph 类型；从 from=0 累加 nodeSize，通过 `view.nodeDOM(from)` 取得 HTMLElement。DOM 不完整返回 null。读取时使用当前顺序，持久选区只保存 ref。
- [ ] 以本机 DOM 矩形编码和投影指针，公式固定为：

```ts
const x = (event.clientX - paragraphRect.left) / paragraphRect.width
const y = (event.clientY - paragraphRect.top) / paragraphRect.height
// 接收端重新测量自己的段落，hostRect 为本机 surface 的矩形。
const left = paragraphRect.left - hostRect.left + pointer.x * paragraphRect.width
const top = paragraphRect.top - hostRect.top + pointer.y * paragraphRect.height
```

只在事件点落入实际段落矩形且尺寸大于 0 时发送 `{ paragraph: ref, x, y }`。正文外发 null。禁止把归一化后的坐标宣传为逐字符定位。

- [ ] `usePresence` 订阅 Awareness change、编辑器 transaction、页面滚动和 resize；用一次待执行的 rAF 合并 DOM 测量。远端过滤自身 clientID，并验证姓名、颜色、有限坐标及引用；无效或找不到的暂不绘制。容器尺寸变化用 ResizeObserver 触发同一个测量入口。
- [ ] 移动使用 50ms 节流和最后位置补发。退出正文、window blur、document hidden、connection 不再 connected、卸载时：取消待发 timeout/rAF，清空本地 pointer；失联时隐藏远端指针。重连后等待新的移动事件，不复活旧像素。
- [ ] 在 EditorPane 的非滚动相对容器中显示指针 overlay，设置 `pointer-events:none`。此步不改文字选择和粘贴处理。
- [ ] 在 presence.spec.ts 增加：第二端改成不同 viewport 宽度，第一端指向一个有自动换行的段落；第二端指针仍在同段矩形内，滚动/resize 后跟随该段。第一端移出正文、断网/重连、换文档后不能留下旧指针。可用 `context.setOffline(true)`，不新增网络协议模拟器。
- [ ] 用 UI 产生鼠标移动，不直接调用生产函数冒充 E2E。示例定位方法：

```ts
const box = await first.locator('.editor-body > p').nth(1).boundingBox()
if (!box) throw new Error('待指向段落没有布局矩形')
await first.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
await expect(second.locator('[data-remote-pointer]')).toHaveCount(1)
```

渲染元素约定 `data-remote-pointer`，用于 UI 语义和定位；这不是向全局暴露内部实例。进一步断言指针中心落入第二端对应段落，不仅断言数量。

- [ ] 跑 paragraphs.test.ts、presence.spec.ts、typecheck，预期通过。提交：`feat: share paragraph-relative mouse pointers`。

## Task 3：直接拖动选段与协作者段落高亮

**Files:** 创建 paragraphSelection.ts、paragraph-selection.spec.ts；修改 EditorPane.vue、styles.css；复用 paragraphs.ts。

**Interfaces:** `useParagraphSelection(context: OverlayContext)` 返回 `selectedCount`、`rectangles`、`dragRect`、`onPointerDown/Move/Up/Cancel`、`clear()`。rectangles 包含本机及远端的 `clientId/ref/rect/color/local`；dragRect 只有本机临时几何。下一步在同一模块追加批量动作。

- [ ] 在 paragraph-selection.spec.ts 写可复用的实际鼠标拖动 helper，后续测试直接复用，避免第二套测试服务器：

```ts
import type { Page } from '@playwright/test'

async function dragParagraphs(page: Page, start: number, end: number) {
  const paragraphs = page.locator('.editor-body > p')
  const a = await paragraphs.nth(start).boundingBox()
  const b = await paragraphs.nth(end).boundingBox()
  if (!a || !b) throw new Error('待框选段落不存在')
  await page.mouse.move(a.x - 12, a.y + a.height / 2)
  await page.mouse.down()
  await page.mouse.move(b.x + 8, b.y + b.height / 2, { steps: 8 })
  await page.mouse.up()
}
```

首个测试创建三段，拖选前两段，断言“已选 2 段”可见；在第二端看到两段远端高亮；点击正文后计数消失，普通文字拖动仍能产生文字选区。运行此文件，预期因当前无段落选择而失败。

- [ ] 给编辑器正文左侧保留约 24px 可操作留白，并添加简短提示“拖动左侧留白选择整段”。不增加模式按钮。只接管 gutter 内主鼠标 pointerdown；正文事件直接返回，不能 preventDefault。
- [ ] 超过 4px 后开始拖动，保存 pointerId 并 `setPointerCapture`；命中矩形是段落 DOM 矩形向左扩展至留白左边缘。基础判定：

```ts
function intersects(a: DOMRectReadOnly, b: DOMRectReadOnly): boolean {
  return a.left <= b.right && a.right >= b.left
    && a.top <= b.bottom && a.bottom >= b.top
}
```

用 surface 相对坐标保存拖动起点，滚动后重新换算。只有真正拖动才阻止原生文字选择；窗口失焦或 pointercancel 时清理 capture 与拖动矩形，不执行删除。松手保留 refs，聚焦 `tabindex="0"` 的 surface；抑制紧随拖动产生的一次 click，不能让它把刚选的内容清掉。

- [ ] local refs 存在模块内响应式数组；每次命中文档按文档顺序去重。内容变化后丢弃已经解析为 null 的引用；读快照暂不可用则保留，稍后重测。分段/合段严格使用设计文档中的身份规则，不另造追踪算法。
- [ ] 通过 `setLocalStateField('paragraphSelection', refs)` 发布变化，拖动中最多每 50ms，松手最终值立即发布；clear 时取消待发并发布 `[]`。不能因远端 update 再写一次相同本地值造成循环。
- [ ] 在同一 overlay 渲染本机半透明高亮和远端彩色轮廓；远端不画发送者的原始框选矩形。使用 `data-local-paragraph-selection` / `data-remote-paragraph-selection` 标记对应 UI。重叠协作者用各自轮廓呈现，不篡改正文 DOM。
- [ ] 处理点外清除：document pointerdown 使用同一个可移除的函数引用；正文点击清除且继续默认行为，工具栏/复制降级框排除，选区外清除。Escape 清除。本轮不接管触屏、输入法组合事件或备份输入框。
- [ ] 生命周期对称清理：所有 editor/awareness/window/document 订阅、ResizeObserver、rAF、timeout、pointer capture 在卸载时清除；不要在 shared Awareness 已 null 后重新 setLocalStateField 复活离线身份。
- [ ] 用 E2E 覆盖：纯竖向拖动、反向拖动、空段、正文文字拖动、点击正文放光标、拖动后鼠标抬起不误清空、远程前插仍选原段、远程删段不误选邻段、切换文档无残留。鼠标框选与文字选区的断言分别检查，不能只验证截图。
- [ ] 跑 paragraph-selection.spec.ts、presence.spec.ts、typecheck。提交：`feat: select paragraphs by dragging the editor gutter`。

## Task 4：批量复制、删除、独立撤销与交付验证

**Files:** 修改 paragraphSelection.ts、EditorPane.vue、paragraph-selection.spec.ts、README.md。复用 clipboard.ts，除非有实际失败证据，不改后端业务。

**Interfaces:** `useParagraphSelection` 追加 `selectedText(): string | null` 与 `deleteSelected(): boolean`。selectedText 在当前快照不可用或无选中段时返回 null；空段的合法复制值可以是空字符串。动作成功后由 clear 清理选区。EditorPane 复用自己的复制成功/失败提示。

- [ ] 添加先失败的批量操作测试：用现有 `pasteText` 建三段，选中后两段，点击删除，然后点击撤销，检查两端精确文本。基础骨架：

```ts
test('一批删除只需要一次撤销', async ({ first, second, openDocument }) => {
  const id = await openDocument(first)
  await focusEditor(first)
  await pasteText(first, '保留\n删除甲\n删除乙')
  await openDocumentAt(second, id)
  await expect.poll(() => editorText(second)).toBe('保留\n删除甲\n删除乙')
  await dragParagraphs(first, 1, 2)
  await first.getByRole('button', { name: '删除所选段落' }).click()
  await expect.poll(() => editorText(second)).toBe('保留')
  await first.getByRole('button', { name: '撤销', exact: true }).click()
  await expect.poll(() => editorText(first)).toBe('保留\n删除甲\n删除乙')
  await expect.poll(() => editorText(second)).toBe('保留\n删除甲\n删除乙')
  await first.getByRole('button', { name: '重做', exact: true }).click()
  await expect.poll(() => editorText(second)).toBe('保留')
})
```

该文件 imports 从 `./fixtures` 取得 test/expect/focusEditor/pasteText/openDocumentAt/editorText，dragParagraphs 来自同文件 Task 3。不以固定 sleep 等待同步。

- [ ] 复制只读取当前选中段落，保留空段与 HardBreak：

```ts
const text = chosenInDocumentOrder
  .map(({ node }) => node.textBetween(0, node.content.size, '\n', '\n'))
  .join('\n')
```

`chosenInDocumentOrder` 由当前 readParagraphs 按 ref 匹配得到，不用选择开始时的文本或下标。EditorPane 的 `copyBody` 和“复制所选段落”共用 `copyText(value, successLabel)`；继续调用 tryCopyText，失败显示现有 readonly textarea。不能因为空字符串 falsy 就丢掉空段复制。

- [ ] Delete 的核心固定为一次 dispatch，并使用现有 UndoManager：

```ts
import type { Editor } from '@tiptap/core'
import { Selection } from '@tiptap/pm/state'
import { yUndoPluginKey } from '@tiptap/y-tiptap'
import type * as Y from 'yjs'
import { readParagraphs, type ParagraphRef } from './paragraphs'

export function deleteParagraphs(editor: Editor, doc: Y.Doc, refs: ParagraphRef[]): boolean {
  const all = readParagraphs(editor, doc)
  if (all === null) return false
  const keys = new Set(refs.map(ref => `${ref.type.client}:${ref.type.clock}`))
  const chosen = all.filter(p => keys.has(`${p.ref.type.client}:${p.ref.type.clock}`))
  if (chosen.length === 0) return false
  const undoState = yUndoPluginKey.getState(editor.state) as
    { undoManager: Y.UndoManager } | undefined
  if (!undoState) throw new Error('协作撤销扩展未就绪')
  const tr = editor.state.tr
  if (chosen.length === all.length) {
    tr.replaceWith(0, tr.doc.content.size, editor.schema.nodes.paragraph!.create())
  } else {
    for (const p of [...chosen].reverse()) tr.delete(p.from, p.to)
  }
  const cursor = Math.min(chosen[0]!.from, tr.doc.content.size)
  tr.setSelection(Selection.near(tr.doc.resolve(cursor)))
  undoState.undoManager.stopCapturing()
  try {
    editor.view.dispatch(tr.scrollIntoView())
  } finally {
    undoState.undoManager.stopCapturing()
  }
  return true
}
```

不直接 delete Y.XmlFragment，避免绕过编辑器历史和选区处理。不使用 setContent 重建整个文档。现有版本 y-tiptap 在视图 update 同步写入 Yjs；用下面相邻输入用例确认前后 stopCapturing 生效。

- [ ] 工具栏新增计数、复制所选段落、删除所选段落；只有选区有效时启用。复制保留选区，删除成功 clear，失败不误报成功。在批量操作期间不 await 后再使用旧 PM 范围。
- [ ] 键盘事件限定在当前 editor pane，且目标必须是正文或聚焦的 surface；input/textarea/select/其他交互控件不截获。selected refs 非空时处理 Delete/Backspace/Escape，组合输入时返回。Ctrl/Cmd+Z、Shift+Ctrl/Cmd+Z、Ctrl+Y 在外壳上转发给现有 editor 命令；正文继续由 Tiptap 自己处理。原生 copy 事件优先设置 text/plain，按钮仍走 Clipboard API 的已有降级。
- [ ] 以下用例补到同一 E2E 文件，避免为每个按钮建立新测试框架：

| 用例 | 断言 |
| --- | --- |
| 选多段后点复制 | 顺序正确，中文/emoji/HardBreak/空段保留，选区仍在 |
| Clipboard API 被拒绝 | 出现可手动复制的所选文本，操作该文本框不触发段落快捷键 |
| 输入后立即批量删除，再 undo | 只恢复删除，紧邻之前的输入仍在 |
| 删除后立即在剩余段输入，再 undo 两次 | 第一次撤销新输入，第二次恢复批量删除 |
| A 选段，B 在前面/中间插入新段，A 删除 | 只删原选中段，B 新段仍在；两端收敛 |
| A 选段，B 改其内容，A 复制 | 复制执行时的内容；不使用旧快照 |
| A 选段，B 删掉其中一段，A 删除 | 删除剩余有效引用，不误删邻段 |
| B 编辑未选段，A 删除/undo | B 编辑保留；恢复 A 的整批删除 |
| 全部段落被选中删除 | 始终有且只有一个可输入的空段；undo 恢复全部 |
| A 离线框选/删除后重连 | 本地可操作，重连正文收敛；不把 presence 当持久更新重放 |
| 分段、合段 | 高亮符合存活 Y 引用规则，新段不擅自加入 |

- [ ] 对“相邻输入与删除分组”测试，在首次 `openDocument` / goto **之前**调用 `await first.clock.setFixedTime(new Date('2026-09-24T00:00:00Z'))`，固定该页 Date.now 但让计时器继续运行，再打开、输入、拖动、删除、undo。当前 lib0 在模块加载时保存 `Date.now` 引用，因此不能等应用加载后才换时钟。这样不会因为测试操作慢于默认 500ms 合并窗口而假通过；不要用 pauseAt 冻结所有计时器或等待 501ms 来绕开分组验证。
- [ ] 补一个实际 UI 用例：输入文字后多次移动指针、选段并清除，再撤销一次，应直接撤销文字输入；临时操作不能多占 Undo 步数。代码审查确认 presence/选择更新路径只写 Awareness，不写 Y.Doc。不要仅测试 Yjs 库自身特性来冒充对本项目集成的验证。
- [ ] README 说明拖动起点、点外清除、批量操作/快捷键、鼠标为段内近似位置、选择不加锁，以及断线中的临时状态行为。不写成产品已支持任意复杂富文本或所有移动设备。
- [ ] 按顺序验证；不要并行运行使用相同输出目录的开发/生产 E2E：

```powershell
npm --prefix frontend run test -- tests/paragraphs.test.ts tests/session.test.ts
npm --prefix frontend run test:e2e -- presence.spec.ts paragraph-selection.spec.ts
powershell -File scripts/verify.ps1
git diff --check
```

预期各命令退出 0，且日志没有被 fixture 吞掉的退出异常。Playwright 如已有浏览器不可下载，可仅对当前进程设置 `PLAYWRIGHT_CHROMIUM_PATH` 指向现有 Chrome；不要修改全局配置或静默跳过浏览器测试。最终完整验证只需在代码稳定后跑一次，有新修改或失败再针对性重跑。

- [ ] 手动用真实中文输入法验证组合中收到远端更新、输入结束后光标正常；检查不同宽度、长段落、滚动、暗色模式及两个独立客户端。真实双设备 LAN/弱网未测就写未验证，不把自动浏览器断网扩大成实机网络质量保证。
- [ ] 提交：`feat: copy and delete selected paragraphs with collaborative undo`。交付报告给出四步提交、核心文件、实际测试结果及未验证项；按业务代码/测试/文档/lockfile 分开说明增量。不要擅自推送 GitHub。

## 计划完成判据

四步都有可运行结果与对应测试；既有恢复和粘贴回归仍通过；用户直接拖动即可选段，文字拖动未被抢占；多端显示与批量操作符合设计文档；没有重复的同步、存储或撤销实现。
