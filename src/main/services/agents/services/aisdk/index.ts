import { execSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import type { LanguageModelV3 } from '@ai-sdk/provider'
import { loggerService } from '@logger'
import { getRealProviderModel, validateModelId } from '@main/apiServer/utils'
import { stepCountIs, streamText, tool } from 'ai'
import * as z from 'zod'

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

  const provider = createOpenAI({
    apiKey,
    baseURL: apiHost || undefined,
    compatibility: 'compatible'
  })
  return provider.chat(modelId)
}

function isPathAllowed(targetPath: string, cwd: string): boolean {
  const resolved = resolve(cwd, targetPath)
  return resolved.startsWith(cwd)
}

function createAgentTools(cwd: string) {
  return {
    readFile: tool({
      description: 'Read the contents of a file. Returns the file content as text.',
      parameters: z.object({
        path: z.string().describe('File path relative to the working directory')
      }),
      execute: async ({ path }) => {
        const fullPath = resolve(cwd, path)
        if (!isPathAllowed(fullPath, cwd)) {
          return { error: `Access denied: path outside working directory` }
        }
        try {
          const content = readFileSync(fullPath, 'utf-8')
          return { content, path: fullPath }
        } catch (e: any) {
          return { error: e.message }
        }
      }
    }),

    writeFile: tool({
      description: 'Write content to a file. Creates the file if it does not exist, overwrites if it does.',
      parameters: z.object({
        path: z.string().describe('File path relative to the working directory'),
        content: z.string().describe('The content to write')
      }),
      execute: async ({ path, content }) => {
        const fullPath = resolve(cwd, path)
        if (!isPathAllowed(fullPath, cwd)) {
          return { error: `Access denied: path outside working directory` }
        }
        try {
          const dir = resolve(fullPath, '..')
          if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
          writeFileSync(fullPath, content, 'utf-8')
          return { success: true, path: fullPath, bytesWritten: Buffer.byteLength(content) }
        } catch (e: any) {
          return { error: e.message }
        }
      }
    }),

    listFiles: tool({
      description: 'List files and directories in a given path. Returns names with type indicators.',
      parameters: z.object({
        path: z.string().describe('Directory path relative to the working directory').default('.')
      }),
      execute: async ({ path }) => {
        const fullPath = resolve(cwd, path)
        if (!isPathAllowed(fullPath, cwd)) {
          return { error: `Access denied: path outside working directory` }
        }
        try {
          const entries = readdirSync(fullPath).map((name) => {
            try {
              const s = statSync(resolve(fullPath, name))
              return { name, type: s.isDirectory() ? 'directory' : 'file', size: s.size }
            } catch {
              return { name, type: 'unknown', size: 0 }
            }
          })
          return { path: fullPath, entries }
        } catch (e: any) {
          return { error: e.message }
        }
      }
    }),

    executeCommand: tool({
      description:
        'Execute a shell command in the working directory. Use for tasks like file operations, git commands, running scripts, etc.',
      parameters: z.object({
        command: z.string().describe('The shell command to execute')
      }),
      execute: async ({ command }) => {
        try {
          const output = execSync(command, {
            cwd,
            encoding: 'utf-8',
            timeout: 30_000,
            maxBuffer: 1024 * 1024
          })
          return { stdout: output.trim(), exitCode: 0 }
        } catch (e: any) {
          return {
            stdout: e.stdout?.trim() || '',
            stderr: e.stderr?.trim() || '',
            exitCode: e.status ?? 1,
            error: e.message
          }
        }
      }
    })
  }
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
      hasApiKey: !!apiKey && apiKey.length > 0,
      cwd
    })

    setImmediate(() => {
      this.runAgent(aiStream, {
        prompt,
        providerType,
        modelId,
        apiKey,
        apiHost,
        instructions: session.instructions,
        abortController,
        cwd
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
      cwd: string
    }
  ): Promise<void> {
    const model = createLanguageModel(opts.providerType, opts.modelId, opts.apiKey, opts.apiHost)
    const tools = createAgentTools(opts.cwd)

    const systemPrompt = [
      opts.instructions || 'You are a helpful coding assistant.',
      `Your working directory is: ${opts.cwd}`,
      'You have access to tools for reading/writing files, listing directories, and executing shell commands.',
      'Use these tools to accomplish tasks directly instead of just describing what to do.'
    ].join('\n')

    logger.info('Starting AI SDK agent', {
      modelId: opts.modelId,
      promptLength: opts.prompt.length,
      cwd: opts.cwd,
      toolCount: Object.keys(tools).length
    })

    const result = streamText({
      model,
      system: systemPrompt,
      prompt: opts.prompt,
      tools,
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
