<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import * as Y from 'yjs'

import { ApiUnavailableError, DocumentMissingError, readDocument } from './api'
import {
  BACKUP_SCHEMA,
  backupFileName,
  parseBackup,
  serializeBackup,
  type ParsedBackup,
} from './backup'
import type { DocumentSession } from './session'

/**
 * 备份面板：导出当前正文、选择备份文件、只读预览、打开原文档、确认合并。
 *
 * 它的存在理由是浏览器同源隔离：换协议、主机名或端口后就是另一份本地存储，
 * 未同步的内容只能靠文件搬过去。面板本身不解析 CRDT——合并就是一次
 * `Y.applyUpdate`，复用现有的本地保存与 WebSocket 通路。
 */
const props = defineProps<{
  documentId: string | null
  session: DocumentSession | null
}>()

const emit = defineEmits<{ 'open-document': [documentId: string] }>()

const selected = ref<ParsedBackup | null>(null)
const selectedFileName = ref<string | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
const message = ref<string | null>(null)
const problem = ref<string | null>(null)
const busy = ref(false)
/** 手动复制用：无法下载时把文件内容放到只读文本框里。 */
const manualText = ref<string | null>(null)

/** 会话可编辑才谈得上导出与合并。 */
const canUseCurrentDocument = computed(
  () => props.session !== null && props.session.canMountEditor.value,
)

/** 选中的备份是不是当前这份文档。 */
const matchesCurrent = computed(
  () => selected.value !== null && props.documentId === selected.value.metadata.documentId,
)

const canMerge = computed(() => matchesCurrent.value && canUseCurrentDocument.value)

function clearFeedback(): void {
  message.value = null
  problem.value = null
}

// 切换文档时清掉上一份反馈，避免旧提示挂在新页面上。
watch(
  () => props.documentId,
  () => {
    clearFeedback()
  },
)

function resetSelection(): void {
  selected.value = null
  selectedFileName.value = null
  if (fileInput.value) fileInput.value.value = ''
}

async function onFileChosen(event: Event): Promise<void> {
  clearFeedback()
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return

  selectedFileName.value = file.name
  try {
    // 先看文件大小再看内容，避免为一个超大文件分配内存。
    if (file.size > 8 * 1024 * 1024) {
      throw new Error('备份文件过大，超过上限 8 MiB。')
    }
    const text = await file.text()
    selected.value = parseBackup(text)
  } catch (error) {
    resetSelection()
    problem.value = error instanceof Error ? error.message : String(error)
  }
}

async function exportBackup(): Promise<void> {
  clearFeedback()
  const session = props.session
  const documentId = props.documentId
  if (session === null || documentId === null || !session.canMountEditor.value) {
    problem.value = '当前没有可导出的文档内容。'
    return
  }

  try {
    // 直接读实时文档，因此离线也能导出——离线正是最需要导出的场景。
    const json = serializeBackup(documentId, session.doc, window.location.origin)
    const blob = new Blob([json], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = backupFileName(documentId, new Date().toISOString())
    anchor.click()
    // 延后回收，避免部分浏览器还没开始下载就被撤销。
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
    message.value = '备份文件已生成，请把它保存到你自己的位置。'
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    problem.value = reason
    // 无法生成下载时至少让用户能手动取走内容。
    try {
      manualText.value = serializeBackup(documentId, session.doc, window.location.origin)
    } catch {
      manualText.value = null
    }
  }
}

async function mergeBackup(): Promise<void> {
  clearFeedback()
  const targetSession = props.session
  const targetBackup = selected.value
  const targetId = props.documentId

  if (targetBackup === null || targetId === null || targetSession === null) return
  if (targetId !== targetBackup.metadata.documentId) {
    problem.value = '这份备份属于另一个文档，请先打开原文档。'
    return
  }
  if (!targetSession.canMountEditor.value) {
    problem.value = '当前正文还没准备好，暂时不能合并。'
    return
  }

  busy.value = true
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  try {
    // 合并前确认当前服务器上确实有这个文档：否则合并进去的内容没有归宿。
    await readDocument(targetId, controller.signal)
  } catch (error) {
    busy.value = false
    clearTimeout(timer)
    if (error instanceof DocumentMissingError) {
      problem.value =
        '当前服务器上没有这份文档。预览仍保留，你可以复制正文到自己新建的文档里。'
    } else if (error instanceof ApiUnavailableError) {
      problem.value = '无法连接服务端，合并需要服务器在线。'
    } else {
      problem.value = error instanceof Error ? error.message : String(error)
    }
    return
  }
  clearTimeout(timer)

  // 校验期间用户可能切了文档、换了文件：三者任一变化就放弃这次合并。
  if (
    props.session !== targetSession ||
    selected.value !== targetBackup ||
    props.documentId !== targetId ||
    !targetSession.canMountEditor.value
  ) {
    busy.value = false
    problem.value = '当前文档或备份已改变，请重新确认导入。'
    return
  }

  try {
    Y.applyUpdate(targetSession.doc, targetBackup.update, 'backup-import')
    message.value =
      '备份已合并到当前正文。这是合并，不是恢复到旧版本；服务器是否已持久化不由此操作确认。'
    resetSelection()
  } catch (error) {
    problem.value = `合并失败：${error instanceof Error ? error.message : String(error)}`
  } finally {
    busy.value = false
  }
}

function openOriginal(): void {
  const target = selected.value
  if (target === null) return
  // 只跳到原文档；路由变化不会自动导入，导入始终由用户显式确认。
  emit('open-document', target.metadata.documentId)
}

onBeforeUnmount(() => {
  clearFeedback()
})
</script>

<template>
  <section class="backup-panel" aria-labelledby="backup-title">
    <h2 id="backup-title" class="backup-title">备份与迁移</h2>
    <p class="info-text">
      换了协议、主机名或端口之后，浏览器会使用另一份本地存储，原来的离线内容不会自动跟过去。
      先在这里导出备份，再到新地址打开同一份文档并合并。
    </p>

    <div class="backup-actions">
      <button
        type="button"
        class="toolbar-button"
        :disabled="!canUseCurrentDocument"
        @click="exportBackup"
      >
        导出当前正文
      </button>

      <label class="toolbar-button backup-file-label">
        选择备份文件
        <input
          ref="fileInput"
          class="backup-file-input"
          type="file"
          accept=".json,application/json"
          @change="onFileChosen"
        />
      </label>
    </div>

    <p v-if="message !== null" class="info-text" role="status">{{ message }}</p>
    <p v-if="problem !== null" class="error-text" role="alert">{{ problem }}</p>

    <textarea
      v-if="manualText !== null"
      class="plain-text-fallback"
      aria-label="可手动复制的备份内容"
      readonly
      :value="manualText"
    ></textarea>

    <div v-if="selected !== null" class="backup-preview">
      <h3 class="backup-subtitle">待导入的备份</h3>
      <dl class="backup-meta">
        <dt>文档标识</dt>
        <dd><code>{{ selected.metadata.documentId }}</code></dd>
        <dt>来源地址</dt>
        <dd><code>{{ selected.metadata.sourceOrigin }}</code></dd>
        <dt>导出时间</dt>
        <dd>{{ selected.metadata.exportedAt }}</dd>
        <dt>正文结构</dt>
        <dd><code>{{ BACKUP_SCHEMA }}</code></dd>
        <dt v-if="selectedFileName !== null">文件名</dt>
        <dd v-if="selectedFileName !== null">{{ selectedFileName }}</dd>
      </dl>

      <p class="field-label">正文预览（只读）</p>
      <textarea
        class="plain-text-fallback"
        aria-label="备份正文预览"
        readonly
        :value="selected.previewText"
      ></textarea>

      <p v-if="!matchesCurrent" class="error-text" role="alert">
        这份备份属于另一个文档，不能合并到当前正文。请先打开原文档，文件会保留。
      </p>
      <p v-else-if="!canUseCurrentDocument" class="info-text">
        当前正文还没准备好；备份仍可预览，准备好之后再合并。
      </p>

      <div class="backup-actions">
        <button v-if="!matchesCurrent" type="button" class="toolbar-button" @click="openOriginal">
          打开原文档
        </button>
        <button
          v-else
          type="button"
          class="primary-button"
          :disabled="!canMerge || busy"
          @click="mergeBackup"
        >
          合并备份
        </button>
        <button type="button" class="toolbar-button" @click="resetSelection">清除选择</button>
      </div>

      <p v-if="matchesCurrent" class="info-text">
        合并会把备份里的内容并入当前正文（包含删除），不是恢复到旧版本。
      </p>
    </div>
  </section>
</template>
