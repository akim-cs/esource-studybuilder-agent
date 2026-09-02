// Shared browser helpers — used by both worker.ts and executor.ts.
// Keeps tab interaction and perception in one place.

import type { ExtMessage, PageState, UIControl, InteractAction } from '../shared/types'
import { perceivePage } from '../shared/gemini'

let lastCaptureAt = 0
const MIN_CAPTURE_INTERVAL_MS = 600  // Chrome allows ~2/sec; we stay well under

export async function captureScreenshot(tabId: number): Promise<string> {
  // Throttle to avoid MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND
  const since = Date.now() - lastCaptureAt
  if (since < MIN_CAPTURE_INTERVAL_MS) await new Promise((r) => setTimeout(r, MIN_CAPTURE_INTERVAL_MS - since))

  const tab = await chrome.tabs.get(tabId)

  // Retry up to 3 times — handles transient rate-limit and "tab not active" errors
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // Ensure the target tab is the active tab in its window before capturing
      await chrome.tabs.update(tabId, { active: true })
      await new Promise((r) => setTimeout(r, 150))  // let Chrome settle focus
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' })
      lastCaptureAt = Date.now()
      return dataUrl
    } catch (err) {
      const msg = String(err)
      const isTransient = msg.includes('MAX_CAPTURE') || msg.includes('activeTab') || msg.includes('not in effect')
      if (!isTransient || attempt === 2) throw err
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)))
    }
  }
  throw new Error('captureScreenshot: unreachable')
}

async function ensureContentScript(tabId: number): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'GET_PAGE_STATE' } satisfies ExtMessage)
  } catch {
    // Content script not running — inject it now (happens after extension reload)
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content/index.js'] })
    await new Promise((r) => setTimeout(r, 400))
  }
}

export async function getA11yTree(tabId: number): Promise<UIControl[]> {
  await ensureContentScript(tabId)
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: 'GET_PAGE_STATE' } satisfies ExtMessage)
    const msg = response as { state: PageState }
    return msg?.state?.controls ?? []
  } catch {
    return []
  }
}

export async function captureAndPerceive(tabId: number): Promise<{ screenshot: string; pageState: PageState }> {
  const [screenshot, a11yTree] = await Promise.all([
    captureScreenshot(tabId),
    getA11yTree(tabId),
  ])
  const pageState = await perceivePage(screenshot, a11yTree)
  return { screenshot, pageState }
}

export async function sendInteract(tabId: number, action: InteractAction): Promise<boolean> {
  const response = await chrome.tabs.sendMessage(tabId, { type: 'INTERACT', action } satisfies ExtMessage)
  const result = response as { success: boolean; error?: string }
  if (!result.success) console.warn('[interact] Failed:', result.error, '|', action.targetLabel)
  return result.success
}

// getPageSnapshot: screenshot + raw content-script state — NO Gemini call.
// Use this everywhere you only need the current controls for planActions or idempotency checks.
export async function getPageSnapshot(tabId: number): Promise<{ screenshot: string; rawState: PageState }> {
  await ensureContentScript(tabId)
  const [screenshot, response] = await Promise.all([
    captureScreenshot(tabId),
    chrome.tabs.sendMessage(tabId, { type: 'GET_PAGE_STATE' } satisfies ExtMessage).catch(() => null),
  ])
  const rawState: PageState = (response as { state: PageState } | null)?.state ?? {
    screen: '', controls: [], nav_state: '',
  }
  return { screenshot, rawState }
}

export const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
