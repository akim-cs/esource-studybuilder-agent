// Action executor — the perceive → decide → interact → verify loop.
// Creates visits, forms, and fields by driving the UI through Gemini decisions.
// Never uses hardcoded selectors — every target is identified by Gemini from a live screenshot.

import type { BuildStep, Visit, Form, Field, VocabularyMap, EscalationItem, CanonicalType } from '../shared/types'
import { decideAction, verifyOutcome } from '../shared/gemini'
import { captureAndPerceive, sendInteract, wait } from './helpers'

// ── Step result ────────────────────────────────────────────────────────────────

export interface StepResult {
  outcome: 'success' | 'skipped' | 'escalated' | 'failed'
  action: string
  reasoning: string
  escalation?: EscalationItem
}

// ── Shared utilities ───────────────────────────────────────────────────────────

async function existsOnScreen(tabId: number, label: string): Promise<boolean> {
  const { pageState } = await captureAndPerceive(tabId)
  const target = label.toLowerCase()
  return pageState.controls.some((c) => c.label.toLowerCase().includes(target))
}

// saveAndVerify: click save then confirm the expected state appeared.
// Uses a specific save goal to avoid adjacent decoy buttons (e.g. "Save As Template").
async function saveAndVerify(
  tabId: number,
  stepId: string,
  inputRef: string,
  expectation: string,
): Promise<{ success: boolean; escalation?: EscalationItem }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { screenshot, pageState } = await captureAndPerceive(tabId)
    const saveDecision = await decideAction(
      screenshot, pageState,
      'Click the primary Save button to commit changes — NOT "Save As Template", NOT "Activate", NOT "Preview"',
    )

    if (saveDecision.confidence >= 0.5) {
      await sendInteract(tabId, {
        kind: 'click',
        targetLabel: saveDecision.targetLabel,
        targetRole: saveDecision.targetRole,
        fallbackPosition: saveDecision.fallbackPosition,
      })
      await wait(1200)

      const { screenshot: after } = await captureAndPerceive(tabId)
      const check = await verifyOutcome(after, expectation)
      if (check.success && check.confidence >= 0.7) return { success: true }
    }
  }

  const { screenshot: failShot } = await captureAndPerceive(tabId)
  return {
    success: false,
    escalation: {
      id: `save_${stepId}`,
      stepId,
      inputRef,
      issue: `Save could not be confirmed after 2 attempts. Expected: "${expectation}"`,
      screenshot: failShot,
      bestGuess: 'Save may have succeeded but state change was not detected',
      confidence: 0.3,
    },
  }
}

// ── Navigation helpers ─────────────────────────────────────────────────────────

// Navigate to the study plan page from any screen. Used before cross-visit navigation.
async function navigateToPlan(tabId: number): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { screenshot, pageState } = await captureAndPerceive(tabId)
    const screen = pageState.screen.toLowerCase()
    const nav = pageState.nav_state.toLowerCase()
    // Already at the plan (visit schedule) level if we see a "visit schedule" or "study plan" heading
    // and are NOT inside a builder or visit detail
    if ((nav.includes('plan') || screen.includes('visit schedule') || screen.includes('study plan'))
        && !screen.includes('builder')) {
      return
    }
    const d = await decideAction(screenshot, pageState,
      'Navigate back to the Study Plan / Visit Schedule — click the back button, breadcrumb, or "Study Plan" tab')
    if (d.confidence >= 0.5) {
      await sendInteract(tabId, { kind: 'click', targetLabel: d.targetLabel, targetRole: d.targetRole, fallbackPosition: d.fallbackPosition })
      await wait(1000)
    }
  }
}

// Navigate to a specific visit's source-documents page.
async function navigateToVisitDetail(tabId: number, visitName: string): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const { screenshot, pageState } = await captureAndPerceive(tabId)
    const nav = pageState.nav_state.toLowerCase()
    const screen = pageState.screen.toLowerCase()

    // Success: on the right visit detail page (not in a builder)
    if (nav.includes(visitName.toLowerCase()) && !screen.includes('builder')) return

    // If in a builder, go up one level first
    if (screen.includes('builder')) {
      const backD = await decideAction(screenshot, pageState,
        `Click the back button to leave the form builder and return to the visit or study plan`)
      if (backD.confidence >= 0.5) {
        await sendInteract(tabId, { kind: 'click', targetLabel: backD.targetLabel, targetRole: backD.targetRole, fallbackPosition: backD.fallbackPosition })
        await wait(1000)
        continue
      }
    }

    // Try to click the target visit
    const visitD = await decideAction(screenshot, pageState,
      `Click on the visit named "${visitName}" in the visit schedule table to open its source documents list`)
    if (visitD.confidence >= 0.5) {
      await sendInteract(tabId, { kind: 'click', targetLabel: visitD.targetLabel, targetRole: visitD.targetRole, fallbackPosition: visitD.fallbackPosition })
      await wait(1000)
    } else {
      // Try going to plan first so the visit list is visible
      await navigateToPlan(tabId)
    }
  }
}

// Navigate into the form builder for a specific form within a visit.
async function navigateToFormBuilder(tabId: number, visitName: string, formName: string): Promise<void> {
  // First ensure we're on the right visit detail page
  await navigateToVisitDetail(tabId, visitName)

  for (let attempt = 0; attempt < 3; attempt++) {
    const { screenshot, pageState } = await captureAndPerceive(tabId)
    const nav = pageState.nav_state.toLowerCase()
    const screen = pageState.screen.toLowerCase()

    // Success: in the builder for the right form
    if (screen.includes('builder') && nav.includes(formName.toLowerCase())) return
    // Also accept: in any builder and the form name is visible in nav
    if (screen.includes('builder') && pageState.controls.some(c => c.label.toLowerCase().includes(formName.toLowerCase()))) return

    const editD = await decideAction(screenshot, pageState,
      `Open the form builder for the source document named "${formName}" — click its Edit button or row`)
    if (editD.confidence >= 0.5) {
      await sendInteract(tabId, { kind: 'click', targetLabel: editD.targetLabel, targetRole: editD.targetRole, fallbackPosition: editD.fallbackPosition })
      await wait(1200)
    }
  }
}

// ── createVisit ────────────────────────────────────────────────────────────────

async function createVisit(tabId: number, step: BuildStep): Promise<StepResult> {
  const visit = step.payload as Visit

  // Navigate to plan page for visit creation
  await navigateToPlan(tabId)

  if (await existsOnScreen(tabId, visit.name)) {
    return { outcome: 'skipped', action: 'createVisit', reasoning: `Visit "${visit.name}" already exists` }
  }

  let { screenshot, pageState } = await captureAndPerceive(tabId)
  const addDecision = await decideAction(screenshot, pageState, 'Click the button or link to add or create a new visit')

  if (addDecision.confidence < 0.6) {
    return {
      outcome: 'escalated', action: 'createVisit', reasoning: 'Add-visit control not found',
      escalation: {
        id: `visit_add_${step.stepId}`, stepId: step.stepId, inputRef: step.inputRef,
        issue: `Could not locate the "add visit" button. Best guess: "${addDecision.targetLabel}" (${Math.round(addDecision.confidence * 100)}% confident).`,
        screenshot, bestGuess: addDecision.targetLabel, confidence: addDecision.confidence,
      },
    }
  }

  await sendInteract(tabId, { kind: 'click', targetLabel: addDecision.targetLabel, targetRole: addDecision.targetRole, fallbackPosition: addDecision.fallbackPosition })
  await wait(800)

  ;({ screenshot, pageState } = await captureAndPerceive(tabId))
  const nameDecision = await decideAction(screenshot, pageState, `Find the visit name input field and type "${visit.name}"`)
  await sendInteract(tabId, { kind: 'type', targetLabel: nameDecision.targetLabel, targetRole: nameDecision.targetRole, fallbackPosition: nameDecision.fallbackPosition, value: visit.name })
  await wait(300)

  const { success, escalation } = await saveAndVerify(tabId, step.stepId, step.inputRef, `Visit named "${visit.name}" appears in the list`)
  if (!success) return { outcome: 'escalated', action: 'createVisit', reasoning: 'Save unconfirmed', escalation }

  return { outcome: 'success', action: 'createVisit', reasoning: `Created visit "${visit.name}"` }
}

// ── createForm ─────────────────────────────────────────────────────────────────

async function createForm(tabId: number, step: BuildStep): Promise<StepResult> {
  const form = step.payload as Form
  const visitName = step.context.visitName!

  // Navigate to the visit detail page (handles being in a builder or wrong visit)
  await navigateToVisitDetail(tabId, visitName)

  const { screenshot: checkShot, pageState: checkState } = await captureAndPerceive(tabId)
  if (checkState.controls.some((c) => c.label.toLowerCase().includes(form.name.toLowerCase()))) {
    return { outcome: 'skipped', action: 'createForm', reasoning: `Form "${form.name}" already exists` }
  }

  let { screenshot, pageState } = await captureAndPerceive(tabId)
  const addDecision = await decideAction(screenshot, pageState, 'Click the button to add a new form, source document, or CRF to this visit')
  if (addDecision.confidence < 0.6) {
    return {
      outcome: 'escalated', action: 'createForm', reasoning: 'Add-form control not found',
      escalation: {
        id: `form_add_${step.stepId}`, stepId: step.stepId, inputRef: step.inputRef,
        issue: `Could not locate the "add form" button under visit "${visitName}".`,
        screenshot, bestGuess: addDecision.targetLabel, confidence: addDecision.confidence,
      },
    }
  }

  await sendInteract(tabId, { kind: 'click', targetLabel: addDecision.targetLabel, targetRole: addDecision.targetRole, fallbackPosition: addDecision.fallbackPosition })
  await wait(800)

  ;({ screenshot, pageState } = await captureAndPerceive(tabId))
  const nameDecision = await decideAction(screenshot, pageState, `Find the form or document name input and type "${form.name}"`)
  await sendInteract(tabId, { kind: 'type', targetLabel: nameDecision.targetLabel, targetRole: nameDecision.targetRole, fallbackPosition: nameDecision.fallbackPosition, value: form.name })
  await wait(300)

  if (form.repeating) {
    ;({ screenshot, pageState } = await captureAndPerceive(tabId))
    const repeatDecision = await decideAction(screenshot, pageState, 'Find and enable the repeating or recurring form toggle or checkbox')
    if (repeatDecision.confidence >= 0.6) {
      await sendInteract(tabId, { kind: 'click', targetLabel: repeatDecision.targetLabel, targetRole: repeatDecision.targetRole, fallbackPosition: repeatDecision.fallbackPosition })
      await wait(300)
    }
  }

  const { success, escalation } = await saveAndVerify(tabId, step.stepId, step.inputRef, `Form named "${form.name}" appears under visit "${visitName}"`)
  if (!success) return { outcome: 'escalated', action: 'createForm', reasoning: 'Save unconfirmed', escalation }

  return { outcome: 'success', action: 'createForm', reasoning: `Created form "${form.name}" under "${visitName}"` }
}

// ── addField ───────────────────────────────────────────────────────────────────

async function addField(tabId: number, step: BuildStep, vocabMap: VocabularyMap): Promise<StepResult> {
  const field = step.payload as Field
  const visitName = step.context.visitName!
  const formName = step.context.formName!
  const platformType = vocabMap[field.type as CanonicalType]

  if (!platformType) {
    return {
      outcome: 'escalated', action: 'addField', reasoning: `No platform type mapped for "${field.type}"`,
      escalation: {
        id: `vocab_missing_${step.stepId}`, stepId: step.stepId, inputRef: step.inputRef,
        issue: `Vocabulary map has no entry for canonical type "${field.type}". Human must supply the platform label.`,
        screenshot: '', bestGuess: field.type, confidence: 0,
      },
    }
  }

  // ── 0. Navigate to the form builder ──────────────────────────────────────────
  await navigateToFormBuilder(tabId, visitName, formName)

  // Idempotency — check canvas for the field label after navigating to builder
  if (await existsOnScreen(tabId, field.label)) {
    return { outcome: 'skipped', action: 'addField', reasoning: `Field "${field.label}" already exists` }
  }

  // ── 1. Add element by clicking the library item for the target type ───────────
  // Clicking the library tile adds an element of the right type AND auto-selects it.
  // This is the only safe approach — changing the type AFTER adding discards values/range.
  let { screenshot, pageState } = await captureAndPerceive(tabId)
  const libDecision = await decideAction(screenshot, pageState,
    `Click the element library tile labeled exactly "${platformType}" in the element library panel to add a new field of this type`)

  if (libDecision.confidence < 0.5) {
    return {
      outcome: 'escalated', action: 'addField', reasoning: 'Library item not found',
      escalation: {
        id: `field_add_${step.stepId}`, stepId: step.stepId, inputRef: step.inputRef,
        issue: `Could not locate "${platformType}" in the element library for field "${field.label}".`,
        screenshot, bestGuess: libDecision.targetLabel, confidence: libDecision.confidence,
      },
    }
  }
  await sendInteract(tabId, { kind: 'click', targetLabel: libDecision.targetLabel, targetRole: libDecision.targetRole, fallbackPosition: libDecision.fallbackPosition })
  await wait(700)

  // ── 2. Label ──────────────────────────────────────────────────────────────────
  ;({ screenshot, pageState } = await captureAndPerceive(tabId))
  const labelDecision = await decideAction(screenshot, pageState,
    `Find the "Label" input in the Options panel on the right side and type "${field.label}"`)
  await sendInteract(tabId, { kind: 'type', targetLabel: labelDecision.targetLabel, targetRole: labelDecision.targetRole, fallbackPosition: labelDecision.fallbackPosition, value: field.label })
  await wait(300)

  // ── 3. Required ───────────────────────────────────────────────────────────────
  if (field.required) {
    ;({ screenshot, pageState } = await captureAndPerceive(tabId))
    const reqDecision = await decideAction(screenshot, pageState,
      'Find and check the "Required" checkbox in the Options panel')
    if (reqDecision.confidence >= 0.6) {
      await sendInteract(tabId, { kind: 'click', targetLabel: reqDecision.targetLabel, targetRole: reqDecision.targetRole, fallbackPosition: reqDecision.fallbackPosition })
      await wait(300)
    }
  }

  // ── 4. Save + verify the field exists on the canvas ──────────────────────────
  const initialSave = await saveAndVerify(tabId, step.stepId, step.inputRef,
    `A field labeled "${field.label}" of type "${platformType}" appears on the form canvas`)
  if (!initialSave.success) return { outcome: 'escalated', action: 'addField', reasoning: 'Initial save failed', escalation: initialSave.escalation }

  // ── 5. Coded values ───────────────────────────────────────────────────────────
  // Use paste-values (one textarea + apply button) to enter all options at once.
  // Safer than per-option clicking because we control the entire list in one shot.
  if (field.options && field.options.length > 0) {
    // Re-select the element on the canvas to show Options panel
    ;({ screenshot, pageState } = await captureAndPerceive(tabId))
    const reselD = await decideAction(screenshot, pageState,
      `Click on the element card labeled "${field.label}" on the form canvas to select it and show its Options panel`)
    if (reselD.confidence >= 0.5) {
      await sendInteract(tabId, { kind: 'click', targetLabel: reselD.targetLabel, targetRole: reselD.targetRole, fallbackPosition: reselD.fallbackPosition })
      await wait(400)
    }

    ;({ screenshot, pageState } = await captureAndPerceive(tabId))
    const pasteText = field.options.map((o) => `${o.code}=${o.label}`).join('\n')
    const pasteAreaDecision = await decideAction(screenshot, pageState,
      'Find the "Paste Values (replaces list)" textarea in the Values section of the Options panel')
    await sendInteract(tabId, { kind: 'type', targetLabel: pasteAreaDecision.targetLabel, targetRole: pasteAreaDecision.targetRole, fallbackPosition: pasteAreaDecision.fallbackPosition, value: pasteText })
    await wait(300)

    ;({ screenshot, pageState } = await captureAndPerceive(tabId))
    const applyDecision = await decideAction(screenshot, pageState,
      'Click the "Apply Pasted Values" button to populate the coded-value list')
    if (applyDecision.confidence >= 0.5) {
      await sendInteract(tabId, { kind: 'click', targetLabel: applyDecision.targetLabel, targetRole: applyDecision.targetRole, fallbackPosition: applyDecision.fallbackPosition })
      await wait(400)
    }

    await saveAndVerify(tabId, step.stepId, step.inputRef, `Coded values saved for field "${field.label}"`)
  }

  // ── 6. Range (min / max / units) ──────────────────────────────────────────────
  if (field.min !== undefined || field.max !== undefined) {
    ;({ screenshot, pageState } = await captureAndPerceive(tabId))
    const reselD = await decideAction(screenshot, pageState,
      `Click on the element card labeled "${field.label}" on the canvas to select it`)
    if (reselD.confidence >= 0.5) {
      await sendInteract(tabId, { kind: 'click', targetLabel: reselD.targetLabel, targetRole: reselD.targetRole, fallbackPosition: reselD.fallbackPosition })
      await wait(400)
      ;({ screenshot, pageState } = await captureAndPerceive(tabId))
    }

    if (field.min !== undefined) {
      const minD = await decideAction(screenshot, pageState,
        `Find the "Minimum" input in the Range Check section and enter ${field.min}`)
      await sendInteract(tabId, { kind: 'type', targetLabel: minD.targetLabel, targetRole: minD.targetRole, fallbackPosition: minD.fallbackPosition, value: String(field.min) })
    }
    if (field.max !== undefined) {
      const maxD = await decideAction(screenshot, pageState,
        `Find the "Maximum" input in the Range Check section and enter ${field.max}`)
      await sendInteract(tabId, { kind: 'type', targetLabel: maxD.targetLabel, targetRole: maxD.targetRole, fallbackPosition: maxD.fallbackPosition, value: String(field.max) })
    }
    if (field.units) {
      const unitsD = await decideAction(screenshot, pageState,
        `Find the "Units" input in the Range Check section and enter "${field.units}"`)
      await sendInteract(tabId, { kind: 'type', targetLabel: unitsD.targetLabel, targetRole: unitsD.targetRole, fallbackPosition: unitsD.fallbackPosition, value: field.units })
    }
    await saveAndVerify(tabId, step.stepId, step.inputRef, `Range saved for field "${field.label}"`)
  }

  // ── 7. Skip logic / Element Visibility ────────────────────────────────────────
  // Last — the target "when" field must already exist on the canvas.
  if (field.skip_logic) {
    ;({ screenshot, pageState } = await captureAndPerceive(tabId))
    const reselD = await decideAction(screenshot, pageState,
      `Click on the element card labeled "${field.label}" on the canvas to select it and see its Options panel`)
    if (reselD.confidence >= 0.5) {
      await sendInteract(tabId, { kind: 'click', targetLabel: reselD.targetLabel, targetRole: reselD.targetRole, fallbackPosition: reselD.fallbackPosition })
      await wait(400)
      ;({ screenshot, pageState } = await captureAndPerceive(tabId))
    }

    // Change visibility mode to "conditional / Visible When…"
    const visD = await decideAction(screenshot, pageState,
      'Find the "Visibility" dropdown in the Element Visibility section and select the "Visible When…" or conditional option')
    if (visD.confidence < 0.5) {
      return {
        outcome: 'escalated', action: 'addField:skipLogic', reasoning: 'Visibility selector not found',
        escalation: {
          id: `skip_${step.stepId}`, stepId: step.stepId, inputRef: step.inputRef,
          issue: `Could not find the Visibility selector for field "${field.label}". Rule: show when "${field.skip_logic.when_field_label}" = "${field.skip_logic.equals_value}".`,
          screenshot, bestGuess: 'Visibility section not visible', confidence: visD.confidence,
        },
      }
    }
    await sendInteract(tabId, { kind: 'select', targetLabel: visD.targetLabel, targetRole: visD.targetRole, fallbackPosition: visD.fallbackPosition, value: 'when' })
    await wait(500)

    // Select the "when" field by its label text
    ;({ screenshot, pageState } = await captureAndPerceive(tabId))
    const whenD = await decideAction(screenshot, pageState,
      `Find the "When Element" dropdown and select the element labeled "${field.skip_logic.when_field_label}"`)
    await sendInteract(tabId, { kind: 'select', targetLabel: whenD.targetLabel, targetRole: whenD.targetRole, fallbackPosition: whenD.fallbackPosition, value: field.skip_logic.when_field_label })
    await wait(400)

    // Set the equals value
    ;({ screenshot, pageState } = await captureAndPerceive(tabId))
    const eqD = await decideAction(screenshot, pageState,
      `Find the "Equals Value" input in the Element Visibility section and type "${field.skip_logic.equals_value}"`)
    await sendInteract(tabId, { kind: 'type', targetLabel: eqD.targetLabel, targetRole: eqD.targetRole, fallbackPosition: eqD.fallbackPosition, value: field.skip_logic.equals_value })

    await saveAndVerify(tabId, step.stepId, step.inputRef,
      `Visibility condition saved: field "${field.label}" shows when "${field.skip_logic.when_field_label}" equals "${field.skip_logic.equals_value}"`)
  }

  // ── Final read-back: confirm label AND type survived ──────────────────────────
  const { screenshot: finalShot } = await captureAndPerceive(tabId)
  const readBack = await verifyOutcome(
    finalShot,
    `The form canvas shows a field labeled exactly "${field.label}" with type "${platformType}"`,
  )
  if (!readBack.success || readBack.confidence < 0.7) {
    return {
      outcome: 'escalated', action: 'addField:readBack', reasoning: readBack.reason,
      escalation: {
        id: `readback_${step.stepId}`, stepId: step.stepId, inputRef: step.inputRef,
        issue: `Field "${field.label}" read-back failed: ${readBack.reason}`,
        screenshot: finalShot, bestGuess: 'Field may have wrong label or type', confidence: readBack.confidence,
      },
    }
  }

  return {
    outcome: 'success', action: 'addField',
    reasoning: `Created field "${field.label}" (${field.type} → ${platformType})`,
  }
}

// ── Public dispatcher ──────────────────────────────────────────────────────────

export async function executeStep(
  tabId: number,
  step: BuildStep,
  vocabMap: VocabularyMap,
): Promise<StepResult> {
  switch (step.type) {
    case 'visit': return createVisit(tabId, step)
    case 'form':  return createForm(tabId, step)
    case 'field': return addField(tabId, step, vocabMap)
    default:
      return { outcome: 'failed', action: 'unknown', reasoning: `Unknown step type: ${step.type}` }
  }
}
