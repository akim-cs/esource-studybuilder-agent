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

// Idempotency: check if a label is already visible in the a11y tree (no Gemini call needed)
async function existsOnScreen(tabId: number, label: string): Promise<boolean> {
  const { pageState } = await captureAndPerceive(tabId)
  const target = label.toLowerCase()
  return pageState.controls.some((c) => c.label.toLowerCase().includes(target))
}

// After every meaningful action, click save and confirm the result changed.
// Retries once before escalating.
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
      'Click the save, submit, or confirm button to persist the current changes',
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

// ── createVisit ────────────────────────────────────────────────────────────────

async function createVisit(tabId: number, step: BuildStep): Promise<StepResult> {
  const visit = step.payload as Visit

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

  // Navigate into the visit if we're not already there
  let { screenshot, pageState } = await captureAndPerceive(tabId)
  if (!pageState.nav_state.toLowerCase().includes(visitName.toLowerCase())) {
    const visitDecision = await decideAction(screenshot, pageState, `Click on the visit named "${visitName}" to open its form list`)
    await sendInteract(tabId, { kind: 'click', targetLabel: visitDecision.targetLabel, targetRole: visitDecision.targetRole, fallbackPosition: visitDecision.fallbackPosition })
    await wait(1000)
    ;({ screenshot, pageState } = await captureAndPerceive(tabId))
  }

  if (pageState.controls.some((c) => c.label.toLowerCase().includes(form.name.toLowerCase()))) {
    return { outcome: 'skipped', action: 'createForm', reasoning: `Form "${form.name}" already exists` }
  }

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
  const nameDecision = await decideAction(screenshot, pageState, `Find the form name input and type "${form.name}"`)
  await sendInteract(tabId, { kind: 'type', targetLabel: nameDecision.targetLabel, targetRole: nameDecision.targetRole, fallbackPosition: nameDecision.fallbackPosition, value: form.name })
  await wait(300)

  // Repeating flag
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

  if (await existsOnScreen(tabId, field.label)) {
    return { outcome: 'skipped', action: 'addField', reasoning: `Field "${field.label}" already exists` }
  }

  // Open add-field UI
  let { screenshot, pageState } = await captureAndPerceive(tabId)
  const addDecision = await decideAction(screenshot, pageState, 'Click the button to add a new field or question to this form')
  if (addDecision.confidence < 0.6) {
    return {
      outcome: 'escalated', action: 'addField', reasoning: 'Add-field control not found',
      escalation: {
        id: `field_add_${step.stepId}`, stepId: step.stepId, inputRef: step.inputRef,
        issue: `Could not locate the "add field" button for field "${field.label}".`,
        screenshot, bestGuess: addDecision.targetLabel, confidence: addDecision.confidence,
      },
    }
  }
  await sendInteract(tabId, { kind: 'click', targetLabel: addDecision.targetLabel, targetRole: addDecision.targetRole, fallbackPosition: addDecision.fallbackPosition })
  await wait(800)

  // ── 1. Type first — always before label/range/options ─────────────────────
  ;({ screenshot, pageState } = await captureAndPerceive(tabId))
  const typePickerDecision = await decideAction(screenshot, pageState, `Open the field type selector or type dropdown`)
  await sendInteract(tabId, { kind: 'click', targetLabel: typePickerDecision.targetLabel, targetRole: typePickerDecision.targetRole, fallbackPosition: typePickerDecision.fallbackPosition })
  await wait(500)

  ;({ screenshot, pageState } = await captureAndPerceive(tabId))
  const typeOptionDecision = await decideAction(screenshot, pageState, `Select the option "${platformType}" from the type list`)
  await sendInteract(tabId, { kind: 'click', targetLabel: typeOptionDecision.targetLabel, targetRole: typeOptionDecision.targetRole, fallbackPosition: typeOptionDecision.fallbackPosition })
  await wait(500)

  // ── 2. Label ──────────────────────────────────────────────────────────────
  ;({ screenshot, pageState } = await captureAndPerceive(tabId))
  const labelDecision = await decideAction(screenshot, pageState, `Find the field label or question text input and type "${field.label}"`)
  await sendInteract(tabId, { kind: 'type', targetLabel: labelDecision.targetLabel, targetRole: labelDecision.targetRole, fallbackPosition: labelDecision.fallbackPosition, value: field.label })
  await wait(300)

  // ── 3. Required ───────────────────────────────────────────────────────────
  if (field.required) {
    ;({ screenshot, pageState } = await captureAndPerceive(tabId))
    const reqDecision = await decideAction(screenshot, pageState, 'Find and check the "required" checkbox or toggle')
    if (reqDecision.confidence >= 0.6) {
      await sendInteract(tabId, { kind: 'click', targetLabel: reqDecision.targetLabel, targetRole: reqDecision.targetRole, fallbackPosition: reqDecision.fallbackPosition })
      await wait(300)
    }
  }

  // ── 4. Save — verify label + type persisted ───────────────────────────────
  const initialSave = await saveAndVerify(tabId, step.stepId, step.inputRef, `Field "${field.label}" of type "${platformType}" appears in the form`)
  if (!initialSave.success) return { outcome: 'escalated', action: 'addField', reasoning: 'Initial save failed', escalation: initialSave.escalation }

  // ── 5. Options (coded values — enter code AND label for each) ─────────────
  if (field.options && field.options.length > 0) {
    for (const option of field.options) {
      ;({ screenshot, pageState } = await captureAndPerceive(tabId))
      const addOptDecision = await decideAction(screenshot, pageState, `Click to add a new coded option or choice to this field`)
      if (addOptDecision.confidence >= 0.6) {
        await sendInteract(tabId, { kind: 'click', targetLabel: addOptDecision.targetLabel, targetRole: addOptDecision.targetRole, fallbackPosition: addOptDecision.fallbackPosition })
        await wait(400)

        ;({ screenshot, pageState } = await captureAndPerceive(tabId))
        const codeDecision = await decideAction(screenshot, pageState, `Find the code or value input for this option and type "${option.code}"`)
        await sendInteract(tabId, { kind: 'type', targetLabel: codeDecision.targetLabel, targetRole: codeDecision.targetRole, fallbackPosition: codeDecision.fallbackPosition, value: option.code })

        const optLabelDecision = await decideAction(screenshot, pageState, `Find the display label input for this option and type "${option.label}"`)
        await sendInteract(tabId, { kind: 'type', targetLabel: optLabelDecision.targetLabel, targetRole: optLabelDecision.targetRole, fallbackPosition: optLabelDecision.fallbackPosition, value: option.label })
        await wait(300)
      }
    }
    await saveAndVerify(tabId, step.stepId, step.inputRef, `Options saved for field "${field.label}"`)
  }

  // ── 6. Range (min / max / units) ──────────────────────────────────────────
  if (field.min !== undefined || field.max !== undefined) {
    ;({ screenshot, pageState } = await captureAndPerceive(tabId))

    if (field.min !== undefined) {
      const minD = await decideAction(screenshot, pageState, `Find the minimum value input and enter ${field.min}`)
      await sendInteract(tabId, { kind: 'type', targetLabel: minD.targetLabel, targetRole: minD.targetRole, fallbackPosition: minD.fallbackPosition, value: String(field.min) })
    }
    if (field.max !== undefined) {
      const maxD = await decideAction(screenshot, pageState, `Find the maximum value input and enter ${field.max}`)
      await sendInteract(tabId, { kind: 'type', targetLabel: maxD.targetLabel, targetRole: maxD.targetRole, fallbackPosition: maxD.fallbackPosition, value: String(field.max) })
    }
    if (field.units) {
      const unitsD = await decideAction(screenshot, pageState, `Find the units input and enter "${field.units}"`)
      await sendInteract(tabId, { kind: 'type', targetLabel: unitsD.targetLabel, targetRole: unitsD.targetRole, fallbackPosition: unitsD.fallbackPosition, value: field.units })
    }
    await saveAndVerify(tabId, step.stepId, step.inputRef, `Range saved for field "${field.label}"`)
  }

  // ── 7. Skip logic (last — target field must already exist) ─────────────────
  if (field.skip_logic) {
    ;({ screenshot, pageState } = await captureAndPerceive(tabId))
    const skipD = await decideAction(screenshot, pageState, 'Find the skip logic, conditional display, or branching rules section')

    if (skipD.confidence < 0.6) {
      const { screenshot: ss } = await captureAndPerceive(tabId)
      return {
        outcome: 'escalated', action: 'addField:skipLogic', reasoning: 'Skip logic section not found',
        escalation: {
          id: `skip_${step.stepId}`, stepId: step.stepId, inputRef: step.inputRef,
          issue: `Could not find skip logic editor for field "${field.label}". Rule: show when "${field.skip_logic.when_field_label}" = "${field.skip_logic.equals_value}".`,
          screenshot: ss, bestGuess: 'Skip logic section not visible', confidence: skipD.confidence,
        },
      }
    }

    await sendInteract(tabId, { kind: 'click', targetLabel: skipD.targetLabel, targetRole: skipD.targetRole, fallbackPosition: skipD.fallbackPosition })
    await wait(500)

    ;({ screenshot, pageState } = await captureAndPerceive(tabId))
    const whenD = await decideAction(screenshot, pageState, `Set the "when field" condition to target the field labeled "${field.skip_logic.when_field_label}"`)
    await sendInteract(tabId, { kind: 'click', targetLabel: whenD.targetLabel, targetRole: whenD.targetRole, fallbackPosition: whenD.fallbackPosition })
    await wait(400)

    const eqD = await decideAction(screenshot, pageState, `Set the equals/value condition to "${field.skip_logic.equals_value}"`)
    await sendInteract(tabId, { kind: 'type', targetLabel: eqD.targetLabel, targetRole: eqD.targetRole, fallbackPosition: eqD.fallbackPosition, value: field.skip_logic.equals_value })

    await saveAndVerify(tabId, step.stepId, step.inputRef, `Skip logic rule saved for field "${field.label}"`)
  }

  // ── Final read-back: confirm label AND type survived ─────────────────────
  // Separate from saveAndVerify — this checks specific properties, not just that the UI changed.
  const { screenshot: finalShot } = await captureAndPerceive(tabId)
  const readBack = await verifyOutcome(
    finalShot,
    `The field list shows a field labeled exactly "${field.label}" with type "${platformType}"`,
  )
  if (!readBack.success || readBack.confidence < 0.7) {
    return {
      outcome: 'escalated', action: 'addField:readBack', reasoning: readBack.reason,
      escalation: {
        id: `readback_${step.stepId}`, stepId: step.stepId, inputRef: step.inputRef,
        issue: `Field "${field.label}" was created but read-back check failed: ${readBack.reason}`,
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
