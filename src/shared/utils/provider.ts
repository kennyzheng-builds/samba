import {
  isServerToolModelEligible as isRegistryServerToolModelEligible,
  isWebSearchEffortUnsupported,
  matchVendor,
  REASONING_EFFORT,
  SERVER_TOOL,
  SERVER_TOOL_MODEL_SCOPE,
  type ServerTool,
  type ServerToolConfig,
  supportsServerToolFunctionMixing
} from '@cherrystudio/provider-registry'
import { CHERRYAI_PROVIDER_ID } from '@shared/data/presets/cherryai'
import { ENDPOINT_TYPE, type EndpointType, type Model } from '@shared/data/types/model'
import type { Provider } from '@shared/data/types/provider'

import { getLowerBaseModelName, getRawModelId, isFunctionCallingModel, isGeminiModel, isNonChatModel } from './model'
import { getProviderHostTopology } from './providerTopology'

// Azure/Vertex/Bedrock reuse other vendors' endpoint protocols, so authType
// is the only reliable discriminator (seeded skeletons may lack a distinct
// defaultChatEndpoint). See presetProviderSeeder.ts.
export function isVertexProvider(provider: Provider): boolean {
  return provider.authType === 'iam-gcp'
}

export function isAzureOpenAIProvider(provider: Provider): boolean {
  return provider.authType === 'iam-azure'
}

export function isAwsBedrockProvider(provider: Provider): boolean {
  return provider.authType === 'iam-aws' || provider.authType === 'api-key-aws'
}

export function isOllamaProvider(provider: Pick<Provider, 'id' | 'presetProviderId' | 'defaultChatEndpoint'>): boolean {
  return (
    provider.id === 'ollama' ||
    provider.presetProviderId === 'ollama' ||
    provider.defaultChatEndpoint === ENDPOINT_TYPE.OLLAMA_CHAT
  )
}

/**
 * Ollama's local server does not validate credentials, but the SDKs backing
 * Claude Code and OpenCode still require a non-empty auth token string — used
 * as a stand-in wherever an Ollama provider has no configured API key.
 */
export const OLLAMA_PLACEHOLDER_AUTH_TOKEN = 'ollama'

// `&& !iam-gcp` excludes Vertex, which the seeder gives the same
// google-generate-content endpoint as Gemini.
export function isGeminiProvider(provider: Provider): boolean {
  return (
    (provider.id === 'google' ||
      provider.id === 'gemini' ||
      provider.presetProviderId === 'gemini' ||
      provider.defaultChatEndpoint === ENDPOINT_TYPE.GOOGLE_GENERATE_CONTENT) &&
    provider.authType !== 'iam-gcp'
  )
}

export function isAnthropicProvider(provider: Provider): boolean {
  return (
    provider.presetProviderId === 'anthropic' ||
    provider.id === 'anthropic' ||
    provider.defaultChatEndpoint === ENDPOINT_TYPE.ANTHROPIC_MESSAGES
  )
}

export function isOpenAIProvider(provider: Provider): boolean {
  return provider.defaultChatEndpoint === ENDPOINT_TYPE.OPENAI_RESPONSES
}

export function isOpenAIChatProvider(provider: Provider): boolean {
  return provider.defaultChatEndpoint === ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS
}

export function isOpenAIResponsesProvider(provider: Provider): boolean {
  return provider.defaultChatEndpoint === ENDPOINT_TYPE.OPENAI_RESPONSES
}

export function isOpenAICompatibleProvider(provider: Provider): boolean {
  return (
    provider.defaultChatEndpoint === ENDPOINT_TYPE.OPENAI_CHAT_COMPLETIONS ||
    provider.defaultChatEndpoint === ENDPOINT_TYPE.OPENAI_RESPONSES ||
    provider.presetProviderId === 'new-api' ||
    provider.presetProviderId === 'mistral'
  )
}

export function isPerplexityProvider(provider: Provider): boolean {
  return provider.id === 'perplexity' || provider.presetProviderId === 'perplexity'
}

export function isCherryAIProvider(provider: Provider): boolean {
  return provider.id === CHERRYAI_PROVIDER_ID || provider.presetProviderId === CHERRYAI_PROVIDER_ID
}

export function isNewApiProvider(provider: Provider): boolean {
  return matchesPreset(provider, 'new-api') || matchesPreset(provider, 'cherryin') || matchesPreset(provider, 'aionly')
}

export function isAIGatewayProvider(provider: Provider): boolean {
  return provider.presetProviderId === 'gateway' || provider.id === 'gateway'
}

export function isGeminiWebSearchProvider(provider: Provider): boolean {
  return isGeminiProvider(provider) || isVertexProvider(provider)
}

/**
 * Whether this host injects Google's NATIVE web tools for a Gemini model — the thing pre-3 Gemini
 * refuses to mix with function declarations. Direct Gemini/Vertex do; so do the gateways whose models
 * carry a `<host>.google` provider segment (cherryin, aihubmix, new-api), because
 * `resolveToolCapability`'s aggregator fallback lands on the same google factory. Their declarations
 * are exactly the ones narrowed to the `gemini` vendor, so read that instead of the host id — keying
 * the guard to the host let those gateways ship native tools alongside function tools.
 * Hosts that serve Gemini through their own search (OpenRouter's `plugins`) declare no gemini vendor
 * and stay out: nothing native is injected, so there is no conflict to avoid.
 */
function servesGeminiNativeWebTools(provider: Provider): boolean {
  if (isGeminiWebSearchProvider(provider)) return true
  return (provider.serverTools ?? []).some((tool) => tool.vendors?.includes('gemini'))
}

export function isSystemProvider(provider: Provider): boolean {
  return provider.presetProviderId != null
}

export function matchesPreset(provider: Pick<Provider, 'id' | 'presetProviderId'>, presetId: string): boolean {
  return provider.id === presetId || provider.presetProviderId === presetId
}

/**
 * Canonical preset providers are seeded built-ins whose runtime ID equals the
 * linked preset ID. Preset-derived user providers remain user-manageable.
 */
export function canManageProvider(provider: Provider): boolean {
  return provider.presetProviderId == null || provider.presetProviderId !== provider.id
}

/**
 * Providers whose API key is obtained via a hosted OAuth "get key" flow (the
 * `OauthButton`), keyed by runtime id. Single source of truth: `OauthButton`
 * supplies one handler per id (a missing handler is a compile error there), and
 * `isProviderSupportAuth` gates whether the button renders.
 */
export const API_KEY_OAUTH_PROVIDER_IDS = ['302ai', 'silicon', 'aihubmix', 'ppio', 'aionly'] as const

export function isProviderSupportAuth(provider: Pick<Provider, 'id'>): boolean {
  return (API_KEY_OAUTH_PROVIDER_IDS as readonly string[]).includes(provider.id)
}

/**
 * Login-based providers authenticate via a sign-in flow (CLI login / hosted
 * OAuth) and accept no user API key, so the generic API-key/host UI is
 * suppressed and their sign-in panel renders through the provider registry
 * instead. Derived from the provider's `authMethods` (registry capability):
 * login-based ⇔ it declares methods and none is `'api-key'`. Absent ⇒ default
 * `['api-key']` ⇒ not login-based. CherryIN declares `['api-key', 'oauth']`, so
 * it is *not* login-based — its key inputs stay alongside the OAuth panel.
 */
export function isLoginBasedProvider(provider: Pick<Provider, 'authMethods'>): boolean {
  const methods = provider.authMethods
  return methods !== undefined && methods.length > 0 && !methods.includes('api-key')
}

/**
 * External-CLI providers (e.g. Claude Code) reuse a CLI's own stored login and
 * hold no app-side credential, so they cannot serve a normal chat/generation
 * request: they are surfaced only to agent pickers (hidden from chat selectors,
 * rejected as a topic-naming model). Capability-derived from `authMethods`, not
 * keyed to a specific provider id, so a second such provider is covered for free.
 */
export function isExternalCliProvider(provider: Pick<Provider, 'authMethods'>): boolean {
  return provider.authMethods?.includes('external-cli') ?? false
}

export function isAnthropicSupportedProvider(provider: Provider): boolean {
  return getProviderHostTopology(provider).hasAnthropicEndpoint
}

export function isSupportServiceTierProvider(provider: Provider): boolean {
  return provider.apiFeatures?.serviceTier ?? false
}

/** Effective Fast support belongs to the provider-model pair, not either side alone. */
export function isSupportFastMode(
  provider: Pick<Provider, 'fastMode'>,
  model: Pick<Model, 'supportsFastMode'>
): provider is Pick<Provider, 'fastMode'> & { fastMode: NonNullable<Provider['fastMode']> } {
  return provider.fastMode !== undefined && model.supportsFastMode === true
}

export function isSupportVerbosityProvider(provider: Provider): boolean {
  return provider.apiFeatures?.verbosity ?? false
}

export function isSupportArrayContentProvider(provider: Provider): boolean {
  return provider.apiFeatures?.arrayContent ?? false
}

export function isSupportDeveloperRoleProvider(provider: Provider): boolean {
  return provider.apiFeatures?.developerRole ?? false
}

export function isSupportStreamOptionsProvider(provider: Provider): boolean {
  return provider.apiFeatures?.streamOptions ?? false
}

function getServerTool(provider: Pick<Provider, 'serverTools'>, id: ServerTool) {
  return provider.serverTools?.find((tool) => tool.id === id)
}

/** Whether the host serves this tool for the model's vendor family (declaration `vendors` narrowing). */
function serverToolServesModelVendor(tool: ServerToolConfig, model: Model): boolean {
  if (!tool.vendors?.length) return true
  // VENDOR_PATTERNS are anchored and assume a namespace-stripped id: a gateway's
  // `google/gemini-3-pro-preview` matches nothing, silently withholding the tool from
  // every namespaced model whose vendor slug differs from its namespace.
  const vendor = matchVendor(getLowerBaseModelName(getRawModelId(model)))
  return vendor !== undefined && tool.vendors.includes(vendor)
}

/** Whether the host serves this tool over the effective endpoint protocol. */
function serverToolServesEndpoint(tool: ServerToolConfig, endpointType: EndpointType | undefined): boolean {
  if (!tool.endpointTypes?.length) return true
  return endpointType !== undefined && tool.endpointTypes.includes(endpointType)
}

function resolveServerToolEndpoint(
  model: Model,
  provider: Pick<Provider, 'defaultChatEndpoint'>,
  endpointType: EndpointType | undefined
): EndpointType | undefined {
  return endpointType ?? model.endpointTypes?.[0] ?? provider.defaultChatEndpoint
}

/** Model-side eligibility for a provider-native tool, compiled from the serving provider declaration. */
export function isServerToolModelEligible(
  model: Model,
  provider: Pick<Provider, 'id' | 'presetProviderId'>,
  tool: ServerTool
): boolean {
  if (isNonChatModel(model)) return false

  return isRegistryServerToolModelEligible(getRawModelId(model), provider.presetProviderId ?? provider.id, tool)
}

/** Effective built-in web-search availability for one provider-model pair. */
export function isBuiltinWebSearchAvailable(
  model: Model,
  provider: Pick<Provider, 'id' | 'presetProviderId' | 'defaultChatEndpoint' | 'serverTools'>,
  endpointType?: EndpointType
): boolean {
  const tool = getServerTool(provider, SERVER_TOOL.WEB_SEARCH)
  if (
    !tool ||
    !serverToolServesModelVendor(tool, model) ||
    !serverToolServesEndpoint(tool, resolveServerToolEndpoint(model, provider, endpointType))
  ) {
    return false
  }

  if (tool.modelScope === SERVER_TOOL_MODEL_SCOPE.ALL_CHAT_MODELS) {
    return !isNonChatModel(model)
  }

  return isServerToolModelEligible(model, provider, SERVER_TOOL.WEB_SEARCH)
}

export type WebToolRoute = 'client' | 'server' | 'none'

/** Why an enabled web capability resolved to 'none' — codes only, UI maps them to copy. */
export type WebToolUnavailableReason =
  | 'no-backend'
  | 'model-unsupported'
  | 'gemini-function-tool-conflict'
  | 'openai-minimal-reasoning'

export interface WebToolRoutes {
  webSearch: WebToolRoute
  webFetch: WebToolRoute
  reasons?: Partial<Record<'webSearch' | 'webFetch', WebToolUnavailableReason>>
}

/** Effective provider-native URL-fetch availability for one provider-model pair. */
export function isBuiltinWebFetchAvailable(
  model: Model,
  provider: Pick<Provider, 'id' | 'presetProviderId' | 'defaultChatEndpoint' | 'serverTools'>,
  endpointType?: EndpointType
): boolean {
  const tool = getServerTool(provider, SERVER_TOOL.URL_CONTEXT)
  if (
    !tool ||
    !serverToolServesModelVendor(tool, model) ||
    !serverToolServesEndpoint(tool, resolveServerToolEndpoint(model, provider, endpointType))
  ) {
    return false
  }

  if (tool.modelScope === SERVER_TOOL_MODEL_SCOPE.ALL_CHAT_MODELS) {
    return !isNonChatModel(model)
  }

  return isServerToolModelEligible(model, provider, SERVER_TOOL.URL_CONTEXT)
}

/**
 * Bailian splits built-in web search by endpoint. The Responses `{ type: 'web_search' }` tool is served
 * for the Qwen3.x line only — "Responses API 仅支持 Qwen3.8、Qwen3.7、Qwen3.6、Qwen3.5、qwen3-max"
 * (help.aliyun.com/zh/model-studio/web-search). The `qwen-plus` / `qwen-flash` / character aliases and the
 * hosted third-party models search through Chat Completions' `enable_search` instead (see
 * `getWebSearchParams`), so emitting the tool for them yields a provider error or an empty result.
 *
 * Both the request's route and its delivery key off this one predicate: when they disagree the route
 * picks the server side while nothing gets injected, and the request goes out with no search tool AND
 * no client tools.
 */
export function servesDashScopeResponsesWebSearch(model: Model): boolean {
  // Key off the shared wire-id resolution: `apiModelId` alone is optional on the
  // runtime Model, and reading it directly made this silently return false.
  return /^qwen3[.-]/.test(getRawModelId(model))
}

/**
 * Select one web-tool side for a request, then expose only the capabilities
 * available on that side.
 *
 * Provider/model conflicts (pre-3 Gemini native tools × function tools, OpenAI
 * GPT-5 minimal reasoning × native web_search) enter here as availability
 * inputs, so a conflicted server side falls back to the client tools instead
 * of being vetoed downstream. The mirror image also exists — a host that
 * reserves the client tool's wire name for a built-in of its own (Bailian on
 * Responses) withdraws the client side instead. Each capability that lands on
 * 'none' carries a reason code for UI messaging.
 */
export function resolveWebToolRoutes(
  model: Model,
  provider: Provider | undefined,
  options: {
    webSearchEnabled: boolean
    clientSearchAvailable: boolean
    clientFetchAvailable: boolean
    clientToolsPreferred: boolean
    /** Non-web function tools expected on the request (MCP/KB/attachments/…); predictive in the renderer. */
    hasFunctionToolSignals?: boolean
    /** Effective reasoning effort selection for the request. */
    reasoningEffort?: string
    /** Effective endpoint protocol selected for this request. */
    endpointType?: EndpointType
  }
): WebToolRoutes {
  const supportsClientTools = isFunctionCallingModel(model)
  const clientFetchAvailable = options.webSearchEnabled && supportsClientTools && options.clientFetchAvailable
  const serverSearchEligible =
    options.webSearchEnabled && provider ? isBuiltinWebSearchAvailable(model, provider, options.endpointType) : false
  const serverFetchEligible =
    options.webSearchEnabled && provider ? isBuiltinWebFetchAvailable(model, provider, options.endpointType) : false

  const googleToolConflict =
    options.hasFunctionToolSignals === true &&
    supportsClientTools &&
    provider !== undefined &&
    servesGeminiNativeWebTools(provider) &&
    isGeminiModel(model) &&
    !supportsServerToolFunctionMixing(getRawModelId(model))
  const openaiMinimalConflict =
    options.reasoningEffort !== undefined &&
    provider !== undefined &&
    (isOpenAIProvider(provider) || isOpenAIChatProvider(provider) || isAzureOpenAIProvider(provider)) &&
    isWebSearchEffortUnsupported(getRawModelId(model), options.reasoningEffort)

  /** Bailian's Responses endpoint, where its own built-in web tools displace the client ones. */
  const onDashScopeResponses =
    provider !== undefined &&
    matchesPreset(provider, 'dashscope') &&
    resolveServerToolEndpoint(model, provider, options.endpointType) === ENDPOINT_TYPE.OPENAI_RESPONSES

  // Registry eligibility says nothing about which of Bailian's two search mechanisms an endpoint
  // serves: on Responses only the Qwen3.x line gets the built-in tool, and
  // `buildProviderBuiltinWebSearchConfig` delivers nothing for the rest. Routing those server-side
  // would withhold the client tools for a built-in that never reaches the wire.
  const dashscopeSearchUnserved = onDashScopeResponses && !servesDashScopeResponsesWebSearch(model)

  const serverSearchAvailable =
    serverSearchEligible && !googleToolConflict && !openaiMinimalConflict && !dashscopeSearchUnserved

  // `appendDashScopeWebExtractor` appends the fetch tool only alongside a `web_search` that actually
  // made it into the body, and only in thinking mode — Bailian rejects the pair otherwise. Server
  // fetch there is real exactly when both hold; report it unavailable rather than routing fetch at a
  // tool the request will not carry.
  const dashscopeExtractorUnserved =
    onDashScopeResponses && (!serverSearchAvailable || options.reasoningEffort === REASONING_EFFORT.NONE)

  const serverFetchAvailable = serverFetchEligible && !googleToolConflict && !dashscopeExtractorUnserved

  // Bailian's Responses API reserves the client search tool's wire name (`web_search`) for its own
  // built-in: a function tool sent under that name comes back as a provider-executed `web_search_call`
  // item carrying no arguments, which the AI SDK still checks against the client tool's schema, so
  // `query` is missing and every single call is rejected. Withdrawing the client tool takes the
  // preference for the client side with it — otherwise "prefer client tools" would strand search on
  // 'none' while the server side that does work sits unused. Only ever a swap: `serverSearchAvailable`
  // already means the built-in is there to take over, so this never leaves a request with no search.
  const searchNameReserved = serverSearchAvailable && onDashScopeResponses
  const clientToolsPreferred = options.clientToolsPreferred && !searchNameReserved
  const clientSearchAvailable =
    options.webSearchEnabled && supportsClientTools && options.clientSearchAvailable && !searchNameReserved

  const clientAvailable = clientSearchAvailable || clientFetchAvailable
  const serverAvailable = serverSearchAvailable || serverFetchAvailable

  const selectedSide: Exclude<WebToolRoute, 'none'> | undefined = clientToolsPreferred
    ? clientAvailable
      ? 'client'
      : serverAvailable
        ? 'server'
        : undefined
    : serverAvailable
      ? 'server'
      : clientAvailable
        ? 'client'
        : undefined

  const webSearch: WebToolRoute =
    selectedSide === 'client' && clientSearchAvailable
      ? 'client'
      : selectedSide === 'server' && serverSearchAvailable
        ? 'server'
        : 'none'
  const webFetch: WebToolRoute =
    selectedSide === 'client' && clientFetchAvailable
      ? 'client'
      : selectedSide === 'server' && serverFetchAvailable
        ? 'server'
        : 'none'

  const reasons: NonNullable<WebToolRoutes['reasons']> = {}
  if (webSearch === 'none') {
    reasons.webSearch =
      serverSearchEligible && googleToolConflict
        ? 'gemini-function-tool-conflict'
        : serverSearchEligible && openaiMinimalConflict
          ? 'openai-minimal-reasoning'
          : options.clientSearchAvailable && !supportsClientTools
            ? 'model-unsupported'
            : 'no-backend'
  }
  if (webFetch === 'none') {
    reasons.webFetch =
      serverFetchEligible && googleToolConflict
        ? 'gemini-function-tool-conflict'
        : options.clientFetchAvailable && !supportsClientTools
          ? 'model-unsupported'
          : 'no-backend'
  }

  return { webSearch, webFetch, ...(Object.keys(reasons).length > 0 ? { reasons } : {}) }
}

/**
 * Final request-time amendment to the routes, once the resolved ToolSet is
 * known: pre-3 Gemini rejects requests mixing its native tools with function
 * tools, so surviving server routes are withdrawn. Normally the conflict is
 * already predicted by `resolveWebToolRoutes` (which prefers falling back to
 * the client side); this is the exact safety net for under-predicted signals.
 * The amended routes are the single source of truth on the request scope.
 */
export function finalizeWebToolRoutes(
  routes: WebToolRoutes,
  model: Model,
  provider: Provider,
  hasFunctionTools: boolean
): WebToolRoutes {
  if (!hasFunctionTools || !isGeminiModel(model) || supportsServerToolFunctionMixing(getRawModelId(model))) {
    return routes
  }

  let next = routes
  if (next.webFetch === 'server') {
    next = { ...next, webFetch: 'none', reasons: { ...next.reasons, webFetch: 'gemini-function-tool-conflict' } }
  }
  // Search only conflicts when the injected tool is Google's own — gemini/vertex directly, plus the
  // gateways that resolve the same google factory. OpenRouter serves gemini models with its own
  // search, which tolerates function tools.
  if (next.webSearch === 'server' && servesGeminiNativeWebTools(provider)) {
    next = { ...next, webSearch: 'none', reasons: { ...next.reasons, webSearch: 'gemini-function-tool-conflict' } }
  }
  return next
}

const NOT_SUPPORT_QWEN3_ENABLE_THINKING_PROVIDERS = ['ollama', 'lmstudio', 'nvidia', 'gpustack'] as const

export function isSupportEnableThinkingProvider(provider: Provider): boolean {
  return !NOT_SUPPORT_QWEN3_ENABLE_THINKING_PROVIDERS.some((id) => id === provider.id)
}

export function hasApiKeys(provider: Provider): boolean {
  return provider.apiKeys.length > 0 && provider.apiKeys.some((k) => k.isEnabled)
}

export function getClaudeSupportedProviders<T extends Provider>(providers: T[]): T[] {
  return providers.filter(
    (p) =>
      isAnthropicProvider(p) ||
      isNewApiProvider(p) ||
      p.id === 'aihubmix' ||
      p.id === 'openrouter' ||
      isAzureOpenAIProvider(p)
  )
}

export function isSupportAnthropicPromptCacheProvider(provider: Provider): boolean {
  return (
    isAnthropicProvider(provider) ||
    isNewApiProvider(provider) ||
    provider.id === 'aihubmix' ||
    provider.id === 'openrouter' ||
    isAzureOpenAIProvider(provider)
  )
}

/**
 * Sanitize a provider display name for use in config file keys / launch args.
 * Shared by the renderer (writes CLI config files) and main (assembles the
 * matching launch command) — they must agree on the exact same output.
 */
export function sanitizeProviderName(name: string, fallback: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9_\s.-]/g, '').replace(/\s+/g, '-')
  return sanitized || fallback
}
