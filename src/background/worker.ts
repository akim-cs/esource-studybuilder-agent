// Background service worker — orchestrates the full build run.
// Receives commands from side panel, drives content script for perception + interaction,
// calls Gemini for all LLM decisions, and writes state back to chrome.storage.local.

import type { ExtMessage, RunState } from '../shared/types'

// ── Storage helpers ────────────────────────────────────────────────────────────

async function getState(): Promise<RunState | null> {
  const { runState } = await chrome.storage.local.get('runState')
  return runState ?? null
}

async function setState(runState: RunState): Promise<void> {
  await chrome.storage.local.set({ runState })
  broadcastState(runState)
}

function broadcastState(runState: RunState): void {
  chrome.runtime.sendMessage({ type: 'STATE_UPDATE', runState } satisfies ExtMessage).catch(() => {
    // Side panel may not be open — ignore
  })
}

// ── Message routing ────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message: ExtMessage, _sender, sendResponse) => {
  handleMessage(message).then(sendResponse).catch((err) => {
    console.error('[worker] Unhandled error:', err)
    sendResponse(null)
  })
  return true // keep channel open for async response
})

async function handleMessage(message: ExtMessage): Promise<unknown> {
  switch (message.type) {
    case 'START_RUN':
      // TODO: validate IR, compile build plan, start execution loop
      console.log('[worker] START_RUN received', message.studyIR.study.title)
      return null

    case 'PAUSE_RUN':
      // TODO: set state.status = 'paused'
      console.log('[worker] PAUSE_RUN received')
      return null

    case 'RESUME_RUN':
      // TODO: resume execution from current step
      console.log('[worker] RESUME_RUN received')
      return null

    case 'ABORT_RUN':
      // TODO: clear run state
      console.log('[worker] ABORT_RUN received')
      return null

    case 'RESOLVE_ESCALATION':
      // TODO: apply resolution, resume
      console.log('[worker] RESOLVE_ESCALATION received', message.escalationId)
      return null

    default:
      return null
  }
}

// ── Lifecycle ──────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  console.log('[StudyBuilder] Extension installed / updated')
})
