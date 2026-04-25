export type AnthropicCompatMode = 'native' | 'ollama' | 'generic'

const LOCAL_HOSTS = new Set(['127.0.0.1', '0.0.0.0', 'localhost', '[::1]'])
const ANTHROPIC_HOSTS = new Set([
  'api.anthropic.com',
  'api-staging.anthropic.com',
])

function getConfiguredBaseUrlHost(): { host: string; port: string } | null {
  const baseUrl = process.env.ANTHROPIC_BASE_URL
  if (!baseUrl) {
    return null
  }
  try {
    const parsed = new URL(baseUrl)
    return {
      host: parsed.hostname,
      port: parsed.port,
    }
  } catch {
    return null
  }
}

export function getAnthropicCompatMode(): AnthropicCompatMode {
  const explicitMode = process.env.CLAUDE_CODE_COMPAT_MODE?.trim().toLowerCase()
  if (explicitMode) {
    if (explicitMode === 'native' || explicitMode === 'anthropic') {
      return 'native'
    }
    if (explicitMode === 'ollama') {
      return 'ollama'
    }
    return 'generic'
  }

  const parsedBaseUrl = getConfiguredBaseUrlHost()
  if (!parsedBaseUrl) {
    return 'native'
  }

  if (
    LOCAL_HOSTS.has(parsedBaseUrl.host) &&
    parsedBaseUrl.port === '11434'
  ) {
    return 'ollama'
  }

  return ANTHROPIC_HOSTS.has(parsedBaseUrl.host) ? 'native' : 'generic'
}

export function normalizeAnthropicCompatibilityBaseUrl(
  baseUrl: string,
  mode: AnthropicCompatMode = getAnthropicCompatMode(),
): string {
  const trimmed = baseUrl.trim()
  if (!trimmed || mode === 'native') {
    return trimmed
  }

  try {
    const parsed = new URL(trimmed)
    const pathname = parsed.pathname.replace(/\/+$/, '')
    if (!pathname.toLowerCase().endsWith('/v1')) {
      return trimmed
    }

    const normalizedPath = pathname.slice(0, -3)
    return `${parsed.origin}${normalizedPath}${parsed.search}${parsed.hash}`
  } catch {
    return trimmed.replace(/\/v1\/?$/i, '')
  }
}

export function isAnthropicCompatibilityMode(): boolean {
  return getAnthropicCompatMode() !== 'native'
}

export function isOllamaCompatMode(): boolean {
  return getAnthropicCompatMode() === 'ollama'
}

export function shouldStripAnthropicOnlyRequestFields(): boolean {
  return isAnthropicCompatibilityMode()
}

export function shouldDisablePromptCachingForCompatibility(): boolean {
  return isAnthropicCompatibilityMode()
}

export function shouldUseCompatibilityTokenEstimation(): boolean {
  return isAnthropicCompatibilityMode()
}

export function shouldIncludeToolChoiceForRequest(params: {
  hasTools: boolean
  toolChoice: unknown
}): boolean {
  return params.hasTools && params.toolChoice !== undefined
}

export function getCompatibilityPromptAddendum(): string | null {
  if (!isAnthropicCompatibilityMode()) {
    return null
  }

  return `This session may run against an Anthropic-compatible local backend instead of Anthropic's native API. Do not emit faux tool-call wrappers, XML envelopes, or chain-of-thought tags. If tools are unavailable, respond with normal assistant text only. If tools are available, either respond normally or produce at most one strict tool invocation with valid JSON arguments. Use the exact runtime tool name and exact parameter names from the provided schema. If a tool call fails and the system returns a repair template, follow that template exactly on the next attempt.`
}
