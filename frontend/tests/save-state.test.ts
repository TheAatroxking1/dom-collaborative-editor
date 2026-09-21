import { describe, expect, test } from 'vitest'
import { deriveSaveState, type SaveInputs } from '../src/collab/save-state'

const base: SaveInputs = {
  restored: true,
  connected: true,
  ready: true,
  localWrites: 0,
  unacknowledged: 0,
  localError: false,
  remoteError: false,
}

describe('保存状态', () => {
  test('尚未恢复时不报告任何已保存状态', () => {
    expect(deriveSaveState({ ...base, restored: false })).toBe('restoring')
  })

  test('本地写入未完成时先报告正在保存到本地', () => {
    expect(deriveSaveState({ ...base, localWrites: 1 })).toBe('saving-local')
  })

  test('本地写入期间即使断网也仍报告正在保存到本地', () => {
    expect(deriveSaveState({ ...base, localWrites: 2, connected: false })).toBe(
      'saving-local',
    )
  })

  test('本地已写完但未连接时是等待同步', () => {
    expect(deriveSaveState({ ...base, connected: false })).toBe('local-only')
  })

  test('握手未完成时不能声称服务端已保存', () => {
    expect(deriveSaveState({ ...base, ready: false })).toBe('local-only')
  })

  test('存在未确认事务时不能声称服务端已保存', () => {
    expect(deriveSaveState({ ...base, unacknowledged: 1 })).toBe('local-only')
  })

  test('全部条件满足才报告服务端已保存', () => {
    expect(deriveSaveState(base)).toBe('saved')
  })

  test('本地存储失败优先于一切，且不被连接成功覆盖', () => {
    expect(deriveSaveState({ ...base, localError: true })).toBe('local-error')
    expect(
      deriveSaveState({ ...base, localError: true, restored: false, localWrites: 3 }),
    ).toBe('local-error')
  })

  test('服务端存储失败优先于已保存，但让位于本地失败', () => {
    expect(deriveSaveState({ ...base, remoteError: true })).toBe('remote-error')
    expect(deriveSaveState({ ...base, remoteError: true, localError: true })).toBe(
      'local-error',
    )
  })

  test('错误状态下即使仍未恢复也报告错误而不是恢复中', () => {
    expect(deriveSaveState({ ...base, restored: false, remoteError: true })).toBe(
      'remote-error',
    )
  })

  test('断开连接不会把错误状态改成等待同步', () => {
    expect(
      deriveSaveState({ ...base, connected: false, ready: false, remoteError: true }),
    ).toBe('remote-error')
  })
})
