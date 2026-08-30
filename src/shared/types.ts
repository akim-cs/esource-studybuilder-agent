// ── Input IR schema ────────────────────────────────────────────────────────────

export interface StudyIR {
  ir_version: string;
  study: StudyMeta;
  visits: Visit[];
}

export interface StudyMeta {
  protocol_id: string;
  title: string;
}

export interface Visit {
  name: string;
  window_start_day: number;
  window_end_day: number;
  forms: Form[];
}

export interface Form {
  name: string;
  repeating: boolean;
  fields: Field[];
}

export type CanonicalType =
  | 'text' | 'textarea' | 'integer' | 'decimal'
  | 'date' | 'time' | 'datetime' | 'boolean'
  | 'single_select' | 'multi_select' | 'radio' | 'checkbox' | 'calculated';

export const ALL_CANONICAL_TYPES: CanonicalType[] = [
  'text', 'textarea', 'integer', 'decimal',
  'date', 'time', 'datetime', 'boolean',
  'single_select', 'multi_select', 'radio', 'checkbox', 'calculated',
];

export interface FieldOption {
  code: string;
  label: string;
}

export interface SkipLogic {
  when_field_label: string;
  equals_value: string;
}

export interface Field {
  label: string;
  type: CanonicalType;
  required: boolean;
  options?: FieldOption[];
  min?: number;
  max?: number;
  units?: string;
  formula?: string;
  skip_logic?: SkipLogic;
}

// ── Build plan ─────────────────────────────────────────────────────────────────

export type StepType = 'visit' | 'form' | 'field';
export type StepStatus = 'pending' | 'in_progress' | 'done' | 'escalated' | 'failed' | 'skipped';

export interface StepContext {
  visitName?: string;
  formName?: string;
}

export interface BuildStep {
  stepId: string;       // deterministic hash — stable across re-runs
  inputRef: string;     // e.g. "visits[0].forms[2].fields[5]"
  type: StepType;
  payload: Visit | Form | Field;
  context: StepContext;
  status: StepStatus;
}

// ── Page perception ────────────────────────────────────────────────────────────

export interface UIControl {
  label: string;
  role: string;
  position: { x: number; y: number };
  tag?: string;
}

export interface PageState {
  screen: string;          // e.g. "visit list", "field editor"
  controls: UIControl[];
  nav_state: string;       // breadcrumb or current location description
}

// ── Vocabulary mapping ─────────────────────────────────────────────────────────

export interface VocabEntry {
  canonicalType: CanonicalType;
  platformLabel: string;
  confidence: number;      // 0–1
  reasoning: string;
}

export type VocabularyMap = Record<CanonicalType, string>;

// ── Traceability log ───────────────────────────────────────────────────────────

export interface TraceEntry {
  stepId: string;
  inputRef: string;
  action: string;
  reasoning: string;
  outcome: 'success' | 'skipped' | 'escalated' | 'failed';
  timestamp: string;
}

// ── Human escalation ───────────────────────────────────────────────────────────

export interface EscalationItem {
  id: string;
  stepId: string;
  inputRef: string;
  issue: string;
  screenshot: string;     // base64 data URL
  bestGuess?: string;
  confidence?: number;
  resolution?: EscalationResolution;
}

export interface EscalationResolution {
  choice: 'approve' | 'override' | 'skip';
  value?: string;         // the override value, if choice === 'override'
}

// ── Run state (persisted to chrome.storage.local) ─────────────────────────────

export interface RunState {
  status: 'idle' | 'running' | 'paused' | 'complete' | 'error';
  plan: BuildStep[];
  currentStepIndex: number;
  targetTabId?: number;
  vocabularyMap?: VocabularyMap;
  escalationQueue: EscalationItem[];
  traceLog: TraceEntry[];
  errorMessage?: string;
}

// ── Extension messages ─────────────────────────────────────────────────────────

export type ExtMessage =
  | { type: 'START_RUN'; studyIR: StudyIR; tabId: number }
  | { type: 'PAUSE_RUN' }
  | { type: 'RESUME_RUN' }
  | { type: 'ABORT_RUN' }
  | { type: 'STATE_UPDATE'; runState: RunState }
  | { type: 'RESOLVE_ESCALATION'; escalationId: string; resolution: EscalationResolution }
  | { type: 'GET_PAGE_STATE' }
  | { type: 'PAGE_STATE_RESULT'; state: PageState; screenshotDataUrl: string }
  | { type: 'INTERACT'; action: InteractAction }
  | { type: 'INTERACT_RESULT'; success: boolean; error?: string };

export interface InteractAction {
  kind: 'click' | 'type' | 'select' | 'clear';
  targetLabel: string;
  targetRole: string;
  value?: string;
  fallbackPosition?: { x: number; y: number };
}
