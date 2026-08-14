import '@testing-library/jest-dom/vitest'

import { useMessageRenderConfig } from '@renderer/components/chat/messages/MessageListProvider'
import type { MessageListItem } from '@renderer/components/chat/messages/types'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import ActionResultContent from '../ActionResultContent'

vi.mock('@renderer/components/chat/messages/hooks/useMessageListRenderConfig', () => ({
  useMessageListRenderConfig: () => ({ renderConfig: { narrowMode: false } })
}))

vi.mock('@renderer/components/chat/messages/hooks/useMessagePlatformActions', () => ({
  useMessagePlatformActions: () => ({})
}))

vi.mock('@renderer/components/chat/messages/frame/MessageContent', () => {
  const RenderConfigProbe = () => <span>{`wrappable:${String(useMessageRenderConfig().codeWrappable)}`}</span>
  return { default: RenderConfigProbe }
})

describe('ActionResultContent', () => {
  const message: MessageListItem = {
    id: 'action-result-1',
    role: 'assistant',
    topicId: 'selection-action',
    createdAt: '2026-01-01T00:00:00.000Z',
    status: 'success'
  }

  it('wraps code regardless of the preference, the popup being too narrow to scroll', () => {
    render(<ActionResultContent message={message} partsByMessageId={{ [message.id]: [] }} />)

    expect(screen.getByText('wrappable:true')).toBeInTheDocument()
  })
})
