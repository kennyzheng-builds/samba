import http from 'node:http'
import net from 'node:net'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { NodeProxyController } from '../NodeProxyController'

/**
 * These run against a real CONNECT proxy in front of a real origin, because what they cover is
 * invisible to a mock: a proxy URL reaching this controller is what makes in-process `fetch`
 * (the Pi agent runtime drives its provider SDKs on it) leave through the proxy at all. Only an
 * actual connection can tell "routed through the proxy" from "quietly connected directly".
 */
describe('NodeProxyController — fetch routing', () => {
  const listen = (server: http.Server) =>
    new Promise<number>((resolve) =>
      server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port))
    )

  let origin: http.Server
  let proxy: http.Server
  let originPort: number
  let proxyUrl: string
  let tunnelled: string[]
  let controller: NodeProxyController

  beforeEach(async () => {
    tunnelled = []
    origin = http.createServer((_request, response) => {
      response.writeHead(200)
      response.end('from-origin')
    })
    originPort = await listen(origin)

    proxy = http.createServer()
    proxy.on('connect', (request, clientSocket, head) => {
      tunnelled.push(request.url ?? '')
      const upstream = net.connect(originPort, '127.0.0.1', () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head?.length) upstream.write(head)
        upstream.pipe(clientSocket)
        clientSocket.pipe(upstream)
      })
      upstream.on('error', () => clientSocket.destroy())
    })
    proxyUrl = `http://127.0.0.1:${await listen(proxy)}`

    controller = new NodeProxyController()
  })

  afterEach(async () => {
    await controller.configure({ proxyRules: undefined })
    await Promise.all([new Promise((resolve) => origin.close(resolve)), new Promise((resolve) => proxy.close(resolve))])
  })

  it('sends fetch through the proxy, so an in-process runtime reaches a proxy-only endpoint', async () => {
    await controller.configure({ proxyRules: proxyUrl })

    // A host that resolves nowhere: reaching the origin proves the proxy carried the request.
    const response = await fetch('http://proxy-only.invalid/')

    expect(await response.text()).toBe('from-origin')
    expect(tunnelled).toEqual(['proxy-only.invalid:80'])
  })

  it('keeps bypassed hosts direct, so a local model server is not tunnelled', async () => {
    await controller.configure({ proxyRules: proxyUrl, proxyBypassRules: '127.0.0.1' })

    const response = await fetch(`http://127.0.0.1:${originPort}/`)

    expect(await response.text()).toBe('from-origin')
    expect(tunnelled).toEqual([])
  })

  it('restores direct fetch when the proxy is turned off', async () => {
    await controller.configure({ proxyRules: proxyUrl })
    await controller.configure({ proxyRules: undefined })

    await expect(fetch('http://proxy-only.invalid/')).rejects.toThrow()
    expect(tunnelled).toEqual([])
  })
})
