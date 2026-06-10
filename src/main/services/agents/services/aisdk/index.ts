import { EventEmitter } from 'node:events'

import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import type { LanguageModelV3 } from '@ai-sdk/provider'
import { loggerService } from '@logger'
import { getRealProviderModel, validateModelId } from '@main/apiServer/utils'
import { stepCountIs, streamText } from 'ai'

import type { GetAgentSessionResponse } from '../..'
import type {
  AgentServiceInterface,
  AgentStream,
  AgentStreamEvent,
  AgentThinkingOptions
} from '../../interfaces/AgentStreamInterface'

const logger = loggerService.withContext('AiSdkService')

class AiSdkStream extends EventEmitter implements AgentStream {
  declare emit: (event: 'data', data: AgentStreamEvent) => boolean
  declare on: (event: 'data', listener: (data: AgentStreamEvent) => void) => this
  declare once: (event: 'data', listener: (data: AgentStreamEvent) => void) => this
}

function createLanguageModel(providerType: string, modelId: string, apiKey: string, apiHost: string): LanguageModelV3 {
  if (providerType === 'anthropic') {
    const provider = createAnthropic({
      apiKey,
      ...(apiHost ? { baseURL: apiHost } : {})
    })
    return provider(modelId)
  }

  // For openai, openai-compatible, new-api, and any other OpenAI-compatible provider
  const provider = createOpenAI({
    apiKey,
    baseURL: apiHost || undefined,
    compatibility: 'compatible'
  })
  return provider.chat(modelId)
}

class AiSdkService implements AgentServiceInterface {
  async invoke(
    prompt: string,
    session: GetAgentSessionResponse,
    abortController: AbortController,
    _lastAgentSessionId?: string,
    _thinkingOptions?: AgentThinkingOptions
  ): Promise<AgentStream> {
    const aiStream = new AiSdkStream()

    const cwd = session.accessible_paths[0]
    if (!cwd) {
      setImmediate(() => {
        aiStream.emit('data', {
          type: 'error',
          error: new Error('No accessible paths defined for the agent session')
        })
      })
      return aiStream
    }

    const modelInfo = await validateModelId(session.model)
    if (!modelInfo.valid) {
      setImmediate(() => {
        aiStream.emit('data', {
          type: 'error',
          error: new Error(`Invalid model ID '${session.model}': ${JSON.stringify(modelInfo.error)}`)
        })
      })
      return aiStream
    }

    const providerType = modelInfo.provider!.type
    const modelId = getRealProviderModel(session.model)
    const apiKey = modelInfo.provider!.apiKey || modelInfo.provider!.id
    const apiHost = modelInfo.provider!.apiHost || modelInfo.provider!.anthropicApiHost || ''

    logger.info('AI SDK agent config', {
      providerType,
      modelId,
      apiHost: apiHost ? apiHost.replace(/\/\/[^/]+/, '//***') : '(empty)',
      hasApiKey: !!apiKey && apiKey.length > 0
    })

    setImmediate(() => {
      this.runAgent(aiStream, {
        prompt,
        providerType,
        modelId,
        apiKey,
        apiHost,
        instructions: session.instructions,
        abortController
      }).catch((error) => {
        logger.error('AI SDK agent failed', {
          error: error instanceof Error ? error.message : String(error)
        })
        aiStream.emit('data', {
          type: 'error',
          error: error instanceof Error ? error : new Error(String(error))
        })
      })
    })

    return aiStream
  }

  private async runAgent(
    stream: AiSdkStream,
    opts: {
      prompt: string
      providerType: string
      modelId: string
      apiKey: string
      apiHost: string
      instructions?: string
      abortController: AbortController
    }
  ): Promise<void> {
    const model = createLanguageModel(opts.providerType, opts.modelId, opts.apiKey, opts.apiHost)

    logger.info('Starting AI SDK streamText', {
      modelId: opts.modelId,
      promptLength: opts.prompt.length
    })

    const result = streamText({
      model,
      system: opts.instructions,
      prompt: opts.prompt,
      stopWhen: stepCountIs(20),
      abortSignal: opts.abortController.signal
    })

    for await (const chunk of result.fullStream) {
      stream.emit('data', { type: 'chunk', chunk })
    }

    stream.emit('data', { type: 'complete' })
  }
}

export default AiSdkService
