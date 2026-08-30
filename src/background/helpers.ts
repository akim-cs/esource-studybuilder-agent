// Shared browser helpers — used by both worker.ts and executor.ts.
// Keeps tab interaction and perception in one place.

import type { ExtMessage, PageState, UIControl, InteractAction } from '../shared/types'
import { perceivePage } from '../shared/gemini'

export async function captureScreenshot(tabId: number): Promise<string> {
  const tab = await chrome.tabs.get(tabId)
  return chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' })
}

export async function getA11yTree(tabId: number): Promise<UIControl[]> {
  const response = await chrome.tabs.sendMessage(tabId, { type: 'GET_PAGE_STATE' } satisfies ExtMessage)
  const msg = response as { state: PageState }
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

export async function sendInteract(tabId: number, action: InteractAction): Promise<boolean> {
  const response = await chrome.tabs.sendMessage(tabId, { type: 'INTERACT', action } satisfies ExtMessage)
  const result = response as { success: boolean; error?: string }
  if (!result.success) console.warn('[interact] Failed:', result.error, '|', action.targetLabel)
  return result.success
}

export const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
