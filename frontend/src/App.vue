<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import * as Y from 'yjs'

import { SAVE_STATE_TEXT } from './collab/save-state'
import { ApiUnavailableError, DocumentMissingError, createDocument } from './documents/api'
import { openDocumentSession, type DocumentSession } from './documents/session'
import EditorPane from './editor/EditorPane.vue'

/** 使用 hash 路由，因此不需要服务端为任意前端路径提供回退。 */
const ROUTE_PREFIX = '#/documents/'

const documentId = ref<string | null>(null)
const session = shallowRef<DocumentSession | null>(null)
const sessionError = ref<string | null>(null)
const busy = ref(false)
const linkInput = ref('')
const copyState = ref<'idle' | 'copied' | 'failed'>('idle')
const plainTextFallback = ref<string | null>(null)

const shareLink = computed(() =>
  documentId.value === null ? '' : `${window.location.origin}${window.location.pathname}${ROUTE_PREFIX}${documentId.value}`,
)

const saveText = computed(() =>
  session.value === null ? '' : SAVE_STATE_TEXT[session.value.state.value.save],
)

const connectionText = computed(() => {
  if (session.value === null) return ''
  return session.value.state.value.connected ? '已连接同步服务' : '未连接同步服务'
})

const canMount = computed(() => session.value?.canMountEditor.value === true)
const paused = computed(() => session.value?.state.value.paused === true)
const events = computed(() => session.value?.events.value ?? [])

const showMissingDocument = computed(() => {
  if (session.value === null) return false
  if (session.value.canMountEditor.value) return false
  return session.value.state.value.message?.includes('DOCUMENT_NOT_FOUND') === true
})

function routeFromHash(): string | null {
  const hash = window.location.hash
  if (!hash.startsWith(ROUTE_PREFIX)) return null
  const value = hash.slice(ROUTE_PREFIX.length)
  return value.length > 0 ? decodeURIComponent(value) : null
}

async function closeSession(): Promise<void> {
  const current = session.value
  session.value = null
  if (current !== null) await current.close()
}

async function applyRoute(): Promise<void> {
  const next = routeFromHash()
  if (next === documentId.value) return
  await closeSession()
  documentId.value = next
  sessionError.value = null
  copyState.value = 'idle'
  plainTextFallback.value = null
  if (next === null) return
  try {
    session.value = await openDocumentSession(next)
  } catch (error) {
    sessionError.value = error instanceof Error ? error.message : String(error)
  }
}

onMounted(() => {
  window.addEventListener('hashchange', () => void applyRoute())
  void applyRoute()
})

onBeforeUnmount(() => {
  window.removeEventListener('hashchange', () => void applyRoute())
  void closeSession()
})

async function newDocument(): Promise<void> {
  if (busy.value) return
  busy.value = true
  sessionError.value = null
  try {
    const meta = await createDocument()
    window.location.hash = `${ROUTE_PREFIX}${meta.documentId}`
  } catch (error) {
    sessionError.value =
      error instanceof DocumentMissingError || error instanceof ApiUnavailableError
        ? error.message
        : String(error)
  } finally {
    busy.value = false
  }
}

function openLink(): void {
  const value = linkInput.value.trim()
  if (value.length === 0) return
  const marker = value.indexOf(ROUTE_PREFIX)
  const id = marker >= 0 ? value.slice(marker + ROUTE_PREFIX.length) : value
  if (id.length === 0) {
    sessionError.value = '链接里没有文档标识'
    return
  }
  window.location.hash = `${ROUTE_PREFIX}${id}`
}

async function copyLink(): Promise<void> {
  try {
    await navigator.clipboard.writeText(shareLink.value)
    copyState.value = 'copied'
  } catch {
    // 复制失败时提供可选中的纯文本，而不是假装已经复制。
    copyState.value = 'failed'
    plainTextFallback.value = shareLink.value
  }
}

function retry(): void {
  session.value?.retry()
}

/** 服务端保存失败或本地存储失败时，让用户能把正文复制出去。 */
async function copyBody(): Promise<void> {
  const value = plainBody()
  try {
    await navigator.clipboard.writeText(value)
    copyState.value = 'copied'
  } catch {
    copyState.value = 'failed'
    plainTextFallback.value = value
  }
}

function plainBody(): string {
  const current = session.value
  if (current === null) return ''
  return current.doc
    .getXmlFragment('body')
    .toArray()
    .map((node) => {
      if (!(node instanceof Y.XmlElement)) return ''
      return node
        .toArray()
        .map((child) => (child instanceof Y.XmlText ? child.toString() : ''))
        .join('')
    })
    .join('\n')
}

watch(
  () => session.value?.state.value.message ?? null,
  (message) => {
    if (message !== null && message.length > 0) sessionError.value = message
  },
)
</script>

<template>
  <main class="app">
    <template v-if="documentId === null">
      <section class="home" aria-labelledby="home-title">
        <h1 id="home-title">协作文档编辑器</h1>
        <p class="home-hint">
          创建文档后把链接发给另一个人，两个浏览器就能在同一段文字里一起编辑。
        </p>
        <div class="home-actions">
          <button type="button" class="primary-button" :disabled="busy" @click="newDocument">
            新建文档
          </button>
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
        <p v-if="sessionError !== null" class="error-text" role="alert">{{ sessionError }}</p>
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
          <button type="button" class="toolbar-button" @click="copyBody">复制正文</button>
        </div>
      </header>

      <p
        class="save-status"
        :data-save-state="session?.state.value.save ?? 'restoring'"
        role="status"
        aria-live="polite"
      >
        {{ saveText }}
      </p>
      <p class="connection-status">{{ connectionText }}</p>

      <p v-if="copyState === 'copied'" class="info-text">已复制到剪贴板</p>
      <p v-else-if="copyState === 'failed'" class="error-text">
        无法访问剪贴板，请手动复制下面的内容
      </p>
      <textarea
        v-if="plainTextFallback !== null"
        class="plain-text-fallback"
        aria-label="可复制的纯文本"
        readonly
        :value="plainTextFallback"
      ></textarea>

      <p v-if="showMissingDocument" class="error-text" role="alert">文档不存在</p>
      <template v-else-if="canMount">
        <EditorPane v-if="session !== null" :doc="session.doc" :paused="paused" />
        <p v-if="paused" class="error-text" role="alert">
          待同步内容过多，已暂停新增编辑。已有内容仍保存在本地。
        </p>
      </template>
      <p v-else class="info-text">正在等待服务端提供文档正文…</p>

      <p v-if="sessionError !== null && !showMissingDocument" class="error-text" role="alert">
        {{ sessionError }}
      </p>
      <p v-if="sessionError !== null || paused" class="document-actions">
        <button type="button" class="toolbar-button" @click="retry">重试</button>
      </p>

      <details class="debug-panel">
        <summary>技术详情</summary>
        <ul class="debug-events">
          <li v-for="(event, index) in events" :key="index">
            <span class="debug-kind">{{ event.kind }}</span>
            <span class="debug-detail">{{ event.detail }}</span>
          </li>
        </ul>
      </details>
    </template>
  </main>
</template>
