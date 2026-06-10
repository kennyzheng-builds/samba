import { loggerService } from '@logger'
import type { LanguageModelUsage, TextStreamPart } from 'ai'
import { v4 as uuidv4 } from 'uuid'

const logger = loggerService.withContext('PiTransform')

type AgentStreamPart = TextStreamPart<Record<string, any>>

const generateId = (): string => `msg_${uuidv4().replace(/-/g, '')}`

const emptyUsage: LanguageModelUsage = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0, noCacheTokens: 0 },
  outputTokenDetails: { textTokens: 0, reasoningTokens: 0 }
}

export class PiStreamState {
  private messageId: string = ''
  private activeTextBlock = false
  private activeThinkingBlock = false
  private activeToolCallBlock = false
  private pendingToolCalls = new Map<string, { toolName: string; input: string }>()

  transformEvent(event: any): AgentStreamPart[] {
    const parts: AgentStreamPart[] = []
    const type = event.type

    switch (type) {
      case 'agent_start':
        parts.push({
          type: 'start',
          messageId: generateId()
        } as AgentStreamPart)
        break

      case 'agent_end':
        parts.push({
          type: 'finish',
          totalUsage: emptyUsage,
          finishReason: 'stop',
          rawFinishReason: 'stop',
          providerMetadata: {}
        } as AgentStreamPart)
        break

      case 'turn_start':
        this.messageId = generateId()
        parts.push({
          type: 'start-step',
          messageId: this.messageId,
          request: {},
          warnings: []
        } as AgentStreamPart)
        break

      case 'turn_end':
        this.closeActiveBlocks(parts)
        parts.push({
          type: 'finish-step',
          response: { id: this.messageId, timestamp: new Date(), modelId: '' },
          usage: emptyUsage,
          finishReason: 'stop',
          rawFinishReason: 'stop',
          providerMetadata: {}
        } as AgentStreamPart)
        break

      case 'message_update':
        this.handleMessageUpdate(event, parts)
        break

      case 'tool_execution_start':
        parts.push({
          type: 'tool-call',
          toolCallId: event.toolCallId || generateId(),
          toolName: event.toolName || 'unknown',
          input: {},
          providerMetadata: { raw: event }
        } as AgentStreamPart)
        break

      case 'tool_execution_end': {
        const toolCallId = event.toolCallId || ''
        const isError = event.isError === true
        if (isError) {
          parts.push({
            type: 'tool-error',
            toolCallId,
            error: event.result || 'Tool execution failed'
          } as unknown as AgentStreamPart)
        } else {
          parts.push({
            type: 'tool-result',
            toolCallId,
            toolName: event.toolName || 'unknown',
            output: event.result,
            providerMetadata: {}
          } as AgentStreamPart)
        }
        break
      }

      case 'message_start':
        break

      case 'message_end': {
        const msg = event.message
        if (msg?.role === 'assistant' && msg?.errorMessage) {
          parts.push({ type: 'text-start', id: generateId() } as AgentStreamPart)
          parts.push({
            type: 'text-delta',
            id: generateId(),
            text: `Error: ${msg.errorMessage}`
          } as AgentStreamPart)
          parts.push({ type: 'text-end', id: generateId(), providerMetadata: {} } as AgentStreamPart)
        }
        break
      }

      default:
        logger.debug('Unhandled Pi RPC event type', { type })
        break
    }

    return parts
  }

  private handleMessageUpdate(event: any, parts: AgentStreamPart[]) {
    const delta = event.assistantMessageEvent
    if (!delta) return

    const deltaType = delta.type

    switch (deltaType) {
      case 'text_start': {
        if (!this.activeTextBlock) {
          this.activeTextBlock = true
          parts.push({ type: 'text-start', id: generateId() } as AgentStreamPart)
        }
        break
      }

      case 'text_delta': {
        if (!this.activeTextBlock) {
          this.activeTextBlock = true
          parts.push({ type: 'text-start', id: generateId() } as AgentStreamPart)
        }
        const textContent = delta.delta ?? delta.text
        if (textContent) {
          parts.push({
            type: 'text-delta',
            id: generateId(),
            text: textContent
          } as AgentStreamPart)
        }
        break
      }

      case 'text_end': {
        if (this.activeTextBlock) {
          this.activeTextBlock = false
          parts.push({
            type: 'text-end',
            id: generateId(),
            providerMetadata: {}
          } as AgentStreamPart)
        }
        break
      }

      case 'thinking_start': {
        if (!this.activeThinkingBlock) {
          this.activeThinkingBlock = true
          parts.push({ type: 'reasoning-start', id: generateId() } as AgentStreamPart)
        }
        break
      }

      case 'thinking_delta': {
        if (!this.activeThinkingBlock) {
          this.activeThinkingBlock = true
          parts.push({ type: 'reasoning-start', id: generateId() } as AgentStreamPart)
        }
        const thinkingContent = delta.delta ?? delta.text
        if (thinkingContent) {
          parts.push({
            type: 'reasoning-delta',
            id: generateId(),
            text: thinkingContent
          } as AgentStreamPart)
        }
        break
      }

      case 'thinking_end': {
        if (this.activeThinkingBlock) {
          this.activeThinkingBlock = false
          parts.push({ type: 'reasoning-end', id: generateId() } as AgentStreamPart)
        }
        break
      }

      case 'toolcall_start': {
        this.activeToolCallBlock = true
        const toolCall = delta.toolCall || {}
        const toolCallId = toolCall.id || generateId()
        this.pendingToolCalls.set(toolCallId, { toolName: toolCall.name || 'unknown', input: '' })
        parts.push({
          type: 'tool-input-start',
          id: toolCallId,
          toolName: toolCall.name || 'unknown'
        } as AgentStreamPart)
        break
      }

      case 'toolcall_delta': {
        const toolCall = delta.toolCall || {}
        const toolCallId = toolCall.id || ''
        const pending = this.pendingToolCalls.get(toolCallId)
        const inputDelta = delta.inputDelta ?? delta.delta
        if (pending && inputDelta) {
          pending.input += inputDelta
          parts.push({
            type: 'tool-input-delta',
            id: toolCallId,
            delta: inputDelta
          } as AgentStreamPart)
        }
        break
      }

      case 'toolcall_end': {
        this.activeToolCallBlock = false
        const toolCall = delta.toolCall || {}
        const toolCallId = toolCall.id || ''
        const pending = this.pendingToolCalls.get(toolCallId)
        let parsedInput: unknown = {}
        if (pending?.input) {
          try {
            parsedInput = JSON.parse(pending.input)
          } catch {
            parsedInput = { raw: pending.input }
          }
        }
        parts.push({
          type: 'tool-input-end',
          id: toolCallId
        } as AgentStreamPart)
        parts.push({
          type: 'tool-call',
          toolCallId,
          toolName: pending?.toolName || toolCall.name || 'unknown',
          input: parsedInput,
          providerMetadata: {}
        } as AgentStreamPart)
        this.pendingToolCalls.delete(toolCallId)
        break
      }

      case 'done': {
        this.closeActiveBlocks(parts)
        break
      }

      default:
        logger.debug('Unhandled Pi message_update delta type', { deltaType })
        break
    }
  }

  private closeActiveBlocks(parts: AgentStreamPart[]) {
    if (this.activeTextBlock) {
      this.activeTextBlock = false
      parts.push({ type: 'text-end', id: generateId(), providerMetadata: {} } as AgentStreamPart)
    }
    if (this.activeThinkingBlock) {
      this.activeThinkingBlock = false
      parts.push({ type: 'reasoning-end', id: generateId() } as AgentStreamPart)
    }
    if (this.activeToolCallBlock) {
      this.activeToolCallBlock = false
    }
  }
}
