type RuntimeMacro = {
  VERSION: string
  BUILD_TIME: string
  PACKAGE_URL: string
  ISSUES_EXPLAINER: string
  [key: string]: string
}

const runtimeMacro = new Proxy<RuntimeMacro>(
  {
    VERSION: process.env.CLAUDE_CODE_VERSION ?? '2.1.88',
    BUILD_TIME: process.env.CLAUDE_CODE_BUILD_TIME ?? '',
    PACKAGE_URL:
      process.env.CLAUDE_CODE_PACKAGE_URL ?? '@anthropic-ai/claude-code',
    ISSUES_EXPLAINER:
      process.env.CLAUDE_CODE_ISSUES_EXPLAINER ??
      'use /issue for model problems or /share for product bugs when those commands are available',
  },
  {
    get(target, prop) {
      if (typeof prop === 'string' && prop in target) {
        return target[prop]
      }
      return ''
    },
  },
)

;(globalThis as typeof globalThis & { MACRO?: RuntimeMacro }).MACRO ??=
  runtimeMacro

export const RUNTIME_MACRO = runtimeMacro
