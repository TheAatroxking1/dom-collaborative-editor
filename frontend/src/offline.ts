import { readonly, ref, type Ref } from 'vue'

/**
 * 页面外壳的缓存状态与版本提示。
 *
 * 这个模块只管「页面资源」：Service Worker 是否已缓存好构建产物、是否有新版本
 * 在等待生效。它不接触 Y.Doc、IndexedDB 或编辑器实例，也不提供任何「正文已保存」
 * 的含义——页面缓存好了不代表正文写进了服务器。
 */

/** 页面资源已缓存，断网后仍可打开。 */
const pageCacheReady = ref(false)
/** 有新版本在等待生效（关闭全部页面后重新打开才会用上）。 */
const updateAvailable = ref(false)
/** 无法启用离线页面缓存时的具体原因；为空表示没有发现问题。 */
const offlineUnavailableReason = ref<string | null>(null)
/** 限制来自当前访问地址（而非开发模式）：这才是用户需要知道的那种限制。 */
const addressLimitsOfflineCache = ref(false)

const NOT_BUILT = '离线页面缓存只在构建版启用；开发模式请忽略这一项。'
const NOT_SECURE =
  '当前地址不是安全上下文，无法启用离线页面缓存。局域网内使用 HTTPS 才能完整离线刷新。'
const NO_SERVICE_WORKER = '当前浏览器不支持 Service Worker，无法缓存页面资源。'

let started = false

/** 只读状态，供界面展示。 */
export const offlineState: {
  pageCacheReady: Readonly<Ref<boolean>>
  updateAvailable: Readonly<Ref<boolean>>
  offlineUnavailableReason: Readonly<Ref<string | null>>
  addressLimitsOfflineCache: Readonly<Ref<boolean>>
} = {
  pageCacheReady: readonly(pageCacheReady),
  updateAvailable: readonly(updateAvailable),
  offlineUnavailableReason: readonly(offlineUnavailableReason),
  addressLimitsOfflineCache: readonly(addressLimitsOfflineCache),
}

function markUnavailableByAddress(reason: string): void {
  offlineUnavailableReason.value = reason
  addressLimitsOfflineCache.value = true
}

/** 在测试或特殊环境下标记为不可用。 */
export function markOfflineUnavailable(reason: string): void {
  offlineUnavailableReason.value = reason
}

/** 已安装的 SW 在后续访问中恢复状态用：内核已经控制本页即视为缓存就绪。 */
function restoreReadyState(): void {
  if (typeof navigator === 'undefined') return
  if (navigator.serviceWorker?.controller) {
    pageCacheReady.value = true
  }
}

/**
 * 注册页面外壳的 Service Worker。重复调用无副作用。
 *
 * 只在生产构建、安全上下文且浏览器支持时注册；其余情况给出准确原因，
 * 并且不阻塞编辑器加载——断网刷新不可用只是少了一项能力。
 */
export function registerOfflineShell(): void {
  if (started) return
  started = true

  if (typeof window === 'undefined') return

  if (!import.meta.env.PROD) {
    offlineUnavailableReason.value = NOT_BUILT
    return
  }
  if (!window.isSecureContext) {
    markUnavailableByAddress(NOT_SECURE)
    return
  }
  if (!('serviceWorker' in navigator)) {
    markUnavailableByAddress(NO_SERVICE_WORKER)
    return
  }

  // 已经有 worker 控制本页时先恢复状态，避免只依赖首次的 onOfflineReady 回调。
  restoreReadyState()
  navigator.serviceWorker.addEventListener('controllerchange', restoreReadyState)

  void import('virtual:pwa-register')
    .then(({ registerSW }) => {
      registerSW({
        immediate: true,
        onOfflineReady() {
          pageCacheReady.value = true
        },
        onNeedRefresh() {
          updateAvailable.value = true
        },
        // 只标记有更新，绝不调用返回的更新函数、不自动 reload。
        onNeedReload() {
          updateAvailable.value = true
        },
        onRegisterError() {
          offlineUnavailableReason.value = '页面缓存注册失败，当前不能保证离线刷新。'
        },
      })
    })
    .catch(() => {
      offlineUnavailableReason.value = '页面缓存注册失败，当前不能保证离线刷新。'
    })
}
