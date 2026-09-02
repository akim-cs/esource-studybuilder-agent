import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { EscalationItem, EscalationResolution, ExtMessage, RunState, StudyIR } from '../shared/types'

const IDLE_STATE: RunState = {
  status: 'idle', plan: [], currentStepIndex: 0, escalationQueue: [], traceLog: [],
}

const s = {
  wrap: { padding: 12, fontFamily: 'system-ui', fontSize: 13 } as React.CSSProperties,
  h: { margin: '0 0 10px', fontSize: 15 } as React.CSSProperties,
  row: { display: 'flex', gap: 6, flexWrap: 'wrap' as const, marginBottom: 8 },
  btn: { padding: '4px 10px', cursor: 'pointer', fontSize: 12 } as React.CSSProperties,
  badge: (color: string) => ({ marginLeft: 6, padding: '1px 6px', borderRadius: 10, background: color, color: '#fff', fontSize: 11 } as React.CSSProperties),
  card: { marginTop: 10, padding: 10, border: '2px solid #f59e0b', borderRadius: 6, background: '#fffbeb' } as React.CSSProperties,
  err: { color: 'red', marginTop: 8, fontSize: 12 } as React.CSSProperties,
  meta: { color: '#666', fontSize: 11 } as React.CSSProperties,
}

export default function App() {
  const [run, setRun] = useState<RunState>(IDLE_STATE)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    chrome.storage.local.get('runState', ({ runState }) => { if (runState) setRun(runState as RunState) })
  }, [])

  useEffect(() => {
    const handler = (msg: ExtMessage) => { if (msg.type === 'STATE_UPDATE') setRun(msg.runState) }
    chrome.runtime.onMessage.addListener(handler)
    return () => chrome.runtime.onMessage.removeListener(handler)
  }, [])

  const startRun = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return
    const reader = new FileReader()
    reader.onload = async (ev) => {
      try {
        const studyIR = JSON.parse(ev.target?.result as string) as StudyIR
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
        if (!tab?.id) { alert('Open the eSource platform in the active tab first.'); return }
        chrome.runtime.sendMessage({ type: 'START_RUN', studyIR, tabId: tab.id } satisfies ExtMessage)
      } catch { alert('Invalid JSON — check the file and try again.') }
    }
    reader.readAsText(file)
  }, [])

  const resolve = useCallback((id: string, resolution: EscalationResolution) => {
    chrome.runtime.sendMessage({ type: 'RESOLVE_ESCALATION', escalationId: id, resolution } satisfies ExtMessage)
  }, [])

  const exportLog = useCallback(() => {
    const blob = new Blob([JSON.stringify(run.traceLog, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = 'trace-log.json'; a.click()
    URL.revokeObjectURL(url)
  }, [run.traceLog])

  const { status, plan, currentStepIndex, escalationQueue, traceLog, errorMessage } = run
  const done = plan.filter((s) => s.status === 'done').length
  const escalated = plan.filter((s) => s.status === 'escalated').length
  const failed = plan.filter((s) => s.status === 'failed').length
  const pending = escalationQueue.filter((e) => !e.resolution)

  return (
    <div style={s.wrap}>
      <h3 style={s.h}>StudyBuilder Agent</h3>

      {/* Status line */}
      <p style={{ margin: '0 0 8px' }}>
        <strong>{status}</strong>
        {plan.length > 0 && (
          <span style={s.meta}>
            {' '}· {done}/{plan.length} done
            {escalated > 0 && <span style={s.badge('#f59e0b')}>{escalated} escalated</span>}
            {failed > 0 && <span style={s.badge('#ef4444')}>{failed} failed</span>}
            {pending.length > 0 && <span style={s.badge('#6366f1')}>{pending.length} pending review</span>}
          </span>
        )}
      </p>

      {/* Controls */}
      <div style={s.row}>
        {status === 'idle' && (
          <>
            <input ref={fileRef} type="file" accept=".json" style={{ display: 'none' }} onChange={startRun} />
            <button style={s.btn} onClick={() => fileRef.current?.click()}>Load JSON &amp; Run</button>
          </>
        )}
        {status === 'running' && (
          <button style={s.btn} onClick={() => chrome.runtime.sendMessage({ type: 'PAUSE_RUN' })}>Pause</button>
        )}
        {status === 'paused' && (
          <button style={s.btn} onClick={() => chrome.runtime.sendMessage({ type: 'RESUME_RUN' })}>Resume</button>
        )}
        {(status === 'running' || status === 'paused' || status === 'error') && (
          <button style={{ ...s.btn, color: '#ef4444' }} onClick={() => chrome.runtime.sendMessage({ type: 'ABORT_RUN' })}>Abort</button>
        )}
        {traceLog.length > 0 && (
          <button style={s.btn} onClick={exportLog}>Export Log</button>
        )}
      </div>

      {/* Active escalation (show one at a time) */}
      {pending[0] && <EscalationCard item={pending[0]} onResolve={resolve} />}

      {/* Progress (compact step list) */}
      {plan.length > 0 && status !== 'idle' && (
        <StepList plan={run.plan} currentIndex={currentStepIndex} />
      )}

      {status === 'complete' && <p style={{ color: 'green', marginTop: 8 }}>✓ Run complete</p>}
      {status === 'error' && errorMessage && <p style={s.err}>{errorMessage}</p>}
    </div>
  )
}

// ── Escalation card ────────────────────────────────────────────────────────────

function EscalationCard({ item, onResolve }: { item: EscalationItem; onResolve: (id: string, r: EscalationResolution) => void }) {
  const [override, setOverride] = useState('')
  return (
    <div style={s.card}>
      <strong>⚠ Review required</strong>
      <p style={{ margin: '4px 0 2px', fontSize: 11, color: '#555' }}>{item.inputRef}</p>
      <p style={{ margin: '0 0 6px', fontSize: 12 }}>{item.issue}</p>
      {item.bestGuess && (
        <p style={{ margin: '0 0 8px', ...s.meta }}>
          Best guess: <strong>{item.bestGuess}</strong>
          {item.confidence !== undefined && ` (${Math.round(item.confidence * 100)}%)`}
        </p>
      )}
      {item.screenshot && (
        <img src={item.screenshot} alt="screenshot" style={{ width: '100%', border: '1px solid #ddd', marginBottom: 8, borderRadius: 3 }} />
      )}
      <div style={s.row}>
        <button style={s.btn} onClick={() => onResolve(item.id, { choice: 'approve' })}>Approve</button>
        <input type="text" placeholder="Override value…" value={override} onChange={(e) => setOverride(e.target.value)} style={{ flex: 1, padding: '3px 6px', fontSize: 12 }} />
        <button style={s.btn} disabled={!override} onClick={() => override && onResolve(item.id, { choice: 'override', value: override })}>Override</button>
        <button style={{ ...s.btn, color: '#666' }} onClick={() => onResolve(item.id, { choice: 'skip' })}>Skip</button>
      </div>
    </div>
  )
}

// ── Compact step list ──────────────────────────────────────────────────────────

function StepList({ plan, currentIndex }: { plan: RunState['plan']; currentIndex: number }) {
  const visible = plan.slice(Math.max(0, currentIndex - 3), currentIndex + 8)

  function retryStep(stepId: string) {
    chrome.runtime.sendMessage({ type: 'RETRY_STEP', stepId } satisfies ExtMessage)
  }

  return (
    <div style={{ marginTop: 10, fontSize: 11, color: '#444' }}>
      {visible.map((step, i) => {
        const icon = step.status === 'done' ? '✓' : step.status === 'in_progress' ? '▶' : step.status === 'escalated' ? '⚠' : step.status === 'failed' ? '✗' : step.status === 'skipped' ? '–' : '·'
        const color = step.status === 'done' ? '#16a34a' : step.status === 'escalated' ? '#d97706' : step.status === 'failed' ? '#dc2626' : step.status === 'in_progress' ? '#2563eb' : '#999'
        const payload = step.payload as { name?: string; label?: string }
        const name = payload.label ?? payload.name ?? step.type
        return (
          <div key={step.stepId + i} style={{ display: 'flex', gap: 5, padding: '1px 0', alignItems: 'center' }}>
            <span style={{ color, width: 12, flexShrink: 0 }}>{icon}</span>
            <span style={{ color: '#888', width: 36, flexShrink: 0 }}>{step.type}</span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{name}</span>
            {step.status === 'failed' && (
              <button
                onClick={() => retryStep(step.stepId)}
                style={{ fontSize: 10, padding: '0 4px', cursor: 'pointer', flexShrink: 0 }}
              >
                Retry
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}
