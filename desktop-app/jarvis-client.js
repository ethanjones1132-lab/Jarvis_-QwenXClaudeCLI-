const MAX_TRANSCRIPT_EVENTS = 300
const NEAR_BOTTOM_THRESHOLD = 72
const PET_BURST_MS = 2500
const QUIET_INFO_LABELS = new Set([
  'Launcher ready',
  'Configuration',
  'Launch mode',
  'Conversation restored',
  'Session initialized',
])

const VIEW_META = {
  chat: {
    title: 'Mission Control',
    summary:
      'Jarvis is ready to connect your desktop tool loop to the remote GPT-OSS server.',
  },
  autodream: {
    title: 'AutoDream',
    summary:
      'Track consolidation cadence, gates, and memory-dream readiness without leaving the chat shell.',
  },
  memory: {
    title: 'Memory',
    summary:
      'Inspect the skeptical MEMORY.md pointer index and keep the long-term context discipline tight.',
  },
  integrations: {
    title: 'Integrations',
    summary:
      'Build out a saved API registry now so Jarvis can grow into a cleaner connector browser later.',
  },
  companion: {
    title: 'Companion',
    summary:
      'Keep the mission companion close by while the main chat stays focused on work.',
  },
}

const BACKEND_LABELS = {
  'remote-glm': 'GPT-OSS Server',
  ollama: 'Local Runtime',
  anthropic: 'Anthropic',
}

const RUNTIME_MODE_LABELS = {
  idle: 'Idle',
  anthropic: 'Anthropic',
  'remote-glm': 'Remote GPT-OSS',
  'ollama-safe': 'Local safe mode',
  'ollama-experimental': 'Local tools',
  'ollama-shared': 'Local shared runtime',
  'ollama-legacy': 'Local legacy runtime',
}

const LANE_LABELS = {
  'gpt-oss-auto': 'Auto',
  'gpt-oss-120b': '120B',
  'gpt-oss-20b': '20B',
  'openai/gpt-oss-120b': '120B',
  'openai/gpt-oss-20b': '20B',
}

const state = {
  config: null,
  runtime: {
    running: false,
    busy: false,
    label: 'Idle',
    tone: 'idle',
    backend: null,
    mode: 'idle',
    model: '',
    workspacePath: '',
    sessionId: null,
  },
  modelCatalog: null,
  features: null,
  shell: {
    uiState: {
      activeView: 'chat',
      advancedSettingsOpen: false,
      selectedIntegrationId: null,
    },
    integrations: [],
  },
  events: [],
  pendingPermissions: [],
  remoteHealth: null,
  transcriptAttached: true,
  transcriptHasUnseenBelow: false,
  transcriptInitialized: false,
  transcriptProgrammaticScroll: false,
  transcriptLastScrollTop: 0,
  transcriptLastEntryCount: 0,
  integrationFilter: 'all',
  integrationDrafting: false,
  eventSource: null,
  notice: null,
  noticeTimer: null,
  companionDockVisible: true,
  companionPetBurstUntil: 0,
}

const refs = {
  navChat: byId('navChat'),
  navAutoDream: byId('navAutoDream'),
  navMemory: byId('navMemory'),
  navIntegrations: byId('navIntegrations'),
  navCompanion: byId('navCompanion'),
  sidebarRuntime: byId('sidebarRuntime'),
  sidebarWorkspace: byId('sidebarWorkspace'),
  toggleAdvanced: byId('toggleAdvanced'),
  viewTitle: byId('viewTitle'),
  sessionSummary: byId('sessionSummary'),
  status: byId('status'),
  heroMode: byId('heroMode'),
  headerRuntimePills: byId('headerRuntimePills'),
  viewChat: byId('view-chat'),
  viewAutodream: byId('view-autodream'),
  viewMemory: byId('view-memory'),
  viewIntegrations: byId('view-integrations'),
  viewCompanion: byId('view-companion'),
  remoteHealthStatus: byId('remoteHealthStatus'),
  remoteHealthModel: byId('remoteHealthModel'),
  localFallbackLabel: byId('localFallbackLabel'),
  runtimePills: byId('runtimePills'),
  checkRemoteHealth: byId('checkRemoteHealth'),
  clearTranscript: byId('clearTranscript'),
  transcriptScroll: byId('transcriptScroll'),
  transcript: byId('transcript'),
  chatEmptyState: byId('chatEmptyState'),
  jumpLatestWrap: byId('jumpLatestWrap'),
  jumpLatest: byId('jumpLatest'),
  autodreamContent: byId('autodreamContent'),
  memoryContent: byId('memoryContent'),
  integrationSearch: byId('integrationSearch'),
  integrationFilterAll: byId('integrationFilterAll'),
  integrationFilterReady: byId('integrationFilterReady'),
  integrationFilterDraft: byId('integrationFilterDraft'),
  integrationFilterPaused: byId('integrationFilterPaused'),
  addIntegration: byId('addIntegration'),
  integrationList: byId('integrationList'),
  integrationEditorState: byId('integrationEditorState'),
  integrationId: byId('integrationId'),
  integrationName: byId('integrationName'),
  integrationCategory: byId('integrationCategory'),
  integrationBaseUrl: byId('integrationBaseUrl'),
  integrationAuthMode: byId('integrationAuthMode'),
  integrationStatus: byId('integrationStatus'),
  integrationTags: byId('integrationTags'),
  integrationNotes: byId('integrationNotes'),
  saveIntegration: byId('saveIntegration'),
  cancelIntegration: byId('cancelIntegration'),
  deleteIntegration: byId('deleteIntegration'),
  companionLarge: byId('companionLarge'),
  companionNotes: byId('companionNotes'),
  composerModeChip: byId('composerModeChip'),
  promptInput: byId('promptInput'),
  sendPrompt: byId('sendPrompt'),
  interruptSession: byId('interruptSession'),
  stopSession: byId('stopSession'),
  configForm: byId('config-form'),
  backend: byId('backend'),
  backendRemote: byId('backendRemote'),
  backendLocal: byId('backendLocal'),
  backendAnthropic: byId('backendAnthropic'),
  remoteFields: byId('remote-fields'),
  remoteGlmBaseUrl: byId('remoteGlmBaseUrl'),
  remoteGlmApiKey: byId('remoteGlmApiKey'),
  remoteGlmModel: byId('remoteGlmModel'),
  remoteLaneAuto: byId('remoteLaneAuto'),
  remoteLane120: byId('remoteLane120'),
  remoteLane20: byId('remoteLane20'),
  ollamaFields: byId('ollama-fields'),
  ollamaBaseUrl: byId('ollamaBaseUrl'),
  ollamaModelPreset: byId('ollamaModelPreset'),
  ollamaModel: byId('ollamaModel'),
  anthropicFields: byId('anthropic-fields'),
  anthropicModel: byId('anthropicModel'),
  anthropicApiKey: byId('anthropicApiKey'),
  anthropicBaseUrl: byId('anthropicBaseUrl'),
  workspacePath: byId('workspacePath'),
  appendSystemPrompt: byId('appendSystemPrompt'),
  coordinatorMode: byId('coordinatorMode'),
  disableToolsForLocal: byId('disableToolsForLocal'),
  enableExperimentalLocalTools: byId('enableExperimentalLocalTools'),
  disableNonessentialTraffic: byId('disableNonessentialTraffic'),
  disableThinkingForLocal: byId('disableThinkingForLocal'),
  launchSession: byId('launchSession'),
  saveConfig: byId('saveConfig'),
  toggleAdvancedInline: byId('toggleAdvancedInline'),
  advancedSettings: byId('advancedSettings'),
  modelSpotlight: byId('modelSpotlight'),
  permissionDock: byId('permissionDock'),
  permissionCount: byId('permissionCount'),
  permissionList: byId('permissionList'),
  companionDock: byId('companionDock'),
  companionDockBubble: byId('companionDockBubble'),
  companionPetBurst: byId('companionPetBurst'),
  buddyDockName: byId('buddyDockName'),
  buddyDockMeta: byId('buddyDockMeta'),
  buddyDockFace: byId('buddyDockFace'),
  buddyDockIdentity: byId('buddyDockIdentity'),
  buddyDockActions: byId('buddyDockActions'),
  buddyName: byId('buddyName'),
  buddyMeta: byId('buddyMeta'),
  buddyFace: byId('buddyFace'),
  buddyBubble: byId('buddyBubble'),
  buddySprite: byId('buddySprite'),
  buddyStats: byId('buddyStats'),
}

boot().catch(error => {
  console.error(error)
  setNotice(error instanceof Error ? error.message : String(error), 'error')
  renderChrome()
})

async function boot() {
  wireStaticEvents()
  await loadInitialState()
  applyConfigToForm(state.config)
  promoteRemotePrimary()
  populateModelOptions()
  renderFeatureViews()
  renderIntegrationList()
  hydrateIntegrationEditor()
  renderAll()
  connectEvents()
  if (shouldCheckRemoteHealth()) {
    await refreshRemoteHealth().catch(handleActionError)
  }
}

function byId(id) {
  return document.getElementById(id)
}

function wireStaticEvents() {
  refs.navChat.addEventListener('click', () => setActiveView('chat'))
  refs.navAutoDream.addEventListener('click', () => setActiveView('autodream'))
  refs.navMemory.addEventListener('click', () => setActiveView('memory'))
  refs.navIntegrations.addEventListener('click', () => setActiveView('integrations'))
  refs.navCompanion.addEventListener('click', () => setActiveView('companion'))

  refs.toggleAdvanced.addEventListener('click', () => toggleAdvancedSettings())
  refs.toggleAdvancedInline.addEventListener('click', () => toggleAdvancedSettings())

  refs.backendRemote.addEventListener('click', () => setBackend('remote-glm'))
  refs.backendLocal.addEventListener('click', () => setBackend('ollama'))
  refs.backendAnthropic.addEventListener('click', () => setBackend('anthropic'))

  refs.remoteLaneAuto.addEventListener('click', () => setRemoteLane('gpt-oss-auto'))
  refs.remoteLane120.addEventListener('click', () => setRemoteLane('gpt-oss-120b'))
  refs.remoteLane20.addEventListener('click', () => setRemoteLane('gpt-oss-20b'))

  refs.configForm.addEventListener('submit', async event => {
    event.preventDefault()
    await saveConfigFromForm().catch(handleActionError)
  })

  refs.launchSession.addEventListener('click', async () => {
    await launchSessionFromForm().catch(handleActionError)
  })

  refs.checkRemoteHealth.addEventListener('click', async () => {
    await refreshRemoteHealth().catch(handleActionError)
  })

  refs.clearTranscript.addEventListener('click', async () => {
    await postJson('/api/transcript/clear', {})
  })

  refs.sendPrompt.addEventListener('click', async () => {
    await sendPromptFromComposer().catch(handleActionError)
  })

  refs.promptInput.addEventListener('keydown', async event => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault()
      await sendPromptFromComposer().catch(handleActionError)
    }
  })

  refs.interruptSession.addEventListener('click', async () => {
    await postJson('/api/session/interrupt', {})
  })

  refs.stopSession.addEventListener('click', async () => {
    await postJson('/api/session/stop', {})
  })

  refs.ollamaModelPreset.addEventListener('change', () => {
    refs.ollamaModel.value = refs.ollamaModelPreset.value
    renderChrome()
  })

  refs.integrationSearch.addEventListener('input', () => {
    renderIntegrationList()
  })

  refs.integrationFilterAll.addEventListener('click', () => setIntegrationFilter('all'))
  refs.integrationFilterReady.addEventListener('click', () => setIntegrationFilter('ready'))
  refs.integrationFilterDraft.addEventListener('click', () => setIntegrationFilter('draft'))
  refs.integrationFilterPaused.addEventListener('click', () => setIntegrationFilter('paused'))
  refs.addIntegration.addEventListener('click', () => openNewIntegration())
  refs.saveIntegration.addEventListener('click', async () => {
    await saveIntegrationFromEditor().catch(handleActionError)
  })
  refs.cancelIntegration.addEventListener('click', () => hydrateIntegrationEditor())
  refs.deleteIntegration.addEventListener('click', async () => {
    await deleteSelectedIntegration().catch(handleActionError)
  })

  refs.integrationList.addEventListener('click', event => {
    const target = event.target instanceof Element ? event.target : null
    const card = target?.closest('[data-integration-id]')
    if (!card) {
      return
    }
    selectIntegration(card.getAttribute('data-integration-id'))
  })

  refs.permissionList.addEventListener('click', async event => {
    const target = event.target instanceof Element ? event.target : null
    const button = target?.closest('[data-permission-id]')
    if (!button) {
      return
    }
    const requestId = button.getAttribute('data-permission-id')
    const decision = button.getAttribute('data-permission-decision')
    if (!requestId || (decision !== 'allow' && decision !== 'deny')) {
      return
    }
    await postJson('/api/session/permission', { requestId, decision }).catch(
      handleActionError,
    )
  })

  refs.transcriptScroll.addEventListener('scroll', onTranscriptScroll)
  refs.jumpLatest.addEventListener('click', () => {
    attachTranscriptToLatest()
  })

  refs.buddyDockActions.addEventListener('click', async event => {
    const target = event.target instanceof Element ? event.target : null
    const button = target?.closest('[data-companion-action]')
    if (!button) {
      return
    }
    const action = button.getAttribute('data-companion-action')
    if (!action) {
      return
    }
    await runCompanionAction(action).catch(handleActionError)
  })

  window.addEventListener('beforeunload', () => {
    if (state.eventSource) {
      state.eventSource.close()
    }
  })
}

async function loadInitialState() {
  const [config, modelCatalog, features, shell] = await Promise.all([
    fetchJson('/api/config'),
    fetchJson('/api/models'),
    fetchJson('/api/features'),
    fetchJson('/api/shell'),
  ])

  state.config = config
  state.modelCatalog = modelCatalog
  state.features = features
  state.shell = {
    uiState: shell?.uiState ?? state.shell.uiState,
    integrations: Array.isArray(shell?.integrations) ? shell.integrations : [],
  }
}

function connectEvents() {
  if (state.eventSource) {
    state.eventSource.close()
  }

  const eventSource = new EventSource('/api/events')
  state.eventSource = eventSource

  eventSource.onmessage = event => {
    const payload = JSON.parse(event.data)
    handleSsePayload(payload)
  }

  eventSource.onerror = () => {
    state.notice = {
      tone: 'warning',
      message:
        'Live event stream disconnected. Jarvis will reconnect when the launcher becomes reachable again.',
    }
    renderChrome()
  }
}

function handleSsePayload(payload) {
  if (payload.type === 'snapshot') {
    state.runtime = payload.state ?? state.runtime
    state.pendingPermissions = Array.isArray(payload.pendingPermissions)
      ? payload.pendingPermissions
      : []
    state.events = Array.isArray(payload.events)
      ? payload.events.slice(-MAX_TRANSCRIPT_EVENTS)
      : []
    renderAll()
    return
  }

  if (payload.type === 'state') {
    state.runtime = payload.state ?? state.runtime
  }

  if (payload.type === 'permission') {
    state.pendingPermissions = upsertPermission(
      state.pendingPermissions,
      payload,
    )
  } else if (payload.type === 'permission_resolved') {
    state.pendingPermissions = state.pendingPermissions.filter(
      item => item.requestId !== payload.requestId,
    )
  }

  state.events = [...state.events, payload].slice(-MAX_TRANSCRIPT_EVENTS)
  renderAll()
}

function upsertPermission(list, permission) {
  const next = list.filter(item => item.requestId !== permission.requestId)
  next.push(permission)
  return next
}

function renderAll() {
  renderNav()
  renderChrome()
  renderBackendControls()
  renderRemoteHealth()
  renderModelSpotlight()
  renderTranscript()
  renderPermissions()
  renderFeatureViews()
  renderCompanionRail()
}

function renderNav() {
  const activeView = state.shell.uiState.activeView
  setClass(refs.navChat, 'active', activeView === 'chat')
  setClass(refs.navAutoDream, 'active', activeView === 'autodream')
  setClass(refs.navMemory, 'active', activeView === 'memory')
  setClass(refs.navIntegrations, 'active', activeView === 'integrations')
  setClass(refs.navCompanion, 'active', activeView === 'companion')

  setClass(refs.viewChat, 'hidden', activeView !== 'chat')
  setClass(refs.viewAutodream, 'hidden', activeView !== 'autodream')
  setClass(refs.viewMemory, 'hidden', activeView !== 'memory')
  setClass(refs.viewIntegrations, 'hidden', activeView !== 'integrations')
  setClass(refs.viewCompanion, 'hidden', activeView !== 'companion')
}

function renderChrome() {
  const currentConfig = getCurrentConfig()
  const viewMeta = VIEW_META[state.shell.uiState.activeView] ?? VIEW_META.chat
  const runtimeSummary = buildRuntimeSummary(currentConfig)
  const isSessionActive = state.runtime.running || state.runtime.busy
  const displayLabel = isSessionActive ? state.runtime.label || 'Working' : 'Idle'
  const displayTone = isSessionActive ? state.runtime.tone : 'idle'

  refs.viewTitle.textContent = viewMeta.title
  refs.sessionSummary.textContent =
    state.notice?.message || runtimeSummary || viewMeta.summary
  refs.status.textContent = displayLabel
  refs.status.className = `status-pill ${toneClass(displayTone)}`
  refs.heroMode.textContent = buildHeroMode(currentConfig)
  refs.headerRuntimePills.innerHTML = renderPillRow(
    buildHeaderPills(currentConfig),
  )
  refs.runtimePills.innerHTML = renderPillRow(buildRuntimePills(currentConfig))
  refs.composerModeChip.textContent = state.runtime.busy
    ? 'Working'
    : state.runtime.running
      ? 'Session live'
      : 'Idle'
  refs.composerModeChip.className = `chip ${toneClass(
    state.runtime.busy ? 'running' : state.runtime.running ? 'running' : 'idle',
  )}`.trim()

  refs.sidebarRuntime.innerHTML = `
    <div><strong style="display:block;margin-bottom:4px;color:var(--text);font-size:11px;letter-spacing:.12em;text-transform:uppercase">Runtime</strong></div>
    <div>${escapeHtml(isSessionActive ? state.runtime.label || 'Working' : 'No live session')}</div>
    <div style="margin-top:6px">${escapeHtml(buildHeroMode(currentConfig))}</div>
  `
  refs.sidebarWorkspace.textContent =
    currentConfig.workspacePath || state.runtime.workspacePath || 'Not set'

  refs.sendPrompt.disabled = !state.runtime.running || state.runtime.busy
  refs.interruptSession.disabled = !state.runtime.busy
  refs.stopSession.disabled = !state.runtime.running

  refs.promptInput.placeholder = state.runtime.running
    ? 'Send a prompt into the active Jarvis session. Ctrl or Cmd plus Enter also sends.'
    : 'Launch a session first, then send a prompt into Jarvis.'
}

function renderRemoteHealth() {
  const health = state.remoteHealth
  const currentConfig = getCurrentConfig()
  const lane = laneLabel(currentConfig.remoteGlmModel || state.runtime.model)
  const primaryModel = health?.upstreams?.primary?.model
  const fastModel = health?.upstreams?.fast?.model

  if (!health) {
    refs.remoteHealthStatus.textContent = 'Not checked'
  } else if (health.ok) {
    refs.remoteHealthStatus.textContent = 'Ready'
  } else {
    refs.remoteHealthStatus.textContent = health.ready ? 'Reachable' : 'Needs attention'
  }

  refs.remoteHealthModel.textContent = [lane, primaryModel, fastModel]
    .filter(Boolean)
    .join(' / ') || lane

  const recommendedFallback = state.modelCatalog?.models?.find(
    model => model.role === 'default',
  )
  refs.localFallbackLabel.textContent =
    recommendedFallback?.installed
      ? recommendedFallback.label
      : recommendedFallback
        ? `${recommendedFallback.label} not installed`
        : 'No local fallback detected'

  refs.checkRemoteHealth.textContent = health?.ok
    ? 'Recheck server'
    : 'Check server'
}

function renderModelSpotlight() {
  const models = Array.isArray(state.modelCatalog?.models)
    ? state.modelCatalog.models
    : []

  if (models.length === 0) {
    refs.modelSpotlight.innerHTML = `
      <div class="mini-card">
        <strong>Local runtime</strong>
        <div class="muted">Jarvis did not find any local Ollama models yet.</div>
      </div>
    `
    return
  }

  const currentModel = getCurrentConfig().ollamaModel
  refs.modelSpotlight.innerHTML = models
    .map(model => {
      const installedLabel = model.installed ? 'Installed' : 'Not installed'
      const emphasis =
        model.id === currentModel
          ? ' style="border-color:rgba(83,211,180,.24);background:rgba(83,211,180,.08)"'
          : ''
      return `
        <div class="mini-card"${emphasis}>
          <strong>${escapeHtml(model.role === 'default' ? 'Recommended local model' : 'Alternate local model')}</strong>
          <div style="font-weight:700">${escapeHtml(model.label)}</div>
          <div class="tag-list">
            <span class="tag">${escapeHtml(installedLabel)}</span>
            <span class="tag">${escapeHtml(model.recommendedMode)}</span>
            <span class="tag">${escapeHtml(model.toolReadiness)}</span>
          </div>
          <p class="muted" style="margin-top:10px">${escapeHtml(model.description)}</p>
        </div>
      `
    })
    .join('')
}

function renderTranscript() {
  const entries = buildTranscriptEntries(state.events)
  const entryCountChanged = entries.length !== state.transcriptLastEntryCount
  const shouldStickToLatest =
    state.transcriptAttached || !state.transcriptInitialized

  refs.chatEmptyState.classList.toggle('hidden', entries.length > 0)
  refs.transcript.innerHTML =
    (entries.length === 0 ? '' : entries.map(renderTranscriptEntry).join('')) +
    refs.chatEmptyState.outerHTML

  requestAnimationFrame(() => {
    const emptyState = byId('chatEmptyState')
    if (emptyState) {
      emptyState.classList.toggle('hidden', entries.length > 0)
    }

    if (shouldStickToLatest) {
      scrollTranscriptToBottom()
      state.transcriptAttached = true
      state.transcriptHasUnseenBelow = false
    } else if (entryCountChanged) {
      state.transcriptHasUnseenBelow = true
    }
    state.transcriptInitialized = true
    state.transcriptLastEntryCount = entries.length
    syncJumpLatest()
    renderCompanionRail()
  })
}

function buildTranscriptEntries(events) {
  return events.flatMap(event => {
    if (event.type === 'message') {
      return normalizeMessageEvent(event.message)
    }
    if (event.type === 'info') {
      if (QUIET_INFO_LABELS.has(event.label)) {
        return []
      }
      return [
        {
          kind: 'timeline',
          label: event.label || 'Runtime',
          tone: 'idle',
          body: event.body || '',
          chips: [],
          details: [],
        },
      ]
    }
    if (event.type === 'stderr') {
      return [
        {
          kind: 'timeline',
          label: 'Runtime',
          tone: 'error',
          body: event.line || '',
          chips: ['stderr'],
          details: [],
        },
      ]
    }
    if (event.type === 'permission') {
      return [
        {
          kind: 'timeline',
          label: 'Permission requested',
          tone: 'warning',
          body:
            event.description ||
            `${event.toolName} is waiting for approval in the safety rail.`,
          chips: [event.toolName],
          details: [
            {
              title: 'Tool input',
              body: stringifyForDetail(event.input),
            },
          ],
        },
      ]
    }
    if (event.type === 'permission_resolved' || event.type === 'state') {
      return []
    }
    return []
  })
}

function normalizeMessageEvent(message) {
  if (!message || typeof message !== 'object') {
    return [
      {
        kind: 'timeline',
        label: 'Event',
        tone: 'idle',
        body: stringifyForDetail(message),
        chips: [],
        details: [],
      },
    ]
  }

  const role = message.type || message.message?.role
  if (role === 'user' || message.message?.role === 'user') {
    return [normalizeUserEntry(message)]
  }
  if (role === 'assistant' || message.message?.role === 'assistant') {
    return [normalizeAssistantEntry(message)]
  }
  if (role === 'result') {
    return [
      {
        kind: 'timeline',
        label: 'Result',
        tone:
          message.subtype === 'error_max_turns' || message.subtype === 'error_during_execution'
            ? 'error'
            : 'idle',
        body:
          message.subtype === 'success'
            ? 'Jarvis completed a turn.'
            : message.result || message.subtype || 'A result event was received.',
        chips: message.subtype ? [message.subtype] : [],
        details: [
          {
            title: 'Raw event',
            body: stringifyForDetail(message),
          },
        ],
      },
    ]
  }

  return [
    {
      kind: 'timeline',
      label: titleCase(String(role || 'event')),
      tone: 'idle',
      body: summarizeUnknownMessage(message),
      chips: [],
      details: [
        {
          title: 'Raw event',
          body: stringifyForDetail(message),
        },
      ],
    },
  ]
}

function normalizeUserEntry(message) {
  const content = message.message?.content ?? message.content ?? ''
  const text = extractTextContent(content)
  const details = extractToolResults(content)

  return {
    kind: 'message',
    role: 'user',
    speaker: 'You',
    body: text || 'Sent a user message.',
    chips: details.length > 0 ? ['tool result'] : [],
    details,
  }
}

function normalizeAssistantEntry(message) {
  const content = message.message?.content ?? message.content ?? []
  const text = message.content && typeof message.content === 'string'
    ? message.content
    : extractTextContent(content)
  const thinkingBlocks = extractBlocksByType(content, 'thinking')
  const toolUses = extractBlocksByType(content, 'tool_use').concat(
    extractBlocksByType(content, 'server_tool_use'),
  )
  const redactedThinking = extractBlocksByType(content, 'redacted_thinking')

  const details = []
  if (thinkingBlocks.length > 0) {
    details.push({
      title: 'Thinking',
      body: thinkingBlocks
        .map(block => block.thinking || block.text || stringifyForDetail(block))
        .join('\n\n'),
    })
  }
  if (redactedThinking.length > 0) {
    details.push({
      title: 'Redacted thinking',
      body: `Jarvis received ${redactedThinking.length} redacted thinking block${redactedThinking.length === 1 ? '' : 's'}.`,
    })
  }
  for (const tool of toolUses) {
    details.push({
      title: `Tool input: ${tool.name || 'Unnamed tool'}`,
      body: stringifyForDetail(tool.input ?? tool),
    })
  }

  return {
    kind: 'message',
    role: 'assistant',
    speaker: 'Jarvis',
    body:
      text ||
      (toolUses.length > 0
        ? 'Issued tool calls and is waiting for the local execution loop.'
        : 'Assistant response received.'),
    chips: [
      ...(thinkingBlocks.length > 0 ? ['thinking'] : []),
      ...toolUses.map(tool => tool.name || 'tool'),
    ],
    details,
  }
}

function renderTranscriptEntry(entry) {
  const rowClass =
    entry.kind === 'timeline'
      ? 'timeline'
      : entry.role === 'user'
        ? 'user'
        : 'assistant'
  const cardClass =
    entry.kind === 'timeline'
      ? 'timeline'
      : entry.role === 'user'
        ? 'user'
        : 'assistant'

  return `
    <div class="entry-row ${rowClass}">
      <article class="entry-card ${cardClass}">
        <div class="entry-head">
          <strong>${escapeHtml(entry.speaker || entry.label || 'Jarvis')}</strong>
          <span>${escapeHtml(entry.label && entry.speaker ? entry.label : '')}</span>
        </div>
        ${
          entry.chips?.length
            ? `<div class="entry-badges">${entry.chips
                .map(chip => `<span class="chip">${escapeHtml(chip)}</span>`)
                .join('')}</div>`
            : ''
        }
        <div class="message-body">${escapeHtml(entry.body || '')}</div>
        ${
          entry.details?.length
            ? `<div class="entry-detail">${entry.details
                .map(
                  detail => `
                    <details>
                      <summary>${escapeHtml(detail.title)}</summary>
                      <pre>${escapeHtml(detail.body)}</pre>
                    </details>
                  `,
                )
                .join('')}</div>`
            : ''
        }
      </article>
    </div>
  `
}

function renderPermissions() {
  const permissions = Array.isArray(state.pendingPermissions)
    ? state.pendingPermissions
    : []

  setClass(refs.permissionDock, 'hidden', permissions.length === 0)
  refs.permissionCount.textContent = String(permissions.length)
  refs.permissionList.innerHTML = permissions
    .map(
      permission => `
        <div class="permission-item">
          <div class="entry-head" style="margin-bottom:8px">
            <strong>${escapeHtml(permission.toolName)}</strong>
            <span>${escapeHtml(permission.description || 'Awaiting your decision')}</span>
          </div>
          <div class="inline-actions">
            <button
              class="primary-button"
              type="button"
              data-permission-id="${escapeHtml(permission.requestId)}"
              data-permission-decision="allow"
            >
              Allow
            </button>
            <button
              class="danger-button"
              type="button"
              data-permission-id="${escapeHtml(permission.requestId)}"
              data-permission-decision="deny"
            >
              Deny
            </button>
          </div>
          <pre>${escapeHtml(stringifyForDetail(permission.input))}</pre>
        </div>
      `,
    )
    .join('')
}

function renderFeatureViews() {
  renderAutoDream()
  renderMemory()
  renderCompanionLarge()
}

function renderAutoDream() {
  const dream = state.features?.autoDream
  const coordinator = state.features?.coordinator
  if (!dream) {
    refs.autodreamContent.innerHTML = ''
    return
  }

  refs.autodreamContent.innerHTML = [
    metricCard(
      'Readiness',
      dream.ready ? 'Ready soon' : 'Waiting',
      dream.lockStatus,
      3,
    ),
    metricCard(
      'Sessions since last pass',
      String(dream.sessionsSinceLast),
      `Target: ${dream.minSessions} sessions`,
      3,
    ),
    metricCard(
      'Time gate',
      `${dream.minHours}h`,
      dream.lastConsolidatedAt
        ? `Last consolidation: ${formatDateTime(dream.lastConsolidatedAt)}`
        : 'No consolidation recorded yet.',
      3,
    ),
    metricCard(
      'Phases',
      dream.phases.join(' -> '),
      'Orient the context, gather sessions, consolidate the memory graph, then prune.',
      3,
    ),
    featureCard(
      'Gate status',
      dream.lockStatus,
      dream.ready ? ['next pass available'] : ['waiting'],
      6,
    ),
    featureCard(
      'Coordinator posture',
      coordinator?.active
        ? 'Coordinator mode is active for native-tool sessions.'
        : 'Coordinator mode is available but currently off.',
      coordinator
        ? [
            `${coordinator.coordinatorTools.length} coordinator tools`,
            `${coordinator.workerTools.length} worker tools`,
          ]
        : [],
      6,
    ),
  ].join('')
}

function renderMemory() {
  const memory = state.features?.memory
  if (!memory) {
    refs.memoryContent.innerHTML = ''
    return
  }

  refs.memoryContent.innerHTML = [
    metricCard(
      'Indexed lines',
      String(memory.lineCount),
      `Preview limit: ${memory.maxLines} lines`,
      3,
    ),
    metricCard(
      'Entrypoint',
      fileName(memory.entrypointPath),
      memory.entrypointPath,
      3,
    ),
    metricCard(
      'Memory dir',
      fileName(memory.memoryDir),
      memory.memoryDir,
      3,
    ),
    metricCard(
      'Mode',
      memory.enabled ? 'Enabled' : 'Disabled',
      'Jarvis treats remembered facts as hints and verifies them against the codebase before acting.',
      3,
    ),
    `
      <div class="memory-preview" style="grid-column: span 7">
        <strong style="display:block;margin-bottom:10px;color:var(--muted);font-size:11px;letter-spacing:.12em;text-transform:uppercase">Preview</strong>
        <pre style="white-space:pre-wrap;word-break:break-word;font-family:'Cascadia Code','IBM Plex Mono','Courier New',monospace;color:#dfe8f6">${escapeHtml(
          memory.preview.join('\n'),
        )}</pre>
        ${
          memory.previewTruncated
            ? '<div class="hint" style="margin-top:10px">Preview truncated for the launcher surface.</div>'
            : ''
        }
      </div>
    `,
    featureCard(
      'Rules',
      memory.rules.join(' '),
      memory.rules,
      5,
    ),
  ].join('')
}

function buildCompanionDockLine(buddy) {
  if (!buddy.hatched) {
    return 'Hatch a companion to bind its soul to this Jarvis identity. /buddy works too.'
  }
  if (buddy.muted) {
    return ''
  }
  if (buddy.reaction) {
    return buddy.reaction
  }
  if (state.runtime.busy) {
    return `${buddy.name} is tracking the live turn and keeping the rail calm.`
  }
  if (state.runtime.running) {
    return `${buddy.name} is watching the live edge beside your prompt rail.`
  }
  return `${buddy.name} is ready for the next run.`
}

function renderCompanionActionButtons(actions, options = {}) {
  const actionSet = Array.isArray(actions) ? actions : []
  const includeProfile = options.includeProfile !== false
  const visibleActions = actionSet.filter(action =>
    options.dock
      ? action === 'hatch' || action === 'pet' || action === 'mute' || action === 'unmute'
      : true,
  )
  const buttons = visibleActions.map(action => {
    const label =
      action === 'rehatch'
        ? 'Re-hatch'
        : action === 'unmute'
          ? 'Unmute'
          : titleCase(action)
    const className =
      action === 'reset'
        ? 'danger-button'
        : action === 'hatch' || action === 'pet'
          ? 'primary-button'
          : 'soft-button'
    return `<button class="${className}" type="button" data-companion-action="${escapeHtml(
      action,
    )}">${escapeHtml(label)}</button>`
  })

  if (includeProfile) {
    buttons.push(
      '<button class="ghost-button" type="button" data-companion-action="open-profile">Open profile</button>',
    )
  }

  return buttons.join('')
}

function renderCompanionRail() {
  const buddy = state.features?.buddy
  const shouldShowDock =
    Boolean(buddy) &&
    state.shell.uiState.activeView === 'chat' &&
    state.transcriptAttached &&
    state.companionDockVisible

  setClass(refs.companionDock, 'hidden', !shouldShowDock)
  if (!buddy) {
    return
  }

  refs.buddyDockName.textContent = buddy.hatched ? buddy.name : 'Dormant companion'
  refs.buddyDockMeta.textContent = buddy.hatched
    ? `${titleCase(buddy.rarity)} ${buddy.species} / ${buddy.personality}`
    : `${titleCase(buddy.rarity)} ${buddy.species} waiting for its first hatch`
  refs.buddyDockFace.textContent = buddy.face
  refs.buddyDockIdentity.textContent = buddy.hatched
    ? `Identity-bound to ${buddy.identityLabel}. Re-hatching changes the soul, not the species, rarity, or stats.`
    : `Identity-bound to ${buddy.identityLabel}. Hatch to reveal the soul while the identity-driven bones stay fixed.`
  refs.buddyDockActions.innerHTML = renderCompanionActionButtons(
    buddy.availableActions,
    { dock: true },
  )

  const bubble = buildCompanionDockLine(buddy)
  refs.companionDockBubble.textContent = bubble
  setClass(
    refs.companionDockBubble,
    'hidden',
    !bubble || (buddy.muted && buddy.hatched),
  )

  setClass(
    refs.companionPetBurst,
    'hidden',
    Date.now() >= state.companionPetBurstUntil,
  )
}

function renderCompanionLarge() {
  const buddy = state.features?.buddy
  const coordinator = state.features?.coordinator
  if (!buddy) {
    refs.companionLarge.innerHTML = ''
    refs.companionNotes.innerHTML = ''
    return
  }

  const headline = buddy.hatched ? buddy.name : 'Dormant companion'
  const subhead = buddy.hatched
    ? `${titleCase(buddy.rarity)} ${buddy.species} with a ${buddy.personality} streak.`
    : `${titleCase(buddy.rarity)} ${buddy.species} bones are already keyed to ${buddy.identityLabel}. Hatch to discover the soul.`

  refs.companionLarge.innerHTML = `
    <div class="feature-card">
      <strong>Companion profile</strong>
      <div style="display:flex;justify-content:space-between;gap:18px;align-items:flex-start">
        <div>
          <div style="font-size:28px;font-weight:700">${escapeHtml(headline)}</div>
          <div class="muted" style="margin-top:8px">${escapeHtml(subhead)}</div>
          <div class="hint" style="margin-top:12px">
            ${escapeHtml(
              buddy.hatched && buddy.hatchedAt
                ? `Hatched ${formatDateTime(buddy.hatchedAt)}.`
                : 'Not hatched yet. /buddy and the dock hatch CTA both use the same lifecycle.',
            )}
          </div>
        </div>
        <div class="companion-face" style="width:72px;height:72px;font-size:20px">${escapeHtml(
          buddy.face,
        )}</div>
      </div>
      <div class="inline-actions" style="margin-top:16px">
        ${renderCompanionActionButtons(buddy.availableActions, { includeProfile: false })}
      </div>
      <pre class="sprite" style="margin-top:16px">${escapeHtml(
        Array.isArray(buddy.sprite) ? buddy.sprite.join('\n') : '',
      )}</pre>
      <div class="companion-stats" style="margin-top:16px">
        ${Object.entries(buddy.stats ?? {})
          .map(
            ([name, value]) => `
              <div class="companion-stat">
                <span>${escapeHtml(name)}</span>
                <strong>${escapeHtml(String(value))}</strong>
              </div>
            `,
          )
          .join('')}
      </div>
    </div>
  `

  refs.companionNotes.innerHTML = [
    featureCard(
      'Acquisition and identity',
      buddy.hatched
        ? `${buddy.name} is bound to ${buddy.identityLabel}. Changing the companion assignment means changing the Jarvis user identity, not editing the companion manually.`
        : `This companion is already keyed to ${buddy.identityLabel}. Hatch only creates the soul; the identity-bound bones are already determined.`,
      ['identity-bound', '/buddy supported', 'dock hatch CTA'],
      12,
    ),
    featureCard(
      'What re-hatching changes',
      'Re-hatching only refreshes the companion soul: name, personality, and hatch timestamp. Species, rarity, appearance, and stats stay tied to the current Jarvis user identity.',
      ['name', 'personality', 'hatchedAt'],
      12,
    ),
    `
      <div class="feature-card companion-facts">
        <strong>Stat glossary</strong>
        <div class="stat-glossary">
          ${Object.entries(buddy.statDescriptions ?? {})
            .map(
              ([name, description]) => `
                <div class="stat-glossary-item">
                  <strong>${escapeHtml(name)}</strong>
                  <div class="muted">${escapeHtml(description)}</div>
                </div>
              `,
            )
            .join('')}
        </div>
        <div class="hint">These stats shape companion flavor and reactions in this pass. They do not grant hidden tool access, permission overrides, or model boosts.</div>
      </div>
    `,
    featureCard(
      'Claude foundation',
      'Jarvis now mirrors Claude-style companion semantics: identity-bound bones, persisted soul, one-time intro behavior, docked bubble presence, and pet-driven reactions that stay distinct from the model itself.',
      coordinator?.strictDelegationRules ?? ['Companion reactions are UI-local and never impersonate the model.'],
      12,
    ),
  ].join('')
}

function renderIntegrationList() {
  const integrations = getFilteredIntegrations()
  setIntegrationFilterButtonState()

  if (integrations.length === 0) {
    refs.integrationList.innerHTML = `
      <div class="feature-card">
        <strong>No saved integrations</strong>
        <div class="muted">Add your first endpoint so Jarvis can build out an integration browser without crowding the chat surface.</div>
      </div>
    `
    return
  }

  refs.integrationList.innerHTML = integrations
    .map(entry => {
      const active = entry.id === state.shell.uiState.selectedIntegrationId
      return `
        <div class="integration-card ${active ? 'active' : ''}" data-integration-id="${escapeHtml(
          entry.id,
        )}">
          <div class="card-title">${escapeHtml(entry.name)}</div>
          <div class="muted">${escapeHtml(entry.baseUrl)}</div>
          <div class="card-meta">
            <span class="tag">${escapeHtml(entry.category)}</span>
            <span class="tag">${escapeHtml(entry.status)}</span>
            <span class="tag">${escapeHtml(entry.authMode)}</span>
          </div>
          <div class="muted">${escapeHtml(entry.notes || 'No notes yet.')}</div>
          ${
            entry.tags.length > 0
              ? `<div class="tag-list">${entry.tags
                  .map(tag => `<span class="tag">${escapeHtml(tag)}</span>`)
                  .join('')}</div>`
              : ''
          }
        </div>
      `
    })
    .join('')
}

function hydrateIntegrationEditor() {
  const selected = getSelectedIntegration()
  if (!selected || state.integrationDrafting) {
    refs.integrationEditorState.textContent = 'New integration'
    refs.integrationId.value = ''
    refs.integrationName.value = ''
    refs.integrationCategory.value = ''
    refs.integrationBaseUrl.value = ''
    refs.integrationAuthMode.value = 'none'
    refs.integrationStatus.value = 'draft'
    refs.integrationTags.value = ''
    refs.integrationNotes.value = ''
    refs.deleteIntegration.classList.add('hidden')
    return
  }

  refs.integrationEditorState.textContent = `Editing ${selected.name}`
  refs.integrationId.value = selected.id
  refs.integrationName.value = selected.name
  refs.integrationCategory.value = selected.category
  refs.integrationBaseUrl.value = selected.baseUrl
  refs.integrationAuthMode.value = selected.authMode
  refs.integrationStatus.value = selected.status
  refs.integrationTags.value = selected.tags.join(', ')
  refs.integrationNotes.value = selected.notes
  refs.deleteIntegration.classList.remove('hidden')
}

function openNewIntegration() {
  state.integrationDrafting = true
  state.shell.uiState.selectedIntegrationId = null
  persistShellUiState()
  renderIntegrationList()
  hydrateIntegrationEditor()
}

function selectIntegration(id) {
  if (!id) {
    return
  }
  state.integrationDrafting = false
  state.shell.uiState.selectedIntegrationId = id
  persistShellUiState()
  renderIntegrationList()
  hydrateIntegrationEditor()
}

async function saveIntegrationFromEditor() {
  const name = refs.integrationName.value.trim()
  const baseUrl = refs.integrationBaseUrl.value.trim()
  if (!name || !baseUrl) {
    throw new Error('Integration name and base URL are required.')
  }

  const tags = refs.integrationTags.value
    .split(',')
    .map(tag => tag.trim())
    .filter(Boolean)

  const nextEntry = {
    id: refs.integrationId.value || crypto.randomUUID(),
    name,
    category: refs.integrationCategory.value.trim() || 'General',
    baseUrl,
    authMode: refs.integrationAuthMode.value || 'none',
    status: refs.integrationStatus.value || 'draft',
    notes: refs.integrationNotes.value.trim(),
    tags,
    updatedAt: new Date().toISOString(),
  }

  const withoutExisting = state.shell.integrations.filter(
    entry => entry.id !== nextEntry.id,
  )
  state.shell.integrations = [...withoutExisting, nextEntry].sort((left, right) =>
    left.name.localeCompare(right.name),
  )
  state.shell.uiState.selectedIntegrationId = nextEntry.id
  state.integrationDrafting = false
  await persistShell()
  renderIntegrationList()
  hydrateIntegrationEditor()
  setNotice(`Saved integration: ${nextEntry.name}`, 'idle')
  renderChrome()
}

async function deleteSelectedIntegration() {
  const selected = getSelectedIntegration()
  if (!selected) {
    return
  }

  state.shell.integrations = state.shell.integrations.filter(
    entry => entry.id !== selected.id,
  )
  state.shell.uiState.selectedIntegrationId = null
  state.integrationDrafting = false
  await persistShell()
  renderIntegrationList()
  hydrateIntegrationEditor()
  setNotice(`Removed integration: ${selected.name}`, 'warning')
  renderChrome()
}

function setIntegrationFilter(filter) {
  state.integrationFilter = filter
  renderIntegrationList()
}

function setIntegrationFilterButtonState() {
  setClass(refs.integrationFilterAll, 'active', state.integrationFilter === 'all')
  setClass(refs.integrationFilterReady, 'active', state.integrationFilter === 'ready')
  setClass(refs.integrationFilterDraft, 'active', state.integrationFilter === 'draft')
  setClass(refs.integrationFilterPaused, 'active', state.integrationFilter === 'paused')
}

function getFilteredIntegrations() {
  const search = refs.integrationSearch.value.trim().toLowerCase()
  return state.shell.integrations.filter(entry => {
    if (state.integrationFilter !== 'all' && entry.status !== state.integrationFilter) {
      return false
    }
    if (!search) {
      return true
    }
    return [
      entry.name,
      entry.category,
      entry.baseUrl,
      entry.notes,
      ...entry.tags,
    ]
      .join(' ')
      .toLowerCase()
      .includes(search)
  })
}

function setActiveView(view) {
  state.shell.uiState.activeView = view
  persistShellUiState()
  renderAll()
}

function toggleAdvancedSettings(forceValue) {
  const nextValue =
    typeof forceValue === 'boolean'
      ? forceValue
      : !state.shell.uiState.advancedSettingsOpen
  state.shell.uiState.advancedSettingsOpen = nextValue
  persistShellUiState()
  renderBackendControls()
}

function setBackend(backend) {
  refs.backend.value = backend
  renderBackendControls()
  renderChrome()
  if (backend === 'remote-glm' && shouldCheckRemoteHealth()) {
    void refreshRemoteHealth().catch(handleActionError)
  }
}

function setRemoteLane(model) {
  refs.remoteGlmModel.value = model
  renderBackendControls()
  renderChrome()
}

function renderBackendControls() {
  const config = getCurrentConfig()
  const backend = config.backend

  refs.backend.value = backend
  setClass(refs.backendRemote, 'active', backend === 'remote-glm')
  setClass(refs.backendLocal, 'active', backend === 'ollama')
  setClass(refs.backendAnthropic, 'active', backend === 'anthropic')

  setClass(refs.remoteFields, 'hidden', backend !== 'remote-glm')
  setClass(refs.ollamaFields, 'hidden', backend !== 'ollama')
  setClass(refs.anthropicFields, 'hidden', backend !== 'anthropic')

  setClass(
    refs.remoteLaneAuto,
    'active',
    normalizeLaneValue(config.remoteGlmModel) === 'gpt-oss-auto',
  )
  setClass(
    refs.remoteLane120,
    'active',
    normalizeLaneValue(config.remoteGlmModel) === 'gpt-oss-120b',
  )
  setClass(
    refs.remoteLane20,
    'active',
    normalizeLaneValue(config.remoteGlmModel) === 'gpt-oss-20b',
  )

  const advancedOpen = state.shell.uiState.advancedSettingsOpen
  setClass(refs.advancedSettings, 'hidden', !advancedOpen)
  refs.toggleAdvanced.textContent = advancedOpen
    ? 'Hide advanced'
    : 'Advanced settings'
  refs.toggleAdvancedInline.textContent = advancedOpen ? 'Hide advanced' : 'Advanced'

  refs.launchSession.textContent =
    backend === 'remote-glm'
      ? 'Launch GPT-OSS session'
      : backend === 'ollama'
        ? 'Launch local runtime'
        : 'Launch Anthropic session'
}

function populateModelOptions() {
  const catalog = state.modelCatalog
  const current = state.config?.ollamaModel || ''
  const options = Array.isArray(catalog?.models) ? [...catalog.models] : []

  if (current && !options.some(option => option.id === current)) {
    options.push({
      id: current,
      label: current,
      installed: false,
      description: 'Custom configured local model.',
      role: 'alternate',
      recommendedMode: 'safe',
      toolReadiness: 'candidate-for-tools',
    })
  }

  refs.ollamaModelPreset.innerHTML = options
    .map(option => {
      const suffix = option.installed ? '' : ' (not installed)'
      return `<option value="${escapeHtml(option.id)}">${escapeHtml(
        option.label + suffix,
      )}</option>`
    })
    .join('')

  if (current) {
    refs.ollamaModelPreset.value = current
  }
}

function applyConfigToForm(config) {
  refs.backend.value = config.backend
  refs.remoteGlmBaseUrl.value = config.remoteGlmBaseUrl || ''
  refs.remoteGlmApiKey.value = config.remoteGlmApiKey || ''
  refs.remoteGlmModel.value = config.remoteGlmModel || 'gpt-oss-auto'
  refs.ollamaBaseUrl.value = config.ollamaBaseUrl || ''
  refs.ollamaModel.value = config.ollamaModel || ''
  refs.anthropicModel.value = config.anthropicModel || ''
  refs.anthropicApiKey.value = config.anthropicApiKey || ''
  refs.anthropicBaseUrl.value = config.anthropicBaseUrl || ''
  refs.workspacePath.value = config.workspacePath || ''
  refs.appendSystemPrompt.value = config.appendSystemPrompt || ''
  refs.coordinatorMode.checked = Boolean(config.coordinatorMode)
  refs.disableToolsForLocal.checked = Boolean(config.disableToolsForLocal)
  refs.enableExperimentalLocalTools.checked = Boolean(
    config.enableExperimentalLocalTools,
  )
  refs.disableNonessentialTraffic.checked = Boolean(
    config.disableNonessentialTraffic,
  )
  refs.disableThinkingForLocal.checked = Boolean(config.disableThinkingForLocal)
}

function promoteRemotePrimary() {
  refs.backend.value = 'remote-glm'
  if (!refs.remoteGlmModel.value) {
    refs.remoteGlmModel.value = 'gpt-oss-auto'
  }
}

function getCurrentConfig() {
  return {
    ...(state.config ?? {}),
    workspacePath: refs.workspacePath?.value ?? state.runtime.workspacePath ?? '',
    backend: refs.backend?.value || state.config?.backend || 'remote-glm',
    anthropicApiKey: refs.anthropicApiKey?.value ?? '',
    anthropicBaseUrl: refs.anthropicBaseUrl?.value ?? '',
    anthropicModel: refs.anthropicModel?.value ?? '',
    ollamaBaseUrl: refs.ollamaBaseUrl?.value ?? '',
    ollamaModel:
      refs.ollamaModel?.value || refs.ollamaModelPreset?.value || 'qwen2.5-coder:7b',
    remoteGlmBaseUrl: refs.remoteGlmBaseUrl?.value ?? '',
    remoteGlmApiKey: refs.remoteGlmApiKey?.value ?? '',
    remoteGlmModel: normalizeLaneValue(
      refs.remoteGlmModel?.value || state.config?.remoteGlmModel || 'gpt-oss-auto',
    ),
    coordinatorMode: refs.coordinatorMode?.checked ?? false,
    disableToolsForLocal: refs.disableToolsForLocal?.checked ?? true,
    enableExperimentalLocalTools:
      refs.enableExperimentalLocalTools?.checked ?? false,
    disableNonessentialTraffic:
      refs.disableNonessentialTraffic?.checked ?? true,
    disableThinkingForLocal:
      refs.disableThinkingForLocal?.checked ?? true,
    appendSystemPrompt: refs.appendSystemPrompt?.value ?? '',
  }
}

async function saveConfigFromForm() {
  const config = getCurrentConfig()
  const saved = await postJson('/api/config', config)
  state.config = saved
  applyConfigToForm(saved)
  populateModelOptions()
  setNotice('Jarvis settings saved.', 'idle')
  renderAll()
  if (saved.backend === 'remote-glm' && shouldCheckRemoteHealth()) {
    await refreshRemoteHealth(saved)
  }
  renderChrome()
}

async function launchSessionFromForm() {
  const config = getCurrentConfig()
  const saved = await postJson('/api/config', config)
  state.config = saved
  applyConfigToForm(saved)

  if (saved.backend === 'remote-glm') {
    const health = await refreshRemoteHealth(saved)
    if (!health.ok) {
      throw new Error(health.message)
    }
  }

  await postJson('/api/session/start', { config: saved })
  attachTranscriptToLatest()
  setNotice(
    saved.backend === 'remote-glm'
      ? 'Launching remote GPT-OSS session.'
      : saved.backend === 'ollama'
        ? 'Launching local runtime session.'
        : 'Launching Anthropic session.',
    'running',
  )
  renderChrome()
}

async function refreshRemoteHealth(configOverride) {
  const payload = await postJson('/api/remote-health', {
    config: configOverride || getCurrentConfig(),
  })
  state.remoteHealth = payload
  renderRemoteHealth()
  renderChrome()
  return payload
}

async function sendPromptFromComposer() {
  const content = refs.promptInput.value.trim()
  if (!content) {
    return
  }
  attachTranscriptToLatest()
  const response = await postJson('/api/session/send', { content })
  if (response?.features) {
    state.features = response.features
  }
  if (response?.intercepted === 'buddy') {
    triggerCompanionPetBurst()
    setActiveView('companion')
  }
  refs.promptInput.value = ''
  renderAll()
}

async function refreshFeatures() {
  state.features = await fetchJson('/api/features')
  renderAll()
}

async function runCompanionAction(action) {
  if (action === 'open-profile') {
    setActiveView('companion')
    return
  }
  const payload = await postJson(`/api/companion/${action}`, {})
  state.features = payload?.features || payload
  if (action === 'pet' || action === 'hatch' || action === 'rehatch') {
    triggerCompanionPetBurst()
  }
  if (action === 'hatch' || action === 'rehatch') {
    setActiveView('companion')
  }
  renderAll()
}

async function persistShell() {
  const payload = await postJson('/api/shell', {
    uiState: state.shell.uiState,
    integrations: state.shell.integrations,
  })
  state.shell = payload
}

function persistShellUiState() {
  void postJson('/api/shell', {
    uiState: state.shell.uiState,
  }).catch(handleActionError)
}

function getSelectedIntegration() {
  return (
    state.shell.integrations.find(
      entry => entry.id === state.shell.uiState.selectedIntegrationId,
    ) ?? null
  )
}

function onTranscriptScroll() {
  if (state.transcriptProgrammaticScroll) {
    state.transcriptLastScrollTop = refs.transcriptScroll.scrollTop
    return
  }

  const currentTop = refs.transcriptScroll.scrollTop
  const nearBottom = isNearBottom(refs.transcriptScroll)
  const movedUp = currentTop < state.transcriptLastScrollTop - 4

  if (nearBottom) {
    state.transcriptAttached = true
    state.transcriptHasUnseenBelow = false
    state.companionDockVisible = true
  } else if (movedUp) {
    state.transcriptAttached = false
    state.transcriptHasUnseenBelow = true
    state.companionDockVisible = false
  }

  state.transcriptLastScrollTop = currentTop
  syncJumpLatest()
  renderCompanionRail()
}

function syncJumpLatest() {
  const shouldShow = !state.transcriptAttached && state.transcriptHasUnseenBelow
  setClass(refs.jumpLatestWrap, 'hidden', !shouldShow)
}

function attachTranscriptToLatest() {
  state.transcriptAttached = true
  state.transcriptHasUnseenBelow = false
  state.companionDockVisible = true
  scrollTranscriptToBottom()
  syncJumpLatest()
  renderCompanionRail()
}

function scrollTranscriptToBottom() {
  state.transcriptProgrammaticScroll = true
  refs.transcriptScroll.scrollTop = refs.transcriptScroll.scrollHeight
  state.transcriptLastScrollTop = refs.transcriptScroll.scrollTop
  window.setTimeout(() => {
    state.transcriptProgrammaticScroll = false
  }, 0)
}

function isNearBottom(element) {
  return (
    element.scrollHeight - element.scrollTop - element.clientHeight <
    NEAR_BOTTOM_THRESHOLD
  )
}

function triggerCompanionPetBurst() {
  state.companionPetBurstUntil = Date.now() + PET_BURST_MS
  renderCompanionRail()
  window.setTimeout(() => {
    if (Date.now() >= state.companionPetBurstUntil) {
      renderCompanionRail()
    }
  }, PET_BURST_MS + 40)
}

function buildRuntimeSummary(config) {
  const activeView = state.shell.uiState.activeView
  if (activeView === 'chat') {
    if (state.runtime.running) {
      return state.runtime.busy
        ? `${state.runtime.label}. Jarvis is working through the current turn.`
        : `${state.runtime.label}. Chat stays anchored to the latest output while the safety rail carries permissions.`
    }
    if (config.backend === 'remote-glm' && state.remoteHealth) {
      return state.remoteHealth.message
    }
  }

  if (activeView === 'autodream') {
    const dream = state.features?.autoDream
    if (dream) {
      return dream.ready
        ? 'AutoDream is close to or fully ready for the next consolidation pass.'
        : 'AutoDream is still waiting on time or session gates.'
    }
  }

  if (activeView === 'memory') {
    const memory = state.features?.memory
    if (memory) {
      return `MEMORY.md currently tracks ${memory.lineCount} lines of index material.`
    }
  }

  if (activeView === 'integrations') {
    return `${state.shell.integrations.length} saved integration${
      state.shell.integrations.length === 1 ? '' : 's'
    } in the registry.`
  }

  if (activeView === 'companion') {
    return state.features?.buddy
      ? state.features.buddy.hatched
        ? `${state.features.buddy.name} is docked to the prompt rail and bound to ${state.features.buddy.identityLabel}.`
        : `A dormant companion is ready to hatch for ${state.features.buddy.identityLabel}.`
      : VIEW_META.companion.summary
  }

  return VIEW_META[activeView]?.summary ?? VIEW_META.chat.summary
}

function buildHeroMode(config) {
  const backendLabel = BACKEND_LABELS[config.backend] ?? 'Unknown backend'
  const model =
    config.backend === 'remote-glm'
      ? laneLabel(config.remoteGlmModel)
      : config.backend === 'ollama'
        ? config.ollamaModel || 'No local model'
        : config.anthropicModel || 'No model'
  return `${backendLabel} / ${model}`
}

function buildHeaderPills(config) {
  return [
    {
      label: BACKEND_LABELS[config.backend] ?? 'Backend',
      tone: config.backend === 'remote-glm' ? 'running' : 'idle',
    },
    {
      label: state.remoteHealth?.ok ? 'Bridge ready' : 'Bridge status pending',
      tone: state.remoteHealth?.ok ? 'running' : 'warning',
    },
    {
      label: state.features?.coordinator?.active
        ? 'Coordinator on'
        : 'Coordinator off',
      tone: state.features?.coordinator?.active ? 'running' : 'idle',
    },
  ]
}

function buildRuntimePills(config) {
  const isSessionActive = state.runtime.running || state.runtime.busy
  const pills = [
    {
      label: isSessionActive
        ? RUNTIME_MODE_LABELS[state.runtime.mode] ?? 'Idle'
        : 'Idle',
      tone: isSessionActive ? state.runtime.tone : 'idle',
    },
  ]

  if (config.backend === 'remote-glm') {
    pills.push({
      label: `Lane ${laneLabel(config.remoteGlmModel)}`,
      tone: state.remoteHealth?.ok ? 'running' : 'warning',
    })
  }

  if (isSessionActive && state.runtime.model) {
    pills.push({
      label: state.runtime.model,
      tone: 'idle',
    })
  }

  if (isSessionActive && state.runtime.sessionId) {
    pills.push({
      label: `Session ${state.runtime.sessionId.slice(0, 8)}`,
      tone: 'idle',
    })
  }

  return pills
}

function renderPillRow(pills) {
  return pills
    .filter(Boolean)
    .map(
      pill => `
        <span class="pill ${toneClass(pill.tone)}">${escapeHtml(pill.label)}</span>
      `,
    )
    .join('')
}

function metricCard(label, value, detail, span = 3) {
  return `
    <div class="metric-card" style="grid-column: span ${span}">
      <strong>${escapeHtml(label)}</strong>
      <div class="metric-value">${escapeHtml(value)}</div>
      <span>${escapeHtml(detail)}</span>
    </div>
  `
}

function featureCard(label, body, tags, span = 6) {
  return `
    <div class="feature-card" style="grid-column: span ${span}">
      <strong>${escapeHtml(label)}</strong>
      <div style="line-height:1.6;color:#e6eefb">${escapeHtml(body)}</div>
      ${
        Array.isArray(tags) && tags.length > 0
          ? `<div class="tag-list">${tags
              .map(tag => `<span class="tag">${escapeHtml(tag)}</span>`)
              .join('')}</div>`
          : ''
      }
    </div>
  `
}

function extractTextContent(content) {
  if (typeof content === 'string') {
    return content
  }
  if (!Array.isArray(content)) {
    return ''
  }
  return content
    .map(block => {
      if (!block || typeof block !== 'object') {
        return ''
      }
      if (block.type === 'text' && typeof block.text === 'string') {
        return block.text
      }
      if (
        block.type === 'connector_text' &&
        typeof block.connector_text === 'string'
      ) {
        return block.connector_text
      }
      if (block.type === 'thinking' && typeof block.thinking === 'string') {
        return ''
      }
      if (block.type === 'tool_result') {
        return ''
      }
      return typeof block.content === 'string' ? block.content : ''
    })
    .filter(Boolean)
    .join('\n\n')
    .trim()
}

function extractBlocksByType(content, type) {
  if (!Array.isArray(content)) {
    return []
  }
  return content.filter(block => block && typeof block === 'object' && block.type === type)
}

function extractToolResults(content) {
  if (!Array.isArray(content)) {
    return []
  }
  return content
    .filter(block => block?.type === 'tool_result')
    .map(block => ({
      title: `Tool result${block.tool_use_id ? ` ${block.tool_use_id}` : ''}`,
      body: stringifyForDetail(block.content ?? block),
    }))
}

function summarizeUnknownMessage(message) {
  if (typeof message.message === 'string') {
    return message.message
  }
  if (typeof message.content === 'string') {
    return message.content
  }
  if (typeof message.subtype === 'string') {
    return `Event subtype: ${message.subtype}`
  }
  return 'A runtime event was received.'
}

function laneLabel(value) {
  return LANE_LABELS[normalizeLaneValue(value)] || value || 'Auto'
}

function normalizeLaneValue(value) {
  if (!value) {
    return 'gpt-oss-auto'
  }
  const trimmed = String(value).trim()
  if (trimmed === '120b' || trimmed === 'gpt-oss-120b') {
    return 'gpt-oss-120b'
  }
  if (trimmed === '20b' || trimmed === 'gpt-oss-20b') {
    return 'gpt-oss-20b'
  }
  if (trimmed === 'openai/gpt-oss-120b') {
    return 'gpt-oss-120b'
  }
  if (trimmed === 'openai/gpt-oss-20b') {
    return 'gpt-oss-20b'
  }
  return 'gpt-oss-auto'
}

function shouldCheckRemoteHealth() {
  const config = getCurrentConfig()
  return Boolean(config.remoteGlmBaseUrl?.trim())
}

function toneClass(tone) {
  if (tone === 'running') {
    return 'tone-running'
  }
  if (tone === 'warning') {
    return 'tone-warning'
  }
  if (tone === 'error') {
    return 'tone-error'
  }
  return ''
}

function setClass(element, className, enabled) {
  if (!element) {
    return
  }
  element.classList.toggle(className, Boolean(enabled))
}

function fileName(path) {
  if (!path) {
    return ''
  }
  return String(path).split(/[\\/]/).pop() || path
}

function titleCase(value) {
  if (!value) {
    return ''
  }
  return value.charAt(0).toUpperCase() + value.slice(1)
}

function formatDateTime(value) {
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(value))
  } catch {
    return String(value)
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function stringifyForDetail(value) {
  if (typeof value === 'string') {
    return value
  }
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers ?? {}),
    },
    ...options,
  })

  if (!response.ok) {
    const message = await response.text()
    throw new Error(message || `Request failed: ${response.status}`)
  }
  return response.json()
}

function postJson(url, payload) {
  return fetchJson(url, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

function handleActionError(error) {
  console.error(error)
  setNotice(error instanceof Error ? error.message : String(error), 'error')
  renderChrome()
}

function setNotice(message, tone = 'idle') {
  state.notice = { message, tone }
  if (state.noticeTimer) {
    window.clearTimeout(state.noticeTimer)
  }
  state.noticeTimer = window.setTimeout(() => {
    state.notice = null
    state.noticeTimer = null
    renderChrome()
  }, 4500)
}
