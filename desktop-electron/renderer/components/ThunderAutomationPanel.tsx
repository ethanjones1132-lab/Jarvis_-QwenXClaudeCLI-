/**
 * Thunder Compute — Automation Panel
 *
 * Displays Phase 2 step progress with live log streaming.
 * Replaces the terminal window once session detection completes.
 */

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import type {
  ThunderStepId,
  ThunderStepUpdatePayload,
  ThunderLogStreamPayload,
} from '../../thunder/thunderTypes.js'

type StepDisplay = {
  id: ThunderStepId
  label: string
  state: 'pending' | 'active' | 'done' | 'error' | 'skipped'
  startedAt: number | null
  error: string | null
}

type AutomationInvokeResult = {
  ok: boolean
  publicUrl?: string
  instanceId?: string
  error?: string
}

export function buildThunderInvokeFallbackErrorStep(
  steps: StepDisplay[],
  error: string | null | undefined,
  now = Date.now(),
): StepDisplay | null {
  if (!error) {
    return null
  }

  if (steps.some(step => step.state === 'error')) {
    return null
  }

  const anchor =
    [...steps].reverse().find(step => step.state === 'active')
    ?? [...steps].reverse().find(step => step.state === 'done')
    ?? steps[steps.length - 1]

  if (!anchor) {
    return null
  }

  return {
    ...anchor,
    state: 'error',
    error,
    startedAt: anchor.startedAt ?? now,
  }
}

type ThunderAutomationPanelProps = {
  /** Pre-known instance ID (V1 / resume flow). Omit or pass '' for V2 new-session flow. */
  instanceId?: string
  bridgeApiKey: string
  onComplete: (publicUrl: string, instanceId: string) => void
  onAbort: () => void
  /**
   * 'v2' (default) — snapshot-driven: create instance + poll /healthz.
   * 'v1' — legacy SSH-orchestrated path for resume flow.
   * 'attach' — reconnect to an already-running instance (3 steps: forward-port → poll-healthz → attach).
   */
  mode?: 'v1' | 'v2' | 'attach'
}

export function ThunderAutomationPanel({
  instanceId: instanceIdProp = '',
  bridgeApiKey,
  onComplete,
  onAbort,
  mode = 'v2',
}: ThunderAutomationPanelProps): React.ReactElement {
  // In V2 mode, instanceId is not known until create-instance completes;
  // we resolve it from the automation result and display it in the badge.
  const [resolvedInstanceId, setResolvedInstanceId] = useState(instanceIdProp)
  const instanceId = resolvedInstanceId || instanceIdProp
  const [steps, setSteps] = useState<StepDisplay[]>([])
  const stepsRef = useRef<StepDisplay[]>([])
  const [stepsReady, setStepsReady] = useState(false)
  const [logs, setLogs] = useState<string[]>([])
  const [activeStepLabel, setActiveStepLabel] = useState('')
  const [elapsedMs, setElapsedMs] = useState(0)
  const [errorStep, setErrorStep] = useState<StepDisplay | null>(null)
  const [completed, setCompleted] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const logEndRef = useRef<HTMLDivElement>(null)
  const autoScrollRef = useRef(true)
  const logContainerRef = useRef<HTMLDivElement>(null)
  const [logScrolledUp, setLogScrolledUp] = useState(false)
  // Guard: prevents concurrent or duplicate automation invocations when
  // the `mode` prop changes while the panel is already mounted (which would
  // reset stepsReady false→true and re-fire the automation effect).
  const automationStartedRef = useRef(false)

  useEffect(() => {
    stepsRef.current = steps
  }, [steps])

  // Initialize steps from main process
  useEffect(() => {
    let cancelled = false
    setStepsReady(false)
    automationStartedRef.current = false  // reset on mode change so new mode can start
    const fetchSteps = mode === 'v2'
      ? window.jarvis.thunderGetStepsV2()
      : mode === 'attach'
      ? window.jarvis.thunderGetStepsV2Attach()
      : window.jarvis.thunderGetSteps()
    void fetchSteps.then(stepDefs => {
      if (cancelled) {
        return
      }
      const nextSteps = stepDefs.map(s => ({
          id: s.id,
          label: s.label,
          state: 'pending' as const,
          startedAt: null,
          error: null,
        }))
      stepsRef.current = nextSteps
      setSteps(nextSteps)
      setStepsReady(true)
    })
    return () => {
      cancelled = true
      automationStartedRef.current = false  // reset on cleanup so remount can start fresh
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode])

  // Subscribe to step updates
  useEffect(() => {
    const unsub = window.jarvis.onThunderStepUpdate(
      (payload: ThunderStepUpdatePayload) => {
        setSteps(prev =>
          prev.map(s => {
            if (s.id !== payload.stepId) {
              return s
            }
            const updated: StepDisplay = {
              ...s,
              state: payload.state,
              error: payload.error,
              startedAt:
                payload.state === 'active' ? Date.now() : s.startedAt,
            }
            if (payload.state === 'active') {
              setActiveStepLabel(s.label)
              setErrorStep(null)
            }
            if (payload.state === 'error') {
              setErrorStep(updated)
            }
            if (payload.state === 'skipped' && s.id === 'system-prep') {
              setErrorStep(null)
            }
            return updated
          }),
        )
      },
    )
    return unsub
  }, [])

  // Subscribe to log stream
  useEffect(() => {
    const unsub = window.jarvis.onThunderLogStream(
      (payload: ThunderLogStreamPayload) => {
        const lines = payload.text
          .split('\n')
          .filter(l => l.trim().length > 0)
        if (lines.length > 0) {
          setLogs(prev => {
            const next = [...prev, ...lines]
            return next.length > 500 ? next.slice(next.length - 500) : next
          })
        }
      },
    )
    return unsub
  }, [])

  // Elapsed time ticker for active step
  useEffect(() => {
    const timer = setInterval(() => {
      const active = steps.find(s => s.state === 'active')
      if (active?.startedAt) {
        setElapsedMs(Date.now() - active.startedAt)
      }
    }, 1000)
    return () => clearInterval(timer)
  }, [steps])

  // Auto-scroll logs
  useLayoutEffect(() => {
    const el = logContainerRef.current
    if (autoScrollRef.current && el) {
      el.scrollTop = el.scrollHeight
    }
  }, [logs])

  // Handle log scroll to disable auto-scroll when user scrolls up
  function handleLogScroll(): void {
    const el = logContainerRef.current
    if (!el) {
      return
    }
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    autoScrollRef.current = atBottom
    setLogScrolledUp(!atBottom)
  }

  function scrollLogToBottom(): void {
    const el = logContainerRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    autoScrollRef.current = true
    setLogScrolledUp(false)
  }

  // Start automation once steps are ready — guarded against concurrent/duplicate
  // invocations that can occur when `mode` changes while the panel is mounted.
  useEffect(() => {
    if (!stepsReady) {
      return
    }
    if (automationStartedRef.current) {
      return
    }
    automationStartedRef.current = true
    void runAutomation()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepsReady])

  async function runAutomation(): Promise<void> {
    setRetrying(false)
    setErrorStep(null)
    let result: AutomationInvokeResult
    if (mode === 'v2') {
      result = await window.jarvis.thunderStartSession(bridgeApiKey)
    } else if (mode === 'attach') {
      result = await window.jarvis.thunderAttachInstance(instanceIdProp, bridgeApiKey)
    } else {
      result = await window.jarvis.thunderBeginAutomation(instanceIdProp, bridgeApiKey)
    }
    if (result.ok && result.publicUrl && result.instanceId) {
      setResolvedInstanceId(result.instanceId)
      setCompleted(true)
      onComplete(result.publicUrl, result.instanceId)
      return
    }

    const fallbackError = buildThunderInvokeFallbackErrorStep(
      stepsRef.current,
      result.error ?? 'Thunder automation failed before the panel received a step error update.',
    )
    if (fallbackError) {
      setSteps(prev => prev.map(step => (
        step.id === fallbackError.id
          ? fallbackError
          : step
      )))
      setActiveStepLabel('')
      setElapsedMs(0)
      setErrorStep(fallbackError)
    }
  }

  function handleRetry(): void {
    setRetrying(true)
    // Reset all steps back to pending
    setSteps(prev =>
      prev.map(s => ({
        ...s,
        state: 'pending' as const,
        error: null,
        startedAt: null,
      })),
    )
    setActiveStepLabel('')
    setElapsedMs(0)
    setLogs([])
    if (mode === 'v2') {
      // V2 creates a fresh instance on retry — clear the resolved ID
      setResolvedInstanceId('')
    }
    void runAutomation()
  }

  function handleAbort(): void {
    if (
      !window.confirm(
        'This will not terminate the Thunder instance. You will continue to be billed. Terminate manually at thundercompute.com.',
      )
    ) {
      return
    }
    void window.jarvis.thunderAbortAutomation()
    onAbort()
  }

  function formatElapsed(ms: number): string {
    const secs = Math.floor(ms / 1000)
    const mins = Math.floor(secs / 60)
    const s = secs % 60
    return mins > 0 ? `${mins}m ${s}s` : `${s}s`
  }

  // Determine loading status for special display
  // V2: show model-load status during poll-healthz; V1: poll-vllm
  const vllmStep = steps.find(s => s.id === (mode !== 'v1' ? 'poll-healthz' : 'poll-vllm'))
  const isVllmLoading = vllmStep?.state === 'active'
  const isProcessLive =
    !completed &&
    !errorStep &&
    (Boolean(activeStepLabel) ||
      logs.length > 0 ||
      steps.some(step => step.state === 'active'))
  const lastLogLine = logs.length > 0 ? logs[logs.length - 1] : ''

  return (
    <div style={panelStyle}>
      <div style={headerStyle}>
        <div style={titleRowStyle}>
          <span style={titleStyle}>Thunder Compute</span>
          {instanceId ? (
            <span style={instanceBadgeStyle}>{instanceId}</span>
          ) : (
            <span style={{ ...instanceBadgeStyle, opacity: 0.5 }}>creating…</span>
          )}
        </div>
        {activeStepLabel && !completed && !errorStep && (
          <div style={activeStepRowStyle}>
            <span style={pulseStyle} />
            <span style={activeStepLabelStyle}>{activeStepLabel}</span>
            <span style={elapsedStyle}>{formatElapsed(elapsedMs)}</span>
          </div>
        )}
        {isVllmLoading && lastLogLine && (
          <div style={vllmStatusStyle}>
            Model loading &mdash; {lastLogLine.slice(0, 120)}
          </div>
        )}
        <AnimatePresence initial={false}>
          {isProcessLive && (
            <motion.div
              key="live-connection"
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.2, ease: 'easeOut' }}
              style={liveStatusStyle}
            >
              <motion.span
                aria-hidden="true"
                animate={{ scale: [1, 1.14, 1], opacity: [0.58, 1, 0.58] }}
                transition={{ duration: 1.45, repeat: Infinity, ease: 'easeInOut' }}
                style={liveStatusDotStyle}
              />
              <div style={liveStatusCopyStyle}>
                <span style={liveStatusLabelStyle}>Connection stable</span>
                <span style={liveStatusSubtextStyle}>
                  {isVllmLoading
                    ? (mode === 'v1'
                        ? 'vLLM is loading inside the snapshot and the tunnel is staying warm.'
                        : 'Model is loading on the GPU — waiting for /healthz to report ready.')
                    : 'Keeping the remote session warm while the bridge finishes wiring up.'}
                </span>
              </div>
              <div aria-hidden="true" style={liveStatusBarsStyle}>
                {[0, 1, 2].map(i => (
                  <motion.span
                    key={i}
                    animate={{ scaleY: [0.72, 1.38, 0.72], opacity: [0.45, 1, 0.45] }}
                    transition={{
                      duration: 1.15,
                      repeat: Infinity,
                      delay: i * 0.14,
                      ease: 'easeInOut',
                    }}
                    style={liveStatusBarStyle}
                  />
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
        {completed && (
          <div style={successBannerStyle}>
            Session active. Jarvis is connected.
          </div>
        )}
      </div>

      {/* Step progress */}
      <div style={stepsContainerStyle}>
        {steps.map(step => (
          <div key={step.id} style={stepRowStyle}>
            <span style={stepIconStyle(step.state)}>
              {step.state === 'done'
                ? '\u2713'
                : step.state === 'error'
                  ? '\u2717'
                  : step.state === 'skipped'
                    ? '\u21b7'
                  : step.state === 'active'
                    ? '\u25CF'
                    : '\u25CB'}
            </span>
            <span
              style={{
                ...stepLabelStyle,
                color:
                  step.state === 'active'
                    ? 'var(--accent-strong)'
                    : step.state === 'done'
                      ? 'var(--success)'
                      : step.state === 'error'
                        ? 'var(--danger)'
                        : 'var(--muted)',
              }}
              >
              {step.label}
            </span>
            {step.state === 'skipped' && step.error && (
              <span style={skippedReasonStyle}>{step.error}</span>
            )}
          </div>
        ))}
      </div>

      {/* Error panel */}
      {errorStep && (
        <div style={errorPanelStyle}>
          <div style={errorTitleStyle}>
            {errorStep.label} failed
          </div>
          <div style={errorMessageStyle}>{errorStep.error}</div>
          <div style={errorActionsStyle}>
            <button
              style={retryButtonStyle}
              onClick={handleRetry}
              disabled={retrying}
            >
              {retrying ? 'Retrying...' : 'Retry Step'}
            </button>
            <button style={abortButtonStyle} onClick={handleAbort}>
              Abort Session
            </button>
          </div>
        </div>
      )}

      {/* Log pane */}
      <div style={logPaneWrapperStyle}>
        <div
          ref={logContainerRef}
          style={logPaneStyle}
          onScroll={handleLogScroll}
        >
          {/* Inner flex column with justify-content: flex-end so lines
              grow upward from the bottom, matching the main chat window */}
          <div style={logInnerStyle}>
            {logs.map((line, i) => (
              <div key={i} style={logLineStyle}>
                {line}
              </div>
            ))}
            <div ref={logEndRef} />
          </div>
        </div>
        {logScrolledUp && (
          <button
            style={logScrollBtnStyle}
            onClick={scrollLogToBottom}
          >
            ↓ Back to bottom
          </button>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Inline styles using Jarvis design tokens
// ---------------------------------------------------------------------------

const panelStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  flex: 1,
  minHeight: 0,
  height: 'auto',
  background: 'var(--bg-2)',
  borderRadius: 'var(--radius-lg)',
  border: '1px solid var(--line)',
  overflow: 'hidden',
}

const headerStyle: React.CSSProperties = {
  padding: '20px 24px 16px',
  borderBottom: '1px solid var(--line)',
}

const titleRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
}

const titleStyle: React.CSSProperties = {
  fontSize: 18,
  fontWeight: 600,
  color: 'var(--text)',
}

const instanceBadgeStyle: React.CSSProperties = {
  fontSize: 12,
  fontFamily: "'Cascadia Code', 'Consolas', monospace",
  padding: '3px 10px',
  borderRadius: 'var(--radius-sm)',
  background: 'var(--accent-soft)',
  color: 'var(--accent-strong)',
}

const activeStepRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  marginTop: 10,
}

const pulseStyle: React.CSSProperties = {
  width: 8,
  height: 8,
  borderRadius: '50%',
  background: 'var(--accent)',
  animation: 'pulse 1.5s ease-in-out infinite',
}

const activeStepLabelStyle: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 500,
  color: 'var(--accent-strong)',
}

const elapsedStyle: React.CSSProperties = {
  fontSize: 12,
  color: 'var(--muted)',
  marginLeft: 'auto',
}

const vllmStatusStyle: React.CSSProperties = {
  marginTop: 8,
  fontSize: 12,
  color: 'var(--warning)',
  fontFamily: "'Cascadia Code', 'Consolas', monospace",
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
}

const liveStatusStyle: React.CSSProperties = {
  marginTop: 10,
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  padding: '10px 12px',
  borderRadius: 'var(--radius-sm)',
  border: '1px solid rgba(0, 229, 255, 0.18)',
  background:
    'linear-gradient(180deg, rgba(0, 229, 255, 0.08), rgba(0, 229, 255, 0.03))',
}

const liveStatusDotStyle: React.CSSProperties = {
  width: 10,
  height: 10,
  borderRadius: 999,
  background: 'var(--accent)',
  boxShadow: '0 0 0 6px rgba(0, 229, 255, 0.12)',
  flex: '0 0 auto',
}

const liveStatusCopyStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 3,
  minWidth: 0,
  flex: 1,
}

const liveStatusLabelStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'var(--accent-strong)',
}

const liveStatusSubtextStyle: React.CSSProperties = {
  fontSize: 12,
  color: 'var(--muted)',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
}

const liveStatusBarsStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-end',
  gap: 3,
  height: 16,
  flex: '0 0 auto',
}

const liveStatusBarStyle: React.CSSProperties = {
  width: 3,
  height: 16,
  borderRadius: 999,
  background: 'rgba(0, 229, 255, 0.8)',
  transformOrigin: 'center bottom',
}

const successBannerStyle: React.CSSProperties = {
  marginTop: 10,
  fontSize: 14,
  fontWeight: 600,
  color: 'var(--success)',
}

const stepsContainerStyle: React.CSSProperties = {
  padding: '12px 24px',
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  borderBottom: '1px solid var(--line)',
  maxHeight: 260,
  overflowY: 'auto',
  minHeight: 0,
}

const stepRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  fontSize: 13,
}

function stepIconStyle(
  state: 'pending' | 'active' | 'done' | 'error' | 'skipped',
): React.CSSProperties {
  return {
    width: 18,
    textAlign: 'center',
    fontSize: 14,
    fontWeight: 700,
    color:
      state === 'done'
        ? 'var(--success)'
        : state === 'error'
          ? 'var(--danger)'
          : state === 'skipped'
            ? 'var(--muted)'
          : state === 'active'
            ? 'var(--accent)'
            : 'var(--muted)',
  }
}

const stepLabelStyle: React.CSSProperties = {
  fontSize: 13,
}

const skippedReasonStyle: React.CSSProperties = {
  marginLeft: 6,
  fontSize: 11,
  color: 'var(--muted)',
  fontStyle: 'italic',
}

const errorPanelStyle: React.CSSProperties = {
  margin: '12px 24px',
  padding: '14px 18px',
  background: 'rgba(255, 106, 134, 0.08)',
  borderRadius: 'var(--radius-sm)',
  border: '1px solid rgba(255, 106, 134, 0.24)',
}

const errorTitleStyle: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  color: 'var(--danger)',
  marginBottom: 8,
}

const errorMessageStyle: React.CSSProperties = {
  fontSize: 12,
  color: 'var(--muted-strong)',
  fontFamily: "'Cascadia Code', 'Consolas', monospace",
  whiteSpace: 'pre-wrap',
  maxHeight: 100,
  overflow: 'auto',
  marginBottom: 12,
}

const errorActionsStyle: React.CSSProperties = {
  display: 'flex',
  gap: 10,
}

const retryButtonStyle: React.CSSProperties = {
  padding: '8px 18px',
  fontSize: 13,
  fontWeight: 600,
  borderRadius: 'var(--radius-sm)',
  background: 'var(--accent)',
  color: '#fff',
  border: 'none',
  cursor: 'pointer',
}

const abortButtonStyle: React.CSSProperties = {
  padding: '8px 18px',
  fontSize: 13,
  fontWeight: 600,
  borderRadius: 'var(--radius-sm)',
  background: 'rgba(255, 106, 134, 0.16)',
  color: 'var(--danger)',
  border: '1px solid rgba(255, 106, 134, 0.24)',
  cursor: 'pointer',
}

// Outer wrapper — relative so the scroll-to-bottom button can be positioned
const logPaneWrapperStyle: React.CSSProperties = {
  position: 'relative',
  flex: 1,
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
  background: 'var(--bg)',
}

// Scrollable viewport
const logPaneStyle: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: 'auto',
  overflowX: 'hidden',
  scrollbarWidth: 'thin',
  scrollbarColor: 'rgba(161,161,170,0.2) transparent',
  scrollbarGutter: 'stable',
  overflowAnchor: 'none',
  overscrollBehavior: 'contain',
  padding: '12px 24px',
  fontFamily: "'Cascadia Code', 'Consolas', monospace",
  fontSize: 11,
  lineHeight: 1.6,
  color: 'var(--muted)',
}

// Inner column — justify-content: flex-end anchors new lines to the bottom
// so old lines scroll out of view upward (mirrors main chat window behavior)
const logInnerStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  justifyContent: 'flex-end',
  minHeight: '100%',
  gap: 0,
  overflowAnchor: 'none',
}

const logLineStyle: React.CSSProperties = {
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-all',
}

// "Back to bottom" pill — appears when user scrolls up in the log pane
const logScrollBtnStyle: React.CSSProperties = {
  position: 'absolute',
  bottom: 14,
  left: '50%',
  transform: 'translateX(-50%)',
  padding: '7px 16px',
  borderRadius: 999,
  border: '1px solid rgba(0, 229, 255, 0.28)',
  background: 'rgba(21, 21, 21, 0.92)',
  backdropFilter: 'blur(14px)',
  color: 'var(--accent-strong)',
  fontSize: 11,
  fontWeight: 500,
  cursor: 'pointer',
  boxShadow: '0 4px 18px rgba(0,0,0,0.5)',
  pointerEvents: 'auto',
  whiteSpace: 'nowrap',
  zIndex: 10,
}
