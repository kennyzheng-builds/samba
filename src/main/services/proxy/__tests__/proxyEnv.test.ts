import { describe, expect, it } from 'vitest'

import {
  buildNodeProxyEnvironment,
  getProxyEnvironment,
  getProxyProtocol,
  resolveEnvironmentProxyConfig
} from '../proxyEnv'

describe('proxyEnv', () => {
  it('exports standard HTTP proxy env vars for http proxies', () => {
    const env = buildNodeProxyEnvironment({
      proxyRules: 'http://127.0.0.1:7890',
      proxyBypassRules: 'localhost,*.local'
    })

    expect(env.HTTP_PROXY).toBe('http://127.0.0.1:7890')
    expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:7890')
    expect(env.http_proxy).toBe('http://127.0.0.1:7890')
    expect(env.https_proxy).toBe('http://127.0.0.1:7890')
    expect(env.ALL_PROXY).toBe('http://127.0.0.1:7890')
    expect(env.NO_PROXY).toBe('localhost,*.local')
    expect(env.no_proxy).toBe('localhost,*.local')
  })

  it('exports only socks-compatible env vars for socks proxies', () => {
    const env = buildNodeProxyEnvironment({
      proxyRules: 'socks5://127.0.0.1:6153',
      proxyBypassRules: 'localhost,*.local'
    })

    expect(env.SOCKS_PROXY).toBe('socks5://127.0.0.1:6153')
    expect(env.socks_proxy).toBe('socks5://127.0.0.1:6153')
    expect(env.ALL_PROXY).toBe('socks5://127.0.0.1:6153')
    expect(env.all_proxy).toBe('socks5://127.0.0.1:6153')
    expect(env.HTTP_PROXY).toBeUndefined()
    expect(env.HTTPS_PROXY).toBeUndefined()
    expect(env.http_proxy).toBeUndefined()
    expect(env.https_proxy).toBeUndefined()
    expect(env.NO_PROXY).toBe('localhost,*.local')
    expect(env.no_proxy).toBe('localhost,*.local')
  })

  it('returns empty env when proxy rules are missing', () => {
    expect(buildNodeProxyEnvironment({})).toEqual({})
  })

  it('omits no_proxy env vars when bypass rules are missing', () => {
    const env = buildNodeProxyEnvironment({
      proxyRules: 'http://127.0.0.1:7890'
    })

    expect(env.NO_PROXY).toBeUndefined()
    expect(env.no_proxy).toBeUndefined()
  })

  it('returns null for invalid proxy urls when detecting protocol', () => {
    expect(getProxyProtocol('127.0.0.1:7890')).toBe(null)
  })

  it('extracts only proxy-related env vars', () => {
    expect(
      getProxyEnvironment({
        HTTP_PROXY: 'http://127.0.0.1:7890',
        NO_PROXY: 'localhost',
        PATH: '/usr/bin'
      })
    ).toEqual({
      HTTP_PROXY: 'http://127.0.0.1:7890',
      NO_PROXY: 'localhost'
    })
  })
})

describe('resolveEnvironmentProxyConfig', () => {
  it('returns null when the environment defines no proxy', () => {
    expect(resolveEnvironmentProxyConfig({ PATH: '/usr/bin', HTTPS_PROXY: '   ' })).toBe(null)
  })

  it('prefers the https proxy, which is the one an https API endpoint needs', () => {
    expect(
      resolveEnvironmentProxyConfig({ HTTP_PROXY: 'http://plain:1', HTTPS_PROXY: 'http://secure:2' })?.proxyRules
    ).toBe('http://secure:2')
  })

  it('falls back to the http and all-proxy variables when no https proxy is exported', () => {
    expect(resolveEnvironmentProxyConfig({ http_proxy: 'http://plain:1' })?.proxyRules).toBe('http://plain:1')
    expect(resolveEnvironmentProxyConfig({ ALL_PROXY: 'socks5://any:3' })?.proxyRules).toBe('socks5://any:3')
  })

  it('keeps loopback direct so a local model server is not pushed through the proxy', () => {
    expect(resolveEnvironmentProxyConfig({ HTTPS_PROXY: 'http://secure:2' })?.proxyBypassRules).toBe(
      'localhost,127.0.0.1,::1'
    )
  })

  it('keeps the user bypass rules and appends loopback without duplicating it', () => {
    expect(
      resolveEnvironmentProxyConfig({ HTTPS_PROXY: 'http://secure:2', NO_PROXY: '*.internal, localhost' })
        ?.proxyBypassRules
    ).toBe('*.internal,localhost,127.0.0.1,::1')
  })
})
