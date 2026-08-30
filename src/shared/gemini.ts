// Gemini 2.0 Flash API wrapper — all LLM calls go through here.
// Uses @google/genai v1.x (createPartFromBase64 / createPartFromText helpers).

import { GoogleGenAI, createPartFromBase64, createPartFromText } from '@google/genai'
import type { PageState, UIControl } from './types'

const MODEL = 'gemini-2.0-flash'

// 15 RPM free tier = 1 call per 4 s minimum. We use 4.5 s to stay safe.
const MIN_CALL_INTERVAL_MS = 4500
let lastCallAt = 0

async function rateLimit(): Promise<void> {
  const wait = MIN_CALL_INTERVAL_MS - (Date.now() - lastCallAt)
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  lastCallAt = Date.now()
}

let ai: GoogleGenAI | null = null

export function initGemini(apiKey: string): void {
  ai = new GoogleGenAI({ apiKey })
}

function client(): GoogleGenAI {
  if (!ai) throw new Error('Gemini not initialized — configure API key in extension options')
  return ai
}

// ── Low-level call ─────────────────────────────────────────────────────────────

export async function callGeminiJSON<T>(
  systemPrompt: string,
  userText: string,
  screenshotBase64?: string,  // raw base64, no data: prefix
): Promise<T> {
  await rateLimit()

  const parts = screenshotBase64
    ? [createPartFromBase64(screenshotBase64, 'image/png'), createPartFromText(userText)]
    : [createPartFromText(userText)]

  const response = await client().models.generateContent({
    model: MODEL,
    contents: parts,
    config: {
      systemInstruction: systemPrompt,
      responseMimeType: 'application/json',
    },
  })

  const raw = response.text ?? ''
  // Strip markdown fences if model ignores responseMimeType
  const cleaned = raw.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '').trim()
  return JSON.parse(cleaned) as T
}

// ── Strip data URL prefix to get raw base64 ───────────────────────────────────

export function dataUrlToBase64(dataUrl: string): string {
  return dataUrl.split(',')[1] ?? ''
}

// ── Page perception ────────────────────────────────────────────────────────────

const PERCEIVE_SYSTEM = `
You are analyzing a screenshot of an eSource web application used for clinical trial study building.
Identify what screen is currently shown and what interactive controls are available.
Return ONLY valid JSON — no markdown, no explanation.
`.trim()

function a11yTreeToText(controls: UIControl[]): string {
  return controls
    .slice(0, 80)  // cap to avoid prompt bloat
    .map((c) => `[${c.role}] "${c.label}" at (${c.position.x},${c.position.y})`)
    .join('\n')
}

export async function perceivePage(
  screenshotDataUrl: string,
  a11yTree: UIControl[],
): Promise<PageState> {
  const userText = `
Accessibility tree (interactive elements extracted from the DOM):
${a11yTreeToText(a11yTree)}

Return JSON matching this schema exactly:
{
  "screen": "<brief name: 'visit list' | 'form editor' | 'field editor' | 'type picker' | 'options editor' | 'range editor' | 'skip logic editor' | 'unknown'>",
  "nav_state": "<breadcrumb or location description>",
  "controls": [
    { "label": "<visible label>", "role": "<semantic role>", "position": {"x": 0, "y": 0} }
  ]
}
Include only interactive, visible controls. Prioritize controls relevant to building study structure.
`.trim()

  return callGeminiJSON<PageState>(
    PERCEIVE_SYSTEM,
    userText,
    dataUrlToBase64(screenshotDataUrl),
  )
}

// ── Vocabulary discovery ────────────────────────────────────────────────────────

const VOCAB_SYSTEM = `
You are mapping a clinical eSource platform's field-type library to canonical types.
The 13 canonical types are:
  text, textarea, integer, decimal, date, time, datetime, boolean,
  single_select, multi_select, radio, checkbox, calculated

Key semantic distinctions to reason about:
- single_select vs radio: same data, different presentation (dropdown vs radio group)
- checkbox: a SINGLE tick box (boolean-like); multi_select: a CODED LIST with multiple choices
- integer: whole numbers only; decimal: includes fractional values
- calculated: formula-derived, read-only

Return ONLY valid JSON — no markdown.
`.trim()

export interface VocabEntry {
  platformLabel: string
  canonicalType: string
  confidence: number  // 0–1
  reasoning: string
}

export async function discoverVocabulary(
  screenshotDataUrl: string,
  a11yTree: UIControl[],
): Promise<VocabEntry[]> {
  const userText = `
Accessibility tree of the type picker:
${a11yTreeToText(a11yTree)}

List every field-type option visible in the screenshot. For each, determine which canonical type it maps to.

Return a JSON array:
[
  {
    "platformLabel": "<exact label as shown>",
    "canonicalType": "<one of the 13 canonical types>",
    "confidence": 0.95,
    "reasoning": "<brief explanation>"
  }
]
`.trim()

  return callGeminiJSON<VocabEntry[]>(
    VOCAB_SYSTEM,
    userText,
    dataUrlToBase64(screenshotDataUrl),
  )
}

// ── Action decision ─────────────────────────────────────────────────────────────
// Given a perceived PageState and a goal, Gemini picks the right control to interact with.

const ACTION_SYSTEM = `
You are controlling a clinical eSource web application to build a study structure.
Given the current screen state and a goal, identify which control to interact with.
Return ONLY valid JSON — no markdown.
`.trim()

export interface ActionDecision {
  targetLabel: string
  targetRole: string
  fallbackPosition: { x: number; y: number }
  confidence: number
  reasoning: string
}

export async function decideAction(
  screenshotDataUrl: string,
  pageState: PageState,
  goal: string,
): Promise<ActionDecision> {
  const controlsList = pageState.controls
    .map((c) => `[${c.role}] "${c.label}" at (${c.position.x},${c.position.y})`)
    .join('\n')

  const userText = `
Current screen: ${pageState.screen}
Navigation: ${pageState.nav_state}

Available controls:
${controlsList}

Goal: ${goal}

Return JSON:
{
  "targetLabel": "<label of the control to interact with>",
  "targetRole": "<its role>",
  "fallbackPosition": {"x": 0, "y": 0},
  "confidence": 0.9,
  "reasoning": "<why this control>"
}
`.trim()

  return callGeminiJSON<ActionDecision>(
    ACTION_SYSTEM,
    userText,
    dataUrlToBase64(screenshotDataUrl),
  )
}

// ── Post-action verification ────────────────────────────────────────────────────

const VERIFY_SYSTEM = `
You are verifying that a clinical eSource web application performed an action correctly.
Check whether the current screen matches the expected state.
Return ONLY valid JSON — no markdown.
`.trim()

export interface VerifyResult {
  success: boolean
  reason: string
  confidence: number
}

export async function verifyOutcome(
  screenshotDataUrl: string,
  expectation: string,
): Promise<VerifyResult> {
  const userText = `
Expected state: ${expectation}

Does the current screenshot match this expectation?

Return JSON:
{
  "success": true,
  "reason": "<what you see that confirms or contradicts>",
  "confidence": 0.9
}
`.trim()

  return callGeminiJSON<VerifyResult>(
    VERIFY_SYSTEM,
    userText,
    dataUrlToBase64(screenshotDataUrl),
  )
}
