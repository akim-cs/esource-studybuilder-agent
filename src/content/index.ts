// Content script — injected into the eSource tab.
// Provides: page perception (a11y tree) and interaction (click / type / select).
// Screenshots are captured by the background worker via chrome.tabs.captureVisibleTab.

import type { ExtMessage, PageState, UIControl, InteractAction } from '../shared/types'

// ── Perception ─────────────────────────────────────────────────────────────────

function resolveLabel(el: HTMLElement): string {
  // aria-label takes priority
  const ariaLabel = el.getAttribute('aria-label')
  if (ariaLabel) return ariaLabel.trim()

  // aria-labelledby
  const labelledBy = el.getAttribute('aria-labelledby')
  if (labelledBy) {
    const text = document.getElementById(labelledBy)?.textContent?.trim()
    if (text) return text
  }

  // <label for="id"> association — this is the standard HTML pattern used by most form builders
  if (el.id) {
    const associated = document.querySelector<HTMLLabelElement>(`label[for="${CSS.escape(el.id)}"]`)
    if (associated) {
      const text = associated.textContent?.trim()
      if (text) return text
    }
  }

  // title attribute
  const title = el.getAttribute('title')
  if (title) return title

  // textContent fallback (buttons, links)
  return el.textContent?.trim().slice(0, 80) ?? ''
}

function buildA11yTree(): UIControl[] {
  const controls: UIControl[] = []
  const nodes = document.querySelectorAll<HTMLElement>('button, a, input, select, textarea, [role]')

  nodes.forEach((el) => {
    const label = resolveLabel(el)
    const role = el.getAttribute('role') || el.tagName.toLowerCase()
    const rect = el.getBoundingClientRect()

    if (rect.width === 0 || rect.height === 0) return  // skip invisible elements
    if (!label) return

    controls.push({
      label: label.trim(),
      role,
      position: {
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2),
      },
      tag: el.tagName.toLowerCase(),
    })
  })

  return controls
}

function getCurrentPageState(): PageState {
  return {
    screen: document.title,
    controls: buildA11yTree(),
    nav_state: window.location.pathname + window.location.search,
  }
}

// ── Interaction ────────────────────────────────────────────────────────────────

function findElement(targetLabel: string, targetRole: string): HTMLElement | null {
  const normalizedLabel = targetLabel.trim().toLowerCase()
  const normalizedRole = targetRole.trim().toLowerCase()

  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>('button, a, input, select, textarea, [role]')
  )

  function getLabel(el: HTMLElement): string {
    return resolveLabel(el).toLowerCase()
  }

  function roleMatches(el: HTMLElement): boolean {
    if (normalizedRole === 'any') return true
    const role = (el.getAttribute('role') || el.tagName.toLowerCase()).toLowerCase()
    return role.includes(normalizedRole)
  }

  // First pass: exact label match — avoids picking "Save As Template" when looking for "Save"
  for (const el of candidates) {
    if (!roleMatches(el)) continue
    if (getLabel(el) === normalizedLabel) return el
  }

  // Second pass: substring match
  for (const el of candidates) {
    if (!roleMatches(el)) continue
    const label = getLabel(el)
    if (label.includes(normalizedLabel) || normalizedLabel.includes(label)) return el
  }

  return null
}

async function performInteraction(action: InteractAction): Promise<{ success: boolean; error?: string }> {
  const el = findElement(action.targetLabel, action.targetRole)

  if (!el) {
    // Fallback: coordinate-based click if position is provided
    if (action.fallbackPosition) {
      const target = document.elementFromPoint(action.fallbackPosition.x, action.fallbackPosition.y) as HTMLElement | null
      if (target) {
        target.click()
        return { success: true }
      }
    }
    return { success: false, error: `Element not found: "${action.targetLabel}" (${action.targetRole})` }
  }

  try {
    switch (action.kind) {
      case 'click':
        el.focus()
        el.click()
        break
      case 'type':
        el.focus()
        ;(el as HTMLInputElement).value = ''
        ;(el as HTMLInputElement).value = action.value ?? ''
        el.dispatchEvent(new Event('input', { bubbles: true }))
        el.dispatchEvent(new Event('change', { bubbles: true }))
        break
      case 'clear':
        el.focus()
        ;(el as HTMLInputElement).value = ''
        el.dispatchEvent(new Event('input', { bubbles: true }))
        break
      case 'select':
        if (el instanceof HTMLSelectElement) {
          const needle = (action.value ?? '').toLowerCase()
          const option = Array.from(el.options).find(
            (o) => o.text.toLowerCase() === needle || o.text.toLowerCase().includes(needle) || o.value.toLowerCase() === needle
          )
          if (option) el.value = option.value
          el.dispatchEvent(new Event('change', { bubbles: true }))
        } else {
          el.click()
        }
        break
    }
    return { success: true }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}

// ── Message listener ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message: ExtMessage, _sender, sendResponse) => {
  if (message.type === 'GET_PAGE_STATE') {
    sendResponse({ type: 'PAGE_STATE_RESULT', state: getCurrentPageState(), screenshotDataUrl: '' })
  }

  if (message.type === 'INTERACT') {
    performInteraction(message.action).then((result) => {
      sendResponse({ type: 'INTERACT_RESULT', ...result })
    })
    return true
  }
})
