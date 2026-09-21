/**
 * 保存状态的纯函数规则。
 *
 * 抽成纯函数是为了让“什么时候能说已保存”只由输入决定，不受网络事件的到达
 * 顺序影响：错误不被连接成功覆盖，远端 ACK 到达也不等于本地确认已持久化。
 */

export type SaveInputs = {
  restored: boolean
  connected: boolean
  ready: boolean
  localWrites: number
  unacknowledged: number
  localError: boolean
  remoteError: boolean
}

export type SaveState =
  | 'restoring'
  | 'saving-local'
  | 'local-only'
  | 'saved'
  | 'local-error'
  | 'remote-error'

export const SAVE_STATE_TEXT: Record<SaveState, string> = {
  restoring: '正在恢复本地内容',
  'saving-local': '正在保存到本地',
  'local-only': '已保存到本地，等待同步',
  saved: '服务端已保存',
  'local-error': '本地保存失败',
  'remote-error': '服务端保存失败',
}

export function deriveSaveState(inputs: SaveInputs): SaveState {
  // 错误优先：恢复成功或重新连上都不能把失败状态盖掉，否则会误报已保存。
  if (inputs.localError) return 'local-error'
  if (inputs.remoteError) return 'remote-error'
  if (!inputs.restored) return 'restoring'
  if (inputs.localWrites > 0) return 'saving-local'
  // 只有握手完成、并且所有本地修改都拿到持久化确认，才能说服务端已保存。
  if (!inputs.connected || !inputs.ready || inputs.unacknowledged > 0) return 'local-only'
  return 'saved'
}
