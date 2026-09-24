import { afterEach, describe, expect, it, vi } from 'vitest'

import { createShareLink, isLocalHostname, readShareHosts } from '../src/shareLink'

afterEach(() => vi.unstubAllGlobals())

describe('局域网协作链接', () => {
  it.each(['localhost', 'localhost.', 'demo.localhost.', 'demo.localhost', '127.0.0.1', '127.1.2.3', '[::1]', '0.0.0.0', '[::]'])(
    '识别不可直接分享给另一台设备的地址 %s', (hostname) => {
      expect(isLocalHostname(hostname)).toBe(true)
    },
  )

  it('本机地址改为所选局域网 IP，保留协议、端口、路径和当前文档', () => {
    expect(createShareLink('https://localhost:5274/editor/?theme=dark#/documents/old', 'new-id', '192.168.1.10'))
      .toBe('https://192.168.1.10:5274/editor/?theme=dark#/documents/new-id')
  })

  it.each([undefined, '', '127.0.0.1', '0.0.0.0', 'evil.example', '192.168.1.300', '192.168.001.10', '10.0.0.1:9999'])(
    '没有有效局域网地址时不生成误导性的链接：%s', (host) => {
      expect(createShareLink('http://127.0.0.1:5274/', 'id', host)).toBe('')
    },
  )

  it.each(['http://192.168.1.10:5274/', 'https://editor.example.org/docs/', 'http://127.example.org:5274/', 'http://[fd00::1]:5274/'])(
    '已经通过局域网或域名访问时保留原地址：%s', (href) => {
      expect(createShareLink(href, 'doc', '10.0.0.99')).toBe(`${href}#/documents/doc`)
    },
  )

  it('从服务端读取候选地址，去重并过滤非法与非局域网地址', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      hosts: ['192.168.1.10', '192.168.1.10', '10.0.0.2', '172.16.0.1', '172.31.1.1', '172.32.0.1', '8.8.8.8', '127.0.0.1', 'host.invalid', 123],
    })))
    vi.stubGlobal('fetch', fetch)
    expect(await readShareHosts()).toEqual(['192.168.1.10', '10.0.0.2', '172.16.0.1', '172.31.1.1'])
    expect(fetch).toHaveBeenCalledWith('/api/share-addresses', expect.objectContaining({
      cache: 'no-store', signal: expect.any(AbortSignal),
    }))
  })

  it('接口失败时明确报错，不回退成 localhost', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 503 })))
    await expect(readShareHosts()).rejects.toThrow('503')
  })
})
