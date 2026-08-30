// IR ingestion, validation, stable ID assignment, and build plan compilation.
// Produces a flat, dependency-ordered BuildStep[] ready for the executor.

import type {
  StudyIR, Visit, Form, Field, CanonicalType,
  BuildStep, StepType, RunState,
} from './types'

const ALL_CANONICAL_TYPES = new Set<CanonicalType>([
  'text', 'textarea', 'integer', 'decimal',
  'date', 'time', 'datetime', 'boolean',
  'single_select', 'multi_select', 'radio', 'checkbox', 'calculated',
])

// ── Stable ID ─────────────────────────────────────────────────────────────────
// Deterministic, human-readable hash so the same element always gets the same ID
// across re-runs. Collision risk is negligible for study scale (< 1000 elements).

function stableId(parts: string[]): string {
  const str = parts.join('|')
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = (Math.imul(31, hash) + str.charCodeAt(i)) | 0
  }
  const suffix = Math.abs(hash).toString(16).padStart(8, '0')
  return `${parts[parts.length - 1].slice(0, 20).replace(/\s+/g, '_')}_${suffix}`
}

// ── Validation ─────────────────────────────────────────────────────────────────

export class IRValidationError extends Error {
  constructor(message: string) {
    super(`[IR] ${message}`)
  }
}

function assertString(val: unknown, path: string): string {
  if (typeof val !== 'string' || val.trim() === '') {
    throw new IRValidationError(`Expected non-empty string at ${path}, got ${JSON.stringify(val)}`)
  }
  return val.trim()
}

function assertBoolean(val: unknown, path: string): boolean {
  if (typeof val !== 'boolean') {
    throw new IRValidationError(`Expected boolean at ${path}, got ${JSON.stringify(val)}`)
  }
  return val
}

function validateField(field: unknown, path: string): Field {
  if (typeof field !== 'object' || field === null) {
    throw new IRValidationError(`Expected object at ${path}`)
  }
  const f = field as Record<string, unknown>
  const label = assertString(f.label, `${path}.label`)
  const type = assertString(f.type, `${path}.type`) as CanonicalType
  if (!ALL_CANONICAL_TYPES.has(type)) {
    throw new IRValidationError(
      `Unknown canonical type "${type}" at ${path}.type. ` +
      `Valid types: ${[...ALL_CANONICAL_TYPES].join(', ')}`
    )
  }
  const required = assertBoolean(f.required, `${path}.required`)
  return {
    label,
    type,
    required,
    options: Array.isArray(f.options)
      ? f.options.map((o, i) => ({
          code: assertString((o as Record<string, unknown>).code, `${path}.options[${i}].code`),
          label: assertString((o as Record<string, unknown>).label, `${path}.options[${i}].label`),
        }))
      : undefined,
    min: typeof f.min === 'number' ? f.min : undefined,
    max: typeof f.max === 'number' ? f.max : undefined,
    units: typeof f.units === 'string' ? f.units : undefined,
    formula: typeof f.formula === 'string' ? f.formula : undefined,
    skip_logic:
      f.skip_logic && typeof f.skip_logic === 'object'
        ? {
            when_field_label: assertString(
              (f.skip_logic as Record<string, unknown>).when_field_label,
              `${path}.skip_logic.when_field_label`
            ),
            equals_value: assertString(
              (f.skip_logic as Record<string, unknown>).equals_value,
              `${path}.skip_logic.equals_value`
            ),
          }
        : undefined,
  }
}

function validateForm(form: unknown, path: string): Form {
  if (typeof form !== 'object' || form === null) {
    throw new IRValidationError(`Expected object at ${path}`)
  }
  const f = form as Record<string, unknown>
  const name = assertString(f.name, `${path}.name`)
  const repeating = assertBoolean(f.repeating, `${path}.repeating`)
  if (!Array.isArray(f.fields)) {
    throw new IRValidationError(`Expected array at ${path}.fields`)
  }
  const fields = (f.fields as unknown[]).map((field, i) =>
    validateField(field, `${path}.fields[${i}]`)
  )
  return { name, repeating, fields }
}

function validateVisit(visit: unknown, path: string): Visit {
  if (typeof visit !== 'object' || visit === null) {
    throw new IRValidationError(`Expected object at ${path}`)
  }
  const v = visit as Record<string, unknown>
  const name = assertString(v.name, `${path}.name`)
  if (!Array.isArray(v.forms)) {
    throw new IRValidationError(`Expected array at ${path}.forms`)
  }
  const forms = (v.forms as unknown[]).map((form, i) =>
    validateForm(form, `${path}.forms[${i}]`)
  )
  return {
    name,
    window_start_day: typeof v.window_start_day === 'number' ? v.window_start_day : 0,
    window_end_day: typeof v.window_end_day === 'number' ? v.window_end_day : 0,
    forms,
  }
}

export function validateIR(raw: unknown): StudyIR {
  if (typeof raw !== 'object' || raw === null) {
    throw new IRValidationError('Root must be an object')
  }
  const r = raw as Record<string, unknown>
  if (typeof r.study !== 'object' || r.study === null) {
    throw new IRValidationError('Missing or invalid "study" object')
  }
  const study = r.study as Record<string, unknown>
  if (!Array.isArray(r.visits)) {
    throw new IRValidationError('Missing or invalid "visits" array')
  }
  return {
    ir_version: typeof r.ir_version === 'string' ? r.ir_version : '1.0',
    study: {
      protocol_id: assertString(study.protocol_id, 'study.protocol_id'),
      title: assertString(study.title, 'study.title'),
    },
    visits: (r.visits as unknown[]).map((v, i) => validateVisit(v, `visits[${i}]`)),
  }
}

// ── Topological sort ───────────────────────────────────────────────────────────
// Fields within a form are sorted so that any field referenced by another
// field's skip_logic appears before the dependent field.
// Cycles are detected and the offending step is returned separately.

interface TopoResult {
  ordered: Field[]
  cycleFields: Field[]   // fields involved in a dependency cycle
}

function topoSortFields(fields: Field[]): TopoResult {
  const labelToField = new Map<string, Field>(fields.map((f) => [f.label, f]))
  const visited = new Set<string>()
  const stack = new Set<string>()
  const sorted: Field[] = []
  const cycleFields: Field[] = []

  function visit(label: string): boolean {
    if (stack.has(label)) return false  // cycle detected
    if (visited.has(label)) return true
    const field = labelToField.get(label)
    if (!field) return true  // dependency not in this form — skip (will escalate later)
    stack.add(label)
    if (field.skip_logic) {
      const depLabel = field.skip_logic.when_field_label
      if (!visit(depLabel)) {
        cycleFields.push(field)
        stack.delete(label)
        visited.add(label)
        return false
      }
    }
    stack.delete(label)
    visited.add(label)
    sorted.push(field)
    return true
  }

  for (const field of fields) {
    if (!visited.has(field.label)) {
      visit(field.label)
    }
  }

  return { ordered: sorted, cycleFields }
}

// ── Build plan compiler ────────────────────────────────────────────────────────

export function compilePlan(ir: StudyIR): BuildStep[] {
  const steps: BuildStep[] = []

  for (let vi = 0; vi < ir.visits.length; vi++) {
    const visit = ir.visits[vi]
    const visitRef = `visits[${vi}]`

    steps.push({
      stepId: stableId([ir.study.protocol_id, visit.name]),
      inputRef: visitRef,
      type: 'visit' as StepType,
      payload: visit,
      context: { visitName: visit.name },
      status: 'pending',
    })

    for (let fi = 0; fi < visit.forms.length; fi++) {
      const form = visit.forms[fi]
      const formRef = `${visitRef}.forms[${fi}]`

      steps.push({
        stepId: stableId([ir.study.protocol_id, visit.name, form.name]),
        inputRef: formRef,
        type: 'form' as StepType,
        payload: form,
        context: { visitName: visit.name, formName: form.name },
        status: 'pending',
      })

      const { ordered, cycleFields } = topoSortFields(form.fields)

      // Cycle fields get added first as escalated — they can't be safely ordered
      for (const field of cycleFields) {
        const origIdx = form.fields.indexOf(field)
        steps.push({
          stepId: stableId([ir.study.protocol_id, visit.name, form.name, field.label]),
          inputRef: `${formRef}.fields[${origIdx}]`,
          type: 'field' as StepType,
          payload: field,
          context: { visitName: visit.name, formName: form.name },
          status: 'escalated',
        })
      }

      for (const field of ordered) {
        const origIdx = form.fields.indexOf(field)
        steps.push({
          stepId: stableId([ir.study.protocol_id, visit.name, form.name, field.label]),
          inputRef: `${formRef}.fields[${origIdx}]`,
          type: 'field' as StepType,
          payload: field,
          context: { visitName: visit.name, formName: form.name },
          status: 'pending',
        })
      }
    }
  }

  return steps
}

// ── Initial RunState factory ───────────────────────────────────────────────────

export function createRunState(ir: StudyIR): RunState {
  return {
    status: 'running',
    plan: compilePlan(ir),
    currentStepIndex: 0,
    escalationQueue: [],
    traceLog: [],
  }
}
