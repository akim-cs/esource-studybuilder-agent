// Background service worker — orchestrates the full build run.
// Receives commands from side panel, drives content script for perception + interaction,
// calls Gemini for all LLM decisions, and writes state back to chrome.storage.local.

import type { ExtMessage, RunState, PageState, UIControl } from '../shared/types'
import { validateIR, createRunState, IRValidationError } from '../shared/planner'
import { initGemini, perceivePage } from '../shared/gemini'

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

async function getApiKey(): Promise<string | null> {
  const { geminiApiKey } = await chrome.storage.local.get('geminiApiKey')
  return geminiApiKey ?? null
}

// ── Perception helpers ─────────────────────────────────────────────────────────

async function captureScreenshot(tabId: number): Promise<string> {
  const tab = await chrome.tabs.get(tabId)
  // captureVisibleTab needs the window ID, not tab ID
  return chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' })
}

async function getA11yTree(tabId: number): Promise<UIControl[]> {
  const response = await chrome.tabs.sendMessage(tabId, { type: 'GET_PAGE_STATE' } satisfies ExtMessage)
  const msg = response as { type: string; state: PageState }
  return msg?.state?.controls ?? []
}

export async function captureAndPerceive(tabId: number): Promise<{ screenshot: string; pageState: PageState }> {
  const [screenshot, a11yTree] = await Promise.all([
    captureScreenshot(tabId),
    getA11yTree(tabId),
  ])
  const pageState = await perceivePage(screenshot, a11yTree)
  return { screenshot, pageState }
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
    case 'START_RUN': {
      const apiKey = await getApiKey()
      if (!apiKey) {
        const errState: RunState = {
          status: 'error',
          plan: [],
          currentStepIndex: 0,
          escalationQueue: [],
          traceLog: [],
          errorMessage: 'Gemini API key not set. Open extension options to configure it.',
        }
        await setState(errState)
        return null
      }

      let ir
      try {
        ir = validateIR(message.studyIR)
      } catch (err) {
        const errState: RunState = {
          status: 'error',
          plan: [],
          currentStepIndex: 0,
          escalationQueue: [],
          traceLog: [],
          errorMessage: err instanceof IRValidationError
            ? err.message
            : `IR parse error: ${String(err)}`,
        }
        await setState(errState)
        return null
      }

      initGemini(apiKey)
      const runState = createRunState(ir)
      runState.targetTabId = message.tabId
      await setState(runState)

      console.log(
        `[worker] Plan compiled: ${runState.plan.length} steps for "${ir.study.title}"`,
        runState.plan.filter((s) => s.status === 'escalated').length,
        'cycle-detected escalations'
      )

      // TODO: kick off execution loop (Phase 5)
      return null
    }

    case 'PAUSE_RUN': {
      const state = await getState()
      if (state && state.status === 'running') {
        await setState({ ...state, status: 'paused' })
      }
      return null
    }

    case 'RESUME_RUN': {
      const state = await getState()
      if (state && state.status === 'paused') {
        await setState({ ...state, status: 'running' })
        // TODO: resume execution loop (Phase 5)
      }
      return null
    }

    case 'ABORT_RUN': {
      const blank: RunState = {
        status: 'idle',
        plan: [],
        currentStepIndex: 0,
        escalationQueue: [],
        traceLog: [],
      }
      await setState(blank)
      return null
    }

    case 'RESOLVE_ESCALATION': {
      const state = await getState()
      if (!state) return null
      const item = state.escalationQueue.find((e) => e.id === message.escalationId)
      if (item) {
        item.resolution = message.resolution
        await setState({ ...state })
      }
      // TODO: check if this unblocks the run (Phase 6)
      return null
    }

    default:
      return null
  }
}

// ── Lifecycle ──────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  console.log('[StudyBuilder] Extension installed / updated')
})
