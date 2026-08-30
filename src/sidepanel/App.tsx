import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { EscalationItem, EscalationResolution, ExtMessage, RunState, StudyIR } from '../shared/types'

const IDLE_STATE: RunState = {
  status: 'idle',
  plan: [],
  currentStepIndex: 0,
  escalationQueue: [],
  traceLog: [],
}

export default function App() {
  const [runState, setRunState] = useState<RunState>(IDLE_STATE)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Sync state from storage on mount
  useEffect(() => {
    chrome.storage.local.get('runState', ({ runState: saved }) => {
      if (saved) setRunState(saved as RunState)
    })
  }, [])

  // Listen for state updates from background worker
  useEffect(() => {
    const handler = (message: ExtMessage) => {
      if (message.type === 'STATE_UPDATE') setRunState(message.runState)
    }
    chrome.runtime.onMessage.addListener(handler)
    return () => chrome.runtime.onMessage.removeListener(handler)
  }, [])

  const handleFileLoad = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = async (ev) => {
      try {
        const studyIR = JSON.parse(ev.target?.result as string) as StudyIR
        // Find the active tab in the current window to use as the target eSource tab
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true })
        if (!activeTab?.id) { alert('No active tab found — open the eSource platform first.'); return }
        chrome.runtime.sendMessage({ type: 'START_RUN', studyIR, tabId: activeTab.id } satisfies ExtMessage)
      } catch {
        alert('Invalid JSON file')
      }
    }
    reader.readAsText(file)
  }, [])

  const resolveEscalation = useCallback((id: string, resolution: EscalationResolution) => {
    chrome.runtime.sendMessage({ type: 'RESOLVE_ESCALATION', escalationId: id, resolution } satisfies ExtMessage)
  }, [])

  const { status, plan, currentStepIndex, escalationQueue } = runState
  const done = plan.filter((s) => s.status === 'done').length
  const failed = plan.filter((s) => s.status === 'failed').length
  const escalated = plan.filter((s) => s.status === 'escalated').length
  const activeEscalation = escalationQueue.find((e) => !e.resolution)

  return (
    <div style={{ padding: 12 }}>
      <h3 style={{ margin: '0 0 10px', fontSize: 15 }}>StudyBuilder Agent</h3>

      {/* Status badge */}
      <p style={{ margin: '0 0 10px' }}>
        Status: <strong>{status}</strong>
        {plan.length > 0 && (
          <span style={{ marginLeft: 8, color: '#666' }}>
            {done}/{plan.length} done · {escalated} escalated · {failed} failed
          </span>
        )}
      </p>

      {/* File picker + run controls */}
      {status === 'idle' && (
        <>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json"
            style={{ display: 'none' }}
            onChange={handleFileLoad}
          />
          <button onClick={() => fileInputRef.current?.click()}>Load JSON &amp; Run</button>
        </>
      )}

      {status === 'running' && (
        <button onClick={() => chrome.runtime.sendMessage({ type: 'PAUSE_RUN' })}>Pause</button>
      )}

      {status === 'paused' && (
        <button onClick={() => chrome.runtime.sendMessage({ type: 'RESUME_RUN' })}>Resume</button>
      )}

      {/* Escalation card */}
      {activeEscalation && <EscalationCard item={activeEscalation} onResolve={resolveEscalation} />}

      {/* Error */}
      {status === 'error' && runState.errorMessage && (
        <p style={{ color: 'red', marginTop: 10 }}>{runState.errorMessage}</p>
      )}
    </div>
  )
}

function EscalationCard({
  item,
  onResolve,
}: {
  item: EscalationItem
  onResolve: (id: string, resolution: EscalationResolution) => void
}) {
  const [overrideValue, setOverrideValue] = useState('')

  return (
    <div
      style={{
        marginTop: 12,
        padding: 10,
        border: '2px solid #f59e0b',
        borderRadius: 6,
        background: '#fffbeb',
      }}
    >
      <strong>⚠ Review Required</strong>
      <p style={{ margin: '6px 0 2px', fontSize: 12 }}>
        <em>{item.inputRef}</em>
      </p>
      <p style={{ margin: '0 0 6px', fontSize: 12 }}>{item.issue}</p>
      {item.bestGuess && (
        <p style={{ margin: '0 0 8px', fontSize: 12, color: '#555' }}>
          Best guess: <strong>{item.bestGuess}</strong>{' '}
          {item.confidence !== undefined && `(${Math.round(item.confidence * 100)}%)`}
        </p>
      )}
      {item.screenshot && (
        <img
          src={item.screenshot}
          alt="Screenshot"
          style={{ width: '100%', border: '1px solid #ddd', marginBottom: 8 }}
        />
      )}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <button onClick={() => onResolve(item.id, { choice: 'approve' })}>Approve guess</button>
        <input
          type="text"
          placeholder="Override value…"
          value={overrideValue}
          onChange={(e) => setOverrideValue(e.target.value)}
          style={{ flex: 1, padding: '2px 6px' }}
        />
        <button
          onClick={() => overrideValue && onResolve(item.id, { choice: 'override', value: overrideValue })}
          disabled={!overrideValue}
        >
          Override
        </button>
        <button onClick={() => onResolve(item.id, { choice: 'skip' })}>Skip</button>
      </div>
    </div>
  )
}
