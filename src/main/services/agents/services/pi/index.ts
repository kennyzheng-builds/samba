import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { accessSync, mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'

import { loggerService } from '@logger'
import { getRealProviderModel, validateModelId } from '@main/apiServer/utils'
import getLoginShellEnvironment from '@main/utils/shell-env'
import { app } from 'electron'

import type { GetAgentSessionResponse } from '../..'
import type {
  AgentServiceInterface,
  AgentStream,
  AgentStreamEvent,
  AgentThinkingOptions
} from '../../interfaces/AgentStreamInterface'
import { PiStreamState } from './transform'

const require_ = createRequire(import.meta.url)
const logger = loggerService.withContext('PiService')

class PiStream extends EventEmitter implements AgentStream {
  declare emit: (event: 'data', data: AgentStreamEvent) => boolean
  declare on: (event: 'data', listener: (data: AgentStreamEvent) => void) => this
  declare once: (event: 'data', listener: (data: AgentStreamEvent) => void) => this
}

function resolvePiExecutable(): string {
  try {
    // Pi package is ESM-only (no "default"/"require" export condition),
    // so require_.resolve() won't find it. Walk node_modules manually.
    const searchPaths = require_.resolve.paths('@earendil-works/pi-coding-agent') || []
    for (const dir of searchPaths) {
      const candidate = path.join(dir, '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js')
      try {
        accessSync(candidate)
        let binPath = candidate
        if (app.isPackaged) {
          binPath = binPath.replace(/\.asar([\\/])/, '.asar.unpacked$1')
        }
        return binPath
      } catch {
        continue
      }
    }
    return 'pi'
  } catch {
    return 'pi'
  }
}

function mapProviderForPi(providerType: string): string {
  const mapping: Record<string, string> = {
    anthropic: 'anthropic',
    openai: 'openai',
    deepseek: 'deepseek',
    'google-genai': 'google',
    ollama: 'ollama',
    groq: 'groq',
    'new-api': 'openai'
  }
  return mapping[providerType] || 'openai'
}

class PiService implements AgentServiceInterface {
  async invoke(
    prompt: string,
    session: GetAgentSessionResponse,
    abortController: AbortController,
    _lastAgentSessionId?: string,
    _thinkingOptions?: AgentThinkingOptions
  ): Promise<AgentStream> {
    const aiStream = new PiStream()

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

    const piProvider = mapProviderForPi(modelInfo.provider!.type)
    const modelId = getRealProviderModel(session.model)
    const apiKey = modelInfo.provider!.apiKey || modelInfo.provider!.id
    const apiHost = modelInfo.provider!.apiHost || modelInfo.provider!.anthropicApiHost || ''

    logger.info('Pi provider config', {
      providerType: modelInfo.provider!.type,
      piProvider,
      modelId,
      apiHost: apiHost ? apiHost.replace(/\/\/[^/]+/, '//***') : '(empty)',
      hasApiKey: !!apiKey && apiKey.length > 0,
      apiKeyPrefix: apiKey ? apiKey.slice(0, 8) + '...' : '(none)'
    })

    setImmediate(() => {
      this.startRpcSession(aiStream, {
        cwd,
        prompt,
        provider: piProvider,
        modelId,
        apiKey,
        apiHost,
        instructions: session.instructions,
        envVars: session.configuration?.env_vars,
        abortController
      }).catch((error) => {
        logger.error('Pi RPC session failed', {
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

  private async startRpcSession(
    stream: PiStream,
    opts: {
      cwd: string
      prompt: string
      provider: string
      modelId: string
      apiKey: string
      apiHost: string
      instructions?: string
      envVars?: Record<string, string>
      abortController: AbortController
    }
  ): Promise<void> {
    const piExe = resolvePiExecutable()
    const loginShellEnv = await getLoginShellEnvironment()

    const env: Record<string, string> = {
      ...loginShellEnv,
      ELECTRON_RUN_AS_NODE: '1',
      ELECTRON_NO_ATTACH_CONSOLE: '1'
    }

    if (opts.provider === 'anthropic') {
      env.ANTHROPIC_API_KEY = opts.apiKey
      if (opts.apiHost) env.ANTHROPIC_BASE_URL = opts.apiHost
    } else if (opts.provider === 'openai') {
      env.OPENAI_API_KEY = opts.apiKey
      if (opts.apiHost) env.OPENAI_BASE_URL = opts.apiHost
    } else if (opts.provider === 'google') {
      env.GOOGLE_API_KEY = opts.apiKey
    } else if (opts.provider === 'deepseek') {
      env.DEEPSEEK_API_KEY = opts.apiKey
    } else if (opts.provider === 'groq') {
      env.GROQ_API_KEY = opts.apiKey
    }

    if (opts.envVars) {
      for (const [key, value] of Object.entries(opts.envVars)) {
        if (typeof value === 'string') {
          env[key] = value
        }
      }
    }

    // Pi ignores OPENAI_BASE_URL — it uses its own models.json for provider baseUrl.
    // Write a temp config when apiHost is set to redirect Pi to the custom endpoint.
    // Also force openai-completions API for custom endpoints (most don't support Responses API).
    if (opts.apiHost) {
      const piConfigDir = path.join(tmpdir(), `pi-agent-${Date.now()}`)
      mkdirSync(piConfigDir, { recursive: true })
      const modelsConfig = {
        providers: {
          [opts.provider]: {
            baseUrl: opts.apiHost,
            models: [
              {
                id: opts.modelId,
                api: 'openai-completions'
              }
            ]
          }
        }
      }
      writeFileSync(path.join(piConfigDir, 'models.json'), JSON.stringify(modelsConfig))
      env.PI_CODING_AGENT_DIR = piConfigDir
      logger.info('Pi custom config', { piConfigDir, baseUrl: opts.apiHost, api: 'openai-completions' })
    }

    const args = [
      piExe,
      '--mode',
      'rpc',
      '--provider',
      opts.provider,
      '--model',
      opts.modelId,
      '--api-key',
      opts.apiKey,
      '--no-session'
    ]

    if (opts.instructions) {
      args.push('--system-prompt', opts.instructions)
    }

    const isNodeScript = piExe.endsWith('.js')
    const command = isNodeScript ? process.execPath : piExe
    const spawnArgs = isNodeScript ? args : args.slice(1)

    logger.info('Spawning Pi RPC process', {
      command,
      args: spawnArgs.slice(0, 4),
      cwd: opts.cwd,
      provider: opts.provider,
      model: opts.modelId
    })

    const child = spawn(command, spawnArgs, {
      cwd: opts.cwd,
      env: env as NodeJS.ProcessEnv,
      stdio: ['pipe', 'pipe', 'pipe']
    })

    const streamState = new PiStreamState()
    let hasCompleted = false

    const cleanup = () => {
      if (hasCompleted) return
      hasCompleted = true
      if (!child.killed) {
        child.kill('SIGTERM')
      }
    }

    opts.abortController.signal.addEventListener(
      'abort',
      () => {
        cleanup()
        stream.emit('data', { type: 'cancelled' })
      },
      { once: true }
    )

    child.stderr?.on('data', (data: Buffer) => {
      const text = data.toString().trim()
      if (text) {
        logger.warn('Pi stderr', { chunk: text })
      }
    })

    const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity })

    rl.on('line', (line: string) => {
      if (hasCompleted) return
      const trimmed = line.trim()
      if (!trimmed) return

      try {
        const event = JSON.parse(trimmed)

        if (event.type === 'response') {
          if (!event.success) {
            logger.error('Pi RPC command failed', { error: event.error })
          }
          return
        }

        const chunks = streamState.transformEvent(event)
        for (const chunk of chunks) {
          stream.emit('data', { type: 'chunk', chunk })
        }
      } catch (error) {
        logger.debug('Failed to parse Pi stdout line', { line: trimmed.slice(0, 200) })
      }
    })

    child.on('error', (error) => {
      if (hasCompleted) return
      cleanup()
      stream.emit('data', {
        type: 'error',
        error: new Error(`Pi process error: ${error.message}`)
      })
    })

    child.on('exit', (code, signal) => {
      logger.info('Pi process exited', { code, signal, hasCompleted })
      if (hasCompleted) return
      cleanup()
      if (code !== 0 && signal !== 'SIGTERM') {
        stream.emit('data', {
          type: 'error',
          error: new Error(`Pi process exited with code ${code} (signal: ${signal})`)
        })
      } else {
        stream.emit('data', { type: 'complete' })
      }
    })

    // Wait a moment for the RPC server to initialize, then send the prompt
    await new Promise((resolve) => setTimeout(resolve, 500))

    if (hasCompleted) return

    const promptCmd = JSON.stringify({
      id: '1',
      type: 'prompt',
      message: opts.prompt
    })

    logger.info('Sending prompt to Pi RPC', { promptLength: opts.prompt.length })
    child.stdin!.write(promptCmd + '\n')
  }
}

export default PiService
