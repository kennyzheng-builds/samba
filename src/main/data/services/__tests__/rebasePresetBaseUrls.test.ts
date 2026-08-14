import { ENDPOINT_TYPE } from '@shared/data/types/model'
import { describe, expect, it } from 'vitest'

import { rebasePresetBaseUrls } from '../ProviderRegistryService'

/** AiHubMix-shaped: one origin, a different path per endpoint. */
const GATEWAY_PRESET = {
  [ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS]: { baseUrl: 'https://aihubmix.com/v1', adapterFamily: 'aihubmix' },
  [ENDPOINT_TYPE.OPENAI_RESPONSES]: { baseUrl: 'https://aihubmix.com/v1' },
  [ENDPOINT_TYPE.ANTHROPIC_MESSAGES]: { baseUrl: 'https://aihubmix.com' },
  [ENDPOINT_TYPE.GOOGLE_GENERATE_CONTENT]: { baseUrl: 'https://aihubmix.com/gemini/v1beta' }
}

describe('rebasePresetBaseUrls', () => {
  it('re-derives every preset endpoint from the relay host configured on the primary', () => {
    const rebased = rebasePresetBaseUrls(
      GATEWAY_PRESET,
      { [ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS]: { baseUrl: 'https://relay.example.com/v1' } },
      ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS
    )

    expect(rebased?.[ENDPOINT_TYPE.OPENAI_RESPONSES]?.baseUrl).toBe('https://relay.example.com/v1')
    expect(rebased?.[ENDPOINT_TYPE.ANTHROPIC_MESSAGES]?.baseUrl).toBe('https://relay.example.com')
    expect(rebased?.[ENDPOINT_TYPE.GOOGLE_GENERATE_CONTENT]?.baseUrl).toBe('https://relay.example.com/gemini/v1beta')
  })

  it('keeps the preset host when the primary is not customised', () => {
    const rebased = rebasePresetBaseUrls(
      GATEWAY_PRESET,
      { [ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS]: { baseUrl: 'https://aihubmix.com/v1' } },
      ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS
    )

    expect(rebased).toBe(GATEWAY_PRESET)
  })

  it('does not let a secondary-endpoint override reach the other endpoints', () => {
    const rebased = rebasePresetBaseUrls(
      GATEWAY_PRESET,
      { [ENDPOINT_TYPE.ANTHROPIC_MESSAGES]: { baseUrl: 'https://claude-proxy.example.com' } },
      ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS
    )

    expect(rebased).toBe(GATEWAY_PRESET)
  })

  it('anchors on the preset primary when the preset does not declare the stored endpoint', () => {
    // v1 `openai` relays land on openai-chat-completions; the preset only has responses.
    const rebased = rebasePresetBaseUrls(
      { [ENDPOINT_TYPE.OPENAI_RESPONSES]: { baseUrl: 'https://api.openai.com' } },
      { [ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS]: { baseUrl: 'https://relay.example.com/v1' } },
      ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS
    )

    expect(rebased?.[ENDPOINT_TYPE.OPENAI_RESPONSES]?.baseUrl).toBe('https://relay.example.com/v1')
  })

  it('keeps the preset URL when the primary drops the path offset it would rebase from', () => {
    const rebased = rebasePresetBaseUrls(
      GATEWAY_PRESET,
      { [ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS]: { baseUrl: 'https://relay.example.com/openai' } },
      ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS
    )

    expect(rebased?.[ENDPOINT_TYPE.GOOGLE_GENERATE_CONTENT]?.baseUrl).toBe('https://aihubmix.com/gemini/v1beta')
  })

  it('preserves registry-owned fields while swapping the host', () => {
    const rebased = rebasePresetBaseUrls(
      GATEWAY_PRESET,
      { [ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS]: { baseUrl: 'https://relay.example.com/v1' } },
      ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS
    )

    expect(rebased?.[ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS]).toEqual({
      baseUrl: 'https://relay.example.com/v1',
      adapterFamily: 'aihubmix'
    })
  })

  it('is a no-op without a primary endpoint to anchor on', () => {
    expect(
      rebasePresetBaseUrls(
        GATEWAY_PRESET,
        { [ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS]: { baseUrl: 'https://relay.example.com/v1' } },
        undefined
      )
    ).toBe(GATEWAY_PRESET)
  })
})
