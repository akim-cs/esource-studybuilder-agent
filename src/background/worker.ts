// Background service worker — orchestrates the full build run.
// Routes messages from the side panel, manages RunState in storage,
// and drives the execution loop (vocabulary discovery + step execution).

import type { ExtMessage, RunState, EscalationItem, VocabularyMap } from '../shared/types'
import { validateIR, createRunState, IRValidationError } from '../shared/planner'
import { initGemini } from '../shared/gemini'
import { loadCachedVocabulary, cacheVocabulary, buildVocabularyResult } from '../shared/vocabulary'
import { discoverVocabulary, decideAction } from '../shared/gemini'
import { captureAndPerceive, sendInteract, wait } from './helpers'
import { executeStep } from './executor'

// ── Storage ────────────────────────────────────────────────────────────────────

async function getState(): Promise<RunState | null> {
  const { runState } = await chrome.storage.local.get('runState')
  return (runState as RunState) ?? null
}

async function setState(runState: RunState): Promise<void> {
  await chrome.storage.local.set({ runState })
  chrome.runtime.sendMessage({ type: 'STATE_UPDATE', runState } satisfies ExtMessage).catch(() => {
    // Side panel may not be open — ignore
  })
}

async function getApiKey(): Promise<string | null> {
  const { geminiApiKey } = await chrome.storage.local.get('geminiApiKey')
  return (geminiApiKey as string) ?? null
}

// ── Vocabulary discovery ───────────────────────────────────────────────────────

async function runVocabularyDiscovery(
  tabId: number,
  hostname: string,
): Promise<{ map: VocabularyMap; escalations: EscalationItem[] }> {
  const cached = await loadCachedVocabulary(hostname)
  if (cached) {
    console.log('[worker] Vocab: using cached map for', hostname)
    return { map: cached, escalations: [] }
  }

  console.log('[worker] Vocab: discovering for', hostname)

  let { screenshot, pageState } = await captureAndPerceive(tabId)

  // Navigate to add-field UI if not already there
  if (!pageState.screen.includes('field')) {
    const d = await decideAction(screenshot, pageState, 'Click the button or link to add a new field to the current form')
    if (d.confidence >= 0.6) {
      await sendInteract(tabId, { kind: 'click', targetLabel: d.targetLabel, targetRole: d.targetRole, fallbackPosition: d.fallbackPosition })
      await wait(1200)
      ;({ screenshot, pageState } = await captureAndPerceive(tabId))
    }
  }

  // Open the type picker if not already visible
  if (!pageState.screen.includes('type')) {
    const d = await decideAction(screenshot, pageState, 'Find and click the field type selector, type picker, or element type dropdown')
    if (d.confidence >= 0.6) {
      await sendInteract(tabId, { kind: 'click', targetLabel: d.targetLabel, targetRole: d.targetRole, fallbackPosition: d.fallbackPosition })
      await wait(1200)
      ;({ screenshot, pageState } = await captureAndPerceive(tabId))
    }
  }

  const entries = await discoverVocabulary(screenshot, pageState.controls)
  console.log('[worker] Vocab: got', entries.length, 'entries from Gemini')

  const { map, escalations, missing } = buildVocabularyResult(entries, screenshot)
  if (missing.length) console.warn('[worker] Vocab: no mapping for', missing.join(', '))

  await cacheVocabulary(hostname, map)
  return { map, escalations }
}

// ── Execution loop ─────────────────────────────────────────────────────────────
// Called after START_RUN and again after RESUME_RUN.
// Checkpoints state to storage after every step so the run survives
// Chrome killing the service worker (MV3 ~5 min idle limit).

async function runLoop(state: RunState): Promise<void> {
  const tabId = state.targetTabId
  const hostname = state.targetHostname
  if (!tabId || !hostname) return

  while (state.currentStepIndex < state.plan.length && state.status === 'running') {
    const step = state.plan[state.currentStepIndex]

    // For escalated cycle steps (from planner topo-sort), surface a card if one isn't queued yet
    if (step.status === 'escalated' && !state.escalationQueue.some((e) => e.stepId === step.stepId)) {
      const fieldLabel = (step.payload as { label?: string }).label ?? step.inputRef
      state.escalationQueue.push({
        id: `cycle_${step.stepId}`,
        stepId: step.stepId,
        inputRef: step.inputRef,
        issue: `Skip-logic cycle detected for field "${fieldLabel}" — its dependencies form a cycle and cannot be automatically ordered. Skip this field or resolve the cycle in the input JSON.`,
        screenshot: '',
        bestGuess: 'Skip this field and set its skip logic manually after the run completes',
        confidence: 1.0,
      })
      state.status = 'paused'
      await setState(state)
      return
    }

    // Skip steps already resolved (done, skipped, or previously handled escalations)
    if (step.status !== 'pending') {
      state.currentStepIndex++
      continue
    }

    // Vocabulary discovery — triggered once before the first field step
    if (step.type === 'field' && !state.vocabularyMap) {
      let vocabResult: { map: VocabularyMap; escalations: EscalationItem[] } | null = null
      for (let attempt = 0; attempt < 2 && !vocabResult; attempt++) {
        try {
          if (attempt > 0) await wait(1500)
          vocabResult = await runVocabularyDiscovery(tabId, hostname)
        } catch (err) {
          console.error('[worker] Vocab discovery attempt', attempt + 1, 'failed:', err)
        }
      }

      if (!vocabResult) {
        state.vocabularyMap = {} as VocabularyMap  // prevent re-entry on next resume
        state.escalationQueue.push({
          id: 'vocab_discovery_failed',
          stepId: step.stepId,
          inputRef: step.inputRef,
          issue: 'Vocabulary discovery failed after 2 attempts — the agent cannot map field types for this platform. Check that the eSource tab is open and the extension has access to it.',
          screenshot: '',
          bestGuess: 'Ensure the eSource tab is accessible, then retry the run',
          confidence: 1.0,
        })
        state.status = 'paused'
        await setState(state)
        return
      }

      state.vocabularyMap = vocabResult.map
      state.escalationQueue.push(...vocabResult.escalations)

      if (vocabResult.escalations.length > 0) {
        // Pause for human to review low-confidence type mappings before touching any field
        state.status = 'paused'
        await setState(state)
        return
      }
    }

    step.status = 'in_progress'
    await setState(state)

    try {
      const result = await executeStep(tabId, step, state.vocabularyMap ?? {} as VocabularyMap)

      step.status =
        result.outcome === 'success' ? 'done'
        : result.outcome === 'skipped' ? 'skipped'
        : result.outcome === 'escalated' ? 'escalated'
        : 'failed'

      if (result.escalation) {
        state.escalationQueue.push(result.escalation)
        state.status = 'paused'
      }

      state.traceLog.push({
        stepId: step.stepId,
        inputRef: step.inputRef,
        action: result.action,
        reasoning: result.reasoning,
        outcome: result.outcome === 'skipped' ? 'skipped' : result.outcome,
        timestamp: new Date().toISOString(),
      })
    } catch (err) {
      step.status = 'failed'
      state.traceLog.push({
        stepId: step.stepId,
        inputRef: step.inputRef,
        action: 'executeStep',
        reasoning: String(err),
        outcome: 'failed',
        timestamp: new Date().toISOString(),
      })
    }

    state.currentStepIndex++
    await setState(state)   // checkpoint — survives SW restart

    if (state.status === 'paused') return  // wait for human escalation resolution
  }

  if (state.currentStepIndex >= state.plan.length) {
    state.status = 'complete'
    await setState(state)
    console.log('[worker] Run complete')
  }
}

// ── Message routing ────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message: ExtMessage, _sender, sendResponse) => {
  handleMessage(message).then(sendResponse).catch((err) => {
    console.error('[worker] Unhandled error:', err)
    sendResponse(null)
  })
  return true
})

async function handleMessage(message: ExtMessage): Promise<unknown> {
  switch (message.type) {
    case 'START_RUN': {
      const apiKey = await getApiKey()
      if (!apiKey) {
        await setState({ status: 'error', plan: [], currentStepIndex: 0, escalationQueue: [], traceLog: [], errorMessage: 'Gemini API key not configured — open Options to set it.' })
        return null
      }

      let ir
      try {
        ir = validateIR(message.studyIR)
      } catch (err) {
        await setState({ status: 'error', plan: [], currentStepIndex: 0, escalationQueue: [], traceLog: [], errorMessage: err instanceof IRValidationError ? err.message : String(err) })
        return null
      }

      initGemini(apiKey)
      const tab = await chrome.tabs.get(message.tabId)
      const hostname = tab.url ? new URL(tab.url).hostname : 'unknown'

      const runState = createRunState(ir)
      runState.targetTabId = message.tabId
      runState.targetHostname = hostname
      await setState(runState)

      console.log(`[worker] Plan: ${runState.plan.length} steps for "${ir.study.title}"`)
      runLoop(runState).catch(console.error)  // fire-and-forget; state is persisted per step
      return null
    }

    case 'PAUSE_RUN': {
      const state = await getState()
      if (state?.status === 'running') await setState({ ...state, status: 'paused' })
      return null
    }

    case 'RESUME_RUN': {
      const state = await getState()
      if (state?.status === 'paused') {
        state.status = 'running'
        await setState(state)
        runLoop(state).catch(console.error)
      }
      return null
    }

    case 'ABORT_RUN': {
      await setState({ status: 'idle', plan: [], currentStepIndex: 0, escalationQueue: [], traceLog: [] })
      return null
    }

    case 'RESOLVE_ESCALATION': {
      const state = await getState()
      if (!state) return null
      const item = state.escalationQueue.find((e) => e.id === message.escalationId)
      if (item) {
        item.resolution = message.resolution

        // Apply vocab override directly to the map so the run uses the corrected type
        if (item.id.startsWith('vocab_') && message.resolution.choice === 'override' && message.resolution.value && state.vocabularyMap) {
          const canonicalType = item.id.replace('vocab_', '') as keyof VocabularyMap
          state.vocabularyMap[canonicalType] = message.resolution.value
          if (state.targetHostname) await cacheVocabulary(state.targetHostname, state.vocabularyMap)
        }

        // If all pending escalations resolved, resume
        const allResolved = state.escalationQueue.every((e) => !!e.resolution)
        if (allResolved && state.status === 'paused') {
          state.status = 'running'
          await setState(state)
          runLoop(state).catch(console.error)
        } else {
          await setState(state)
        }
      }
      return null
    }

    case 'RETRY_STEP': {
      const state = await getState()
      if (!state) return null
      const stepIdx = state.plan.findIndex((s) => s.stepId === message.stepId)
      if (stepIdx === -1) return null
      state.plan[stepIdx].status = 'pending'
      state.currentStepIndex = stepIdx
      state.status = 'running'
      await setState(state)
      runLoop(state).catch(console.error)
      return null
    }

    default:
      return null
  }
}

// ── Lifecycle ──────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  console.log('[StudyBuilder] Installed / updated')
})
