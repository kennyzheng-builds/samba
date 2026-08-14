import { createDecipheriv } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { beforeEach, describe, expect, it, vi } from 'vitest'

const fetchMock = vi.fn()
vi.mock('electron', () => ({
  net: { fetch: (...args: unknown[]) => fetchMock(...args) }
}))

import { WeixinBot } from '../wechat/WeChatProtocol'

const CDN_DOWNLOAD_PARAM = 'AAFFc8c2PXQ5mKPw7rbcH7S1EA='

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    text: async () => JSON.stringify(body)
  }
}

interface CapturedSend {
  uploadRequest: {
    rawsize: number
    filesize: number
    aeskey: string
    no_need_thumb: boolean
  }
  uploadedBytes: Buffer
  imageItem: {
    media: { encrypt_query_param: string; aes_key: string; encrypt_type: number }
    mid_size: number
  }
}

/** Drive a full sendImage() round-trip against a mocked iLink API + CDN, capturing the wire payloads. */
async function sendImage(imageData: Buffer): Promise<CapturedSend> {
  const dir = mkdtempSync(path.join(tmpdir(), 'wechat-protocol-'))
  const tokenPath = path.join(dir, 'bot.json')
  writeFileSync(
    tokenPath,
    JSON.stringify({ token: 't', baseUrl: 'https://ilinkai.weixin.qq.com', accountId: 'bot', userId: 'me' })
  )

  const captured: Partial<CapturedSend> = {}

  fetchMock.mockImplementation(async (url: string, init: { body?: unknown }) => {
    if (url.endsWith('/ilink/bot/getuploadurl')) {
      captured.uploadRequest = JSON.parse(init.body as string)
      return jsonResponse({ upload_param: 'UPLOAD_PARAM' })
    }
    if (url.includes('/c2c/upload')) {
      captured.uploadedBytes = Buffer.from(init.body as Uint8Array)
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'x-encrypted-param': CDN_DOWNLOAD_PARAM }),
        text: async () => ''
      }
    }
    if (url.endsWith('/ilink/bot/sendmessage')) {
      const sent = JSON.parse(init.body as string)
      captured.imageItem = sent.msg.item_list[0].image_item
      return jsonResponse({ ret: 0 })
    }
    throw new Error(`Unexpected fetch to ${url}`)
  })

  await new WeixinBot({ tokenPath }).sendImage('user@im.wechat', imageData)

  return captured as CapturedSend
}

describe('WeixinBot.sendImage', () => {
  beforeEach(() => {
    fetchMock.mockReset()
  })

  it('declares the ciphertext size the CDN actually receives', async () => {
    // 1000 bytes is not a multiple of 16, so plaintext and ciphertext sizes differ.
    const { uploadRequest, uploadedBytes, imageItem } = await sendImage(Buffer.alloc(1000, 7))

    expect(uploadRequest.rawsize).toBe(1000)
    expect(uploadRequest.filesize).toBe(uploadedBytes.length)
    expect(imageItem.mid_size).toBe(uploadedBytes.length)
  })

  it('sends media.aes_key as base64 of the hex key so receiving clients can decrypt', async () => {
    const imageData = Buffer.from('\xff\xd8\xff\xe0 fake jpeg payload', 'latin1')
    const { uploadRequest, uploadedBytes, imageItem } = await sendImage(imageData)

    const decodedKeyField = Buffer.from(imageItem.media.aes_key, 'base64').toString('ascii')
    expect(decodedKeyField).toMatch(/^[0-9a-f]{32}$/)
    expect(decodedKeyField).toBe(uploadRequest.aeskey)

    const decipher = createDecipheriv('aes-128-ecb', Buffer.from(decodedKeyField, 'hex'), null)
    const decrypted = Buffer.concat([decipher.update(uploadedBytes), decipher.final()])
    expect(decrypted.equals(imageData)).toBe(true)
    expect(imageItem.media.encrypt_query_param).toBe(CDN_DOWNLOAD_PARAM)
  })
})
