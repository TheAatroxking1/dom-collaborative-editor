<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'

import { ApiUnavailableError, createDocument, readDocument } from './documents/api'
import { openDocumentSession, type DocumentSession } from './documents/session'
import EditorPane from './editor/EditorPane.vue'
import { offlineState } from './offline'

/** 使用 hash 路由，因此不需要服务端为任意前端路径提供回退。 */
const ROUTE_PREFIX = '#/documents/'

const documentId = ref<string | null>(null)
const session = shallowRef<DocumentSession | null>(null)
/** 每次成功打开递增，用作编辑器的 key，保证视图不会被接到别的会话上。 */
const sessionKey = ref(0)
const opening = ref(false)
const routeError = ref<string | null>(null)
const linkInput = ref('')
const linkError = ref<string | null>(null)

/**
 * 打开代次：路由每次变化都会递增。
 *
 * 异步打开的结果如果已经过期就立即释放，绝不覆盖当前会话——否则快速切换文档时
 * 会出现「地址栏是 B、正文和编辑目标还是 A」的串会话问题。
 */
let openGeneration = 0

const shareLink = computed(() =>
  documentId.value === null
    ? ''
    : `${window.location.origin}${window.location.pathname}${ROUTE_PREFIX}${documentId.value}`,
)

const connectionText = computed((): string => {
  if (opening.value) return '正在打开…'
  const current = session.value
  if (current === null) return ''
  switch (current.connection.value) {
    case 'connected':
      return '已连接'
    case 'connecting':
      return '正在连接…'
    default:
      return '连接中断，可继续编辑'
  }
})

const statusText = computed(() => session.value?.error.value ?? routeError.value ?? '')

const canMount = computed(
  () => session.value !== null && session.value.canMountEditor.value,
)

function routeFromHash(): string | null {
  const hash = window.location.hash
  if (!hash.startsWith(ROUTE_PREFIX)) return null
  const value = hash.slice(ROUTE_PREFIX.length)
  return value.length > 0 ? decodeURIComponent(value) : null
}

async function applyRoute(): Promise<void> {
  const next = routeFromHash()
  const generation = (openGeneration += 1)

  // 立即释放旧会话；清理带超时上限，不阻塞新的打开流程。
  const previous = session.value
  session.value = null
  if (previous !== null) void previous.close()

  documentId.value = next
  routeError.value = null

  if (next === null) {
    opening.value = false
    return
  }

  opening.value = true

  // 先恢复本地缓存，再校验文档是否存在。
  //
  // 顺序不能颠倒：HTTP 校验在服务端断开时必然失败，如果因为它失败就直接退出，
  // 本地缓存里的正文就永远没机会恢复，「断线仍可编辑、刷新不丢内容」这条能力
  // 会被整体破坏。所以先拿到会话，再决定要不要因为服务端的状态放弃它。
  let opened: DocumentSession
  try {
    opened = await openDocumentSession(next)
  } catch (error) {
    if (generation !== openGeneration) return
    opening.value = false
    routeError.value = error instanceof Error ? error.message : String(error)
    return
  }

  if (generation !== openGeneration) {
    // 结果已过期：释放掉，不要覆盖当前会话。
    void opened.close()
    return
  }

  // 本地已经有正文：即便服务端不可达也允许继续编辑。
  if (opened.canMountEditor.value) {
    session.value = opened
    sessionKey.value += 1
    opening.value = false
    return
  }

  // 本地没有正文，必须由服务端提供种子；此时校验文档是否存在。
  try {
    await readDocument(next)
    if (generation !== openGeneration) {
      void opened.close()
      return
    }
  } catch (error) {
    if (generation !== openGeneration) {
      void opened.close()
      return
    }
    await opened.close()
    opening.value = false
    routeError.value = error instanceof Error ? error.message : String(error)
    return
  }

  session.value = opened
  sessionKey.value += 1
  opening.value = false
}

onMounted(() => {
  window.addEventListener('hashchange', () => void applyRoute())
  void applyRoute()
})

onBeforeUnmount(() => {
  window.removeEventListener('hashchange', () => void applyRoute())
  openGeneration += 1
  const current = session.value
  session.value = null
  if (current !== null) void current.close()
})

async function newDocument(): Promise<void> {
  linkError.value = null
  try {
    const meta = await createDocument()
    window.location.hash = `${ROUTE_PREFIX}${meta.documentId}`
  } catch (error) {
    linkError.value =
      error instanceof ApiUnavailableError ? error.message : String(error)
  }
}

function openLink(): void {
  const value = linkInput.value.trim()
  if (value.length === 0) return
  const marker = value.indexOf(ROUTE_PREFIX)
  const id = marker >= 0 ? value.slice(marker + ROUTE_PREFIX.length) : value
  if (id.length === 0) {
    linkError.value = '链接里没有文档标识'
    return
  }
  linkError.value = null
  window.location.hash = `${ROUTE_PREFIX}${id}`
}

async function copyLink(): Promise<void> {
  try {
    await navigator.clipboard.writeText(shareLink.value)
  } catch {
    linkError.value = `无法访问剪贴板，请手动复制：${shareLink.value}`
  }
}

function retry(): void {
  const current = session.value
  if (current !== null) {
    current.retry()
    return
  }
  // 会话根本没建立起来（本地恢复失败或 HTTP 校验失败）：重新走一次打开流程。
  void applyRoute()
}
</script>

<template>
  <main class="app">
    <!--
      版本提示放在最外层：编辑过程中也要看得见。
      刻意不提供「立即更新」按钮——自动刷新会打断正在写的人，也会让页面状态与
      本地内容的关系变得难以解释。用户自己决定什么时候关闭全部页面重开。
    -->
    <p v-if="offlineState.updateAvailable.value" class="notice-text" role="status">
      新版本已准备好。结束编辑后，关闭本应用的所有页面再重新打开即可更新；
      需要保留一份副本时可先导出备份。
    </p>

    <template v-if="documentId === null">
      <section class="home" aria-labelledby="home-title">
        <h1 id="home-title">协作文档编辑器</h1>
        <p class="home-hint">
          创建文档后把链接发给另一个人，两个浏览器就能在同一段文字里一起编辑。
        </p>
        <!--
          只描述「页面资源已缓存」。正文能否离线恢复取决于当前浏览器在当前地址
          下是否打开过该文档并写入过本地缓存，这是另一件事，不合并成一句承诺。
        -->
        <p v-if="offlineState.pageCacheReady.value" class="info-text">
          页面资源已缓存，断网后仍可打开本页面。已经在本地址打开过的文档，断网后也能继续查看和编辑；
          首次访问需要联网，浏览器清除站点数据后需要重新缓存。
        </p>
        <p v-else-if="offlineState.offlineUnavailableReason.value !== null" class="info-text">
          {{ offlineState.offlineUnavailableReason.value }}
        </p>
        <div class="home-actions">
          <button type="button" class="primary-button" @click="newDocument">新建文档</button>
        </div>
        <div class="home-open">
          <label class="field-label" for="document-link">打开已有文档链接</label>
          <input
            id="document-link"
            v-model="linkInput"
            class="text-input"
            type="text"
            placeholder="粘贴协作链接或文档标识"
            @keyup.enter="openLink"
          />
          <button type="button" class="toolbar-button" @click="openLink">打开</button>
        </div>
        <p v-if="linkError !== null" class="error-text" role="alert">{{ linkError }}</p>
      </section>
    </template>

    <template v-else>
      <header class="document-header">
        <div class="document-title">
          <h1 id="document-title">协作文档</h1>
          <code class="document-id">{{ documentId }}</code>
        </div>
        <div class="document-actions">
          <button type="button" class="toolbar-button" @click="copyLink">复制协作链接</button>
        </div>
      </header>

      <p class="connection-status" role="status" aria-live="polite">{{ connectionText }}</p>

      <p v-if="statusText.length > 0" class="error-text" role="alert">{{ statusText }}</p>
      <p v-if="statusText.length > 0" class="document-actions">
        <button type="button" class="toolbar-button" @click="retry">重试</button>
      </p>

      <EditorPane
        v-if="canMount && session !== null"
        :key="sessionKey"
        :doc="session.doc"
      />
      <p v-else-if="!opening && statusText.length === 0" class="info-text">
        正在等待服务端提供文档正文…
      </p>
    </template>
  </main>
</template>
