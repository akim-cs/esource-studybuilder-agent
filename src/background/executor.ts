// Action executor — snapshot once → plan all actions → execute → verify.
// One Gemini call plans the complete action sequence for each step;
// a second call verifies the outcome. Navigation uses the same pattern.

import type { BuildStep, Visit, Form, Field, VocabularyMap, EscalationItem, CanonicalType } from '../shared/types'
import { verifyOutcome, planActions } from '../shared/gemini'
import { captureAndPerceive, getPageSnapshot, sendInteract, wait } from './helpers'

// ── Step result ────────────────────────────────────────────────────────────────

export interface StepResult {
  outcome: 'success' | 'skipped' | 'escalated' | 'failed'
  action: string
  reasoning: string
  escalation?: EscalationItem
}

// ── Shared utilities ───────────────────────────────────────────────────────────

// No Gemini — just checks the raw a11y tree for a label substring.
async function existsOnScreen(tabId: number, label: string): Promise<boolean> {
  const { rawState } = await getPageSnapshot(tabId)
  return rawState.controls.some((c) => c.label.toLowerCase().includes(label.toLowerCase()))
}

// Execute a planned action sequence with a short pause between each action.
async function runPlan(tabId: number, actions: { kind: string; targetLabel: string; targetRole: string; value?: string; fallbackPosition?: { x: number; y: number } }[]): Promise<void> {
  for (const action of actions) {
    await sendInteract(tabId, {
      kind: action.kind as 'click' | 'type' | 'select' | 'clear',
      targetLabel: action.targetLabel,
      targetRole: action.targetRole,
      value: action.value,
      fallbackPosition: action.fallbackPosition,
    })
    await wait(350)
  }
}

// ── Navigation helpers ─────────────────────────────────────────────────────────
// captureAndPerceive (Gemini) for screen detection; planActions (Gemini) for action planning.
// Together: 2 calls per iteration — same count as before, but planActions can encode
// multi-click sequences so we need fewer iterations overall.

async function navigateToPlan(tabId: number): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { screenshot, pageState } = await captureAndPerceive(tabId)
    const screen = pageState.screen.toLowerCase()
    const nav = pageState.nav_state.toLowerCase()
    if ((nav.includes('plan') || screen.includes('visit schedule') || screen.includes('study plan'))
        && !screen.includes('builder')) return

    const actions = await planActions(screenshot, pageState.controls,
      'Navigate back to the Study Plan / Visit Schedule — click the back button, breadcrumb, or tab. Return ALL navigation clicks needed.')
    await runPlan(tabId, actions)
    await wait(900)
  }
}

async function navigateToVisitDetail(tabId: number, visitName: string): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const { screenshot, pageState } = await captureAndPerceive(tabId)
    const nav = pageState.nav_state.toLowerCase()
    const screen = pageState.screen.toLowerCase()
    if (nav.includes(visitName.toLowerCase()) && !screen.includes('builder')) return

    const goal = screen.includes('builder')
      ? 'Click the back button to leave the form builder and return to the visit or study plan'
      : `Click the visit named "${visitName}" to open its source documents list. If the visit list is not visible, first navigate to the Study Plan.`
    const actions = await planActions(screenshot, pageState.controls, goal)
    await runPlan(tabId, actions)
    await wait(900)
  }
}

async function navigateToFormBuilder(tabId: number, visitName: string, formName: string): Promise<void> {
  await navigateToVisitDetail(tabId, visitName)

  for (let attempt = 0; attempt < 3; attempt++) {
    const { screenshot, pageState } = await captureAndPerceive(tabId)
    const nav = pageState.nav_state.toLowerCase()
    const screen = pageState.screen.toLowerCase()
    if (screen.includes('builder') && (nav.includes(formName.toLowerCase()) ||
        pageState.controls.some((c) => c.label.toLowerCase().includes(formName.toLowerCase())))) return

    const actions = await planActions(screenshot, pageState.controls,
      `Open the form builder for the source document named "${formName}" — click its Edit button or row.`)
    await runPlan(tabId, actions)
    await wait(1100)
  }
}

// ── createVisit ────────────────────────────────────────────────────────────────

async function createVisit(tabId: number, step: BuildStep): Promise<StepResult> {
  const visit = step.payload as Visit
  await navigateToPlan(tabId)

  if (await existsOnScreen(tabId, visit.name)) {
    return { outcome: 'skipped', action: 'createVisit', reasoning: `Visit "${visit.name}" already exists` }
  }

  const { screenshot, rawState } = await getPageSnapshot(tabId)
  const goal = [
    `1. Click the button or link to add / create a new visit`,
    `2. Type "${visit.name}" into the visit name input field`,
    `3. Click Save (or confirm) to create the visit`,
  ].join('\n')

  const actions = await planActions(screenshot, rawState.controls, goal)
  await runPlan(tabId, actions)
  await wait(800)

  const { screenshot: finalShot } = await getPageSnapshot(tabId)
  const verify = await verifyOutcome(finalShot, `Visit named "${visit.name}" appears in the visit schedule list`)
  if (!verify.success || verify.confidence < 0.7) {
    return {
      outcome: 'escalated', action: 'createVisit', reasoning: verify.reason,
      escalation: {
        id: `visit_verify_${step.stepId}`, stepId: step.stepId, inputRef: step.inputRef,
        issue: `Visit "${visit.name}" could not be confirmed after creation: ${verify.reason}`,
        screenshot: finalShot, bestGuess: 'Visit may have been created', confidence: verify.confidence,
      },
    }
  }
  return { outcome: 'success', action: 'createVisit', reasoning: `Created visit "${visit.name}"` }
}

// ── createForm ─────────────────────────────────────────────────────────────────

async function createForm(tabId: number, step: BuildStep): Promise<StepResult> {
  const form = step.payload as Form
  const visitName = step.context.visitName!
  await navigateToVisitDetail(tabId, visitName)

  if (await existsOnScreen(tabId, form.name)) {
    return { outcome: 'skipped', action: 'createForm', reasoning: `Form "${form.name}" already exists` }
  }

  const { screenshot, rawState } = await getPageSnapshot(tabId)
  const repeatingNote = form.repeating ? '\n3. Enable the repeating/recurring form toggle or checkbox' : ''
  const saveStep = form.repeating ? 4 : 3
  const goal = [
    `1. Click the button to add a new form, source document, or CRF to this visit`,
    `2. Type "${form.name}" into the form / document name input`,
    repeatingNote,
    `${saveStep}. Click Save to create the form`,
  ].filter(Boolean).join('\n')

  const actions = await planActions(screenshot, rawState.controls, goal)
  await runPlan(tabId, actions)
  await wait(800)

  const { screenshot: finalShot } = await getPageSnapshot(tabId)
  const verify = await verifyOutcome(finalShot, `Form named "${form.name}" appears under visit "${visitName}"`)
  if (!verify.success || verify.confidence < 0.7) {
    return {
      outcome: 'escalated', action: 'createForm', reasoning: verify.reason,
      escalation: {
        id: `form_verify_${step.stepId}`, stepId: step.stepId, inputRef: step.inputRef,
        issue: `Form "${form.name}" could not be confirmed after creation: ${verify.reason}`,
        screenshot: finalShot, bestGuess: 'Form may have been created', confidence: verify.confidence,
      },
    }
  }
  return { outcome: 'success', action: 'createForm', reasoning: `Created form "${form.name}" under "${visitName}"` }
}

// ── addField ───────────────────────────────────────────────────────────────────

function buildFieldGoal(field: Field, platformType: string): string {
  const steps: string[] = [
    `1. Click the element library tile labeled "${platformType}" to add a new field of this type`,
    `2. In the Options panel, type "${field.label}" into the "Label" input (clear it first)`,
  ]
  let n = 3

  if (field.required) {
    steps.push(`${n}. Check the "Required" checkbox in the Options panel`)
    n++
  }

  steps.push(`${n}. Click the "Save" button (NOT "Save As Template")`)
  n++

  if (field.options && field.options.length > 0) {
    const pasteText = field.options.map((o) => `${o.code}=${o.label}`).join('\n')
    steps.push(`${n}. Click the "${field.label}" card on the canvas to re-select it`)
    n++
    steps.push(`${n}. Type the following into the "Paste Values (replaces list)" textarea:\n${pasteText}`)
    n++
    steps.push(`${n}. Click the "Apply Pasted Values" button`)
    n++
    steps.push(`${n}. Click "Save"`)
    n++
  }

  if (field.min !== undefined || field.max !== undefined || field.units) {
    steps.push(`${n}. Click the "${field.label}" card on the canvas to re-select it`)
    n++
    if (field.min !== undefined) { steps.push(`${n}. Type "${field.min}" into the "Minimum" input`); n++ }
    if (field.max !== undefined) { steps.push(`${n}. Type "${field.max}" into the "Maximum" input`); n++ }
    if (field.units)             { steps.push(`${n}. Type "${field.units}" into the "Units" input`); n++ }
    steps.push(`${n}. Click "Save"`)
    n++
  }

  if (field.skip_logic) {
    steps.push(`${n}. Click the "${field.label}" card on the canvas to re-select it`)
    n++
    steps.push(`${n}. Select "Visible When…" (or the conditional option) from the "Visibility" dropdown`)
    n++
    steps.push(`${n}. Select "${field.skip_logic.when_field_label}" from the "When Element" dropdown`)
    n++
    steps.push(`${n}. Type "${field.skip_logic.equals_value}" into the "Equals Value" input`)
    n++
    steps.push(`${n}. Click "Save"`)
    n++
  }

  return steps.join('\n')
}

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

  // ── Navigate (uses captureAndPerceive for screen detection) ───────────────────
  await navigateToFormBuilder(tabId, visitName, formName)

  // ── Idempotency check (no Gemini) ─────────────────────────────────────────────
  if (await existsOnScreen(tabId, field.label)) {
    return { outcome: 'skipped', action: 'addField', reasoning: `Field "${field.label}" already exists` }
  }

  // ── Snapshot + plan all actions in ONE Gemini call ────────────────────────────
  const { screenshot, rawState } = await getPageSnapshot(tabId)
  const goal = buildFieldGoal(field, platformType)
  const actions = await planActions(screenshot, rawState.controls, goal)

  if (actions.length === 0) {
    return {
      outcome: 'escalated', action: 'addField', reasoning: 'planActions returned an empty sequence',
      escalation: {
        id: `plan_empty_${step.stepId}`, stepId: step.stepId, inputRef: step.inputRef,
        issue: `Gemini returned no actions for field "${field.label}" (${platformType}). The screen may not show the form builder.`,
        screenshot, bestGuess: 'Ensure the form builder is open and the element library is visible', confidence: 0.1,
      },
    }
  }

  // ── Execute ───────────────────────────────────────────────────────────────────
  await runPlan(tabId, actions)
  await wait(800)

  // ── Verify (one final Gemini call) ────────────────────────────────────────────
  const { screenshot: finalShot } = await getPageSnapshot(tabId)
  const verify = await verifyOutcome(
    finalShot,
    `The form canvas shows a field labeled "${field.label}" with type "${platformType}"`,
  )
  if (!verify.success || verify.confidence < 0.7) {
    return {
      outcome: 'escalated', action: 'addField:verify', reasoning: verify.reason,
      escalation: {
        id: `readback_${step.stepId}`, stepId: step.stepId, inputRef: step.inputRef,
        issue: `Field "${field.label}" verification failed: ${verify.reason}`,
        screenshot: finalShot, bestGuess: 'Field may have wrong label or type', confidence: verify.confidence,
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
