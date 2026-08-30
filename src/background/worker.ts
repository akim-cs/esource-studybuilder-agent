// Background service worker — orchestrates the full build run.
// Receives commands from side panel, drives content script for perception + interaction,
// calls Gemini for all LLM decisions, and writes state back to chrome.storage.local.

import type { ExtMessage, RunState, PageState, UIControl, InteractAction, EscalationItem, VocabularyMap } from '../shared/types'
import { validateIR, createRunState, IRValidationError } from '../shared/planner'
import { initGemini, perceivePage, discoverVocabulary, decideAction } from '../shared/gemini'
import { loadCachedVocabulary, cacheVocabulary, buildVocabularyResult } from '../shared/vocabulary'

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

// ── Interaction helper ─────────────────────────────────────────────────────────

async function sendInteract(tabId: number, action: InteractAction): Promise<boolean> {
  const response = await chrome.tabs.sendMessage(tabId, { type: 'INTERACT', action } satisfies ExtMessage)
  const result = response as { success: boolean; error?: string }
  if (!result.success) {
    console.warn('[worker] Interact failed:', result.error, action)
  }
  return result.success
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

// ── Vocabulary discovery flow ──────────────────────────────────────────────────
// Navigates to the type picker on the current form page, screenshots it,
// and builds the canonical → platform label mapping.
// The caller must ensure we are already on a form's field list page.

export async function runVocabularyDiscovery(
  tabId: number,
  hostname: string,
): Promise<{ map: VocabularyMap; escalations: EscalationItem[] }> {
  // Return cached map if already discovered for this platform
  const cached = await loadCachedVocabulary(hostname)
  if (cached) {
    console.log('[worker] Vocabulary: using cached map for', hostname)
    return { map: cached, escalations: [] }
  }

  console.log('[worker] Vocabulary: starting discovery for', hostname)

  // Step 1: perceive current screen — we should be on a form's field list
  let { screenshot, pageState } = await captureAndPerceive(tabId)

  // Step 2: find and click "add field" to open the field creation UI
  if (!pageState.screen.includes('field')) {
    const decision = await decideAction(
      screenshot,
      pageState,
      'Find and click the button or link that adds a new field to the current form',
    )
    if (decision.confidence >= 0.6) {
      await sendInteract(tabId, {
        kind: 'click',
        targetLabel: decision.targetLabel,
        targetRole: decision.targetRole,
        fallbackPosition: decision.fallbackPosition,
      })
      await wait(1200)
      ;({ screenshot, pageState } = await captureAndPerceive(tabId))
    }
  }

  // Step 3: find and click the type picker if it isn't already open
  if (!pageState.screen.includes('type')) {
    const decision = await decideAction(
      screenshot,
      pageState,
      'Find and click the field type selector, type picker, or element type dropdown',
    )
    if (decision.confidence >= 0.6) {
      await sendInteract(tabId, {
        kind: 'click',
        targetLabel: decision.targetLabel,
        targetRole: decision.targetRole,
        fallbackPosition: decision.fallbackPosition,
      })
      await wait(1200)
      ;({ screenshot, pageState } = await captureAndPerceive(tabId))
    }
  }

  // Step 4: discover vocabulary from the current screenshot (type picker visible)
  const a11yTree = pageState.controls
  const entries = await discoverVocabulary(screenshot, a11yTree)
  console.log('[worker] Vocabulary: discovered', entries.length, 'entries')

  const { map, escalations, missing } = buildVocabularyResult(entries, screenshot)

  if (missing.length > 0) {
    console.warn('[worker] Vocabulary: no mapping found for canonical types:', missing.join(', '))
  }

  // Cache for future runs on this platform
  await cacheVocabulary(hostname, map)

  return { map, escalations }
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
      const tab = await chrome.tabs.get(message.tabId)
      const hostname = tab.url ? new URL(tab.url).hostname : 'unknown'

      const runState = createRunState(ir)
      runState.targetTabId = message.tabId
      runState.targetHostname = hostname
      await setState(runState)

      const cycleCount = runState.plan.filter((s) => s.status === 'escalated').length
      console.log(
        `[worker] Plan compiled: ${runState.plan.length} steps for "${ir.study.title}"`,
        cycleCount > 0 ? `(${cycleCount} cycle escalations)` : ''
      )

      // TODO: kick off execution loop (Phase 5)
      // Vocabulary discovery will be triggered in the execution loop before the first field step.
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
