# eSource StudyBuilder Agent — Design Document

## Context

A Chrome MV3 extension that replaces manual clinical trial study-building in eSource platforms. Given a JSON input describing visits, forms, and fields, it drives the platform's own UI to construct the full structure. **The core constraint: must work on an unseen platform with zero code changes.** Any hardcoded selector, label, or DOM structure specific to the provided mock is an automatic fail on evaluation.

---

## Design Decisions

| Decision | Chosen | Why | Rejected |
|---|---|---|---|
| Extension type | Chrome MV3 | Required | — |
| Language | TypeScript | Schema is the backbone; type errors at compile time, not at field 87 | Plain JS |
| Bundler | Vite (HTML pages) + esbuild (scripts) | Vite handles React/HTML; esbuild gives IIFE for content script, ESM for background | vite-plugin-web-ext (quirky with Vite 5), Webpack |
| LLM | **Gemini 2.0 Flash** via `@google/genai` | Free tier (1,500 req/day, 15 RPM); strong vision; no paid credits needed | Claude API (no credits), GPT-4o (no credits) |
| UI perception | Screenshot + a11y tree | A11y tree alone is sparse; screenshot alone has coordinate fragility; combined is most reliable | Pure DOM selectors (auto-fail), Computer Use coords (fragile) |
| Click targeting | Accessible name + role match | Layout-independent; survives resize/zoom | Hardcoded selectors (auto-fail), pixel coords |
| Side panel | React (minimal) | Reactive escalation queue + live status | Vanilla JS |
| Persistence | `chrome.storage.local` | All extension contexts share it; survives SW restarts | IndexedDB (overkill), backend (unnecessary) |
| Vocab cache | Per hostname, derived once | 195 fields × re-derive = expensive; type library is stable per run | Per-field derivation |
| Field build order | Topological sort | skip_logic deps must exist before rules can be set | Array order (unsafe) |
| No fine-tuning | Base model | Must reason about *unseen* platform vocab; fine-tuning on mock = overfitting | Fine-tuned model |

---

## Architecture

```
[ User: loads JSON, clicks Run, resolves escalations ]
              ↕ chrome.runtime messages
[ Background Service Worker (background/worker.ts) ]
   - holds run state
   - compiles + walks build plan
   - calls Gemini API for all LLM decisions
   - broadcasts state updates to side panel
              ↕ chrome.tabs / chrome.scripting
[ Content Script (content/index.ts) ]
   - builds a11y tree from live DOM
   - performs: click / type / select / clear
   - find-by-label+role → fallback to coordinates
              ↓
[ eSource Web App (any platform) ]

[ Side Panel (sidepanel/App.tsx) ]
   - shows status + step counts
   - renders escalation cards
   - sends commands to background worker

[ Options Page (options/index.html) ]
   - Gemini API key entry → chrome.storage.local
```

---

## Implementation Phases (2-day scope)

### Day 1 — Foundation

| Phase | Est. | Deliverable |
|---|---|---|
| 1. Scaffold | 2 hrs | Loadable extension, message channel, API key save |
| 2. IR Ingestion | 2 hrs | Parse + validate JSON, stable IDs, topological sort, BuildStep[] |
| 3. Perception | 3 hrs | Screenshot + a11y tree → Gemini → PageState |
| 4. Vocabulary Discovery | 2 hrs | Type picker enumeration → VocabularyMap, cached by hostname |

### Day 2 — Agent Loop

| Phase | Est. | Deliverable |
|---|---|---|
| 5. Action Executor | 5 hrs | createVisit / createForm / addField with perceive→act→verify loop |
| 6. Escalation Gate | 2 hrs | Escalation queue, side panel card, background resumes on resolve |
| 7. Verification + Traceability | 2 hrs | Post-save screenshot check, TraceEntry log, idempotency |
| Testing + recording | 1 hr | Manual run, screen recording |

---

## Build Plan Compiler

**Input:** StudyIR JSON  
**Output:** Flat `BuildStep[]` with deterministic IDs and dependency-safe ordering

Steps in order:
1. For each visit: one `type: 'visit'` step
2. For each form under that visit: one `type: 'form'` step
3. For each field in the form: topological sort by `skip_logic.when_field_label` dependency → `type: 'field'` steps in safe order

**Stable ID:** `sha1(visitName + '|' + formName + '|' + fieldLabel)` — survives re-runs.  
**Idempotency:** Before creating, perceive the relevant list page; if stable ID already exists in state, mark step `skipped`.

---

## Perception Layer

Content script provides:
- Lightweight a11y tree: interactive elements only (button, input, select, [role]), with label + role + center position. Invisible elements excluded.

Background worker:
1. Calls `chrome.tabs.captureVisibleTab` → screenshot (base64)
2. Sends message to content script → gets a11y tree
3. Packages both → Gemini Vision call

Gemini returns `PageState`:
```typescript
{
  screen: string;      // "visit list" | "field editor" | ...
  controls: UIControl[];
  nav_state: string;
}
```

### Concept breakdown

| Term | What it is |
|---|---|
| **Screenshot** | A PNG image of whatever is visible in the eSource browser tab right now — how the agent "sees" the page. Captured via Chrome's `captureVisibleTab` API, encoded as base64. |
| **Accessibility tree (a11y tree)** | A parallel text description of every interactive element on the page, the same data screen readers use. Gives us exact label text and element roles (`[button] "Add Visit"`, `[input] "Visit Name"`) without having to OCR the image. Extracted live from the DOM by the content script. |
| **Gemini Vision** | Sending both the screenshot (image) and a11y tree (text) to Gemini 2.0 Flash together. Screenshot covers visual context and layout that the a11y tree misses; a11y tree covers exact labels that vision alone might misread. Together they're more reliable than either alone. |
| **PageState** | The structured JSON output Gemini returns after analyzing the page: the screen name (`"visit list"`), a navigation breadcrumb, and a cleaned list of interactive controls with labels and positions. Every agent decision — what to click, whether a save succeeded — is made from a fresh `PageState`. |

**Data flow:**
```
eSource tab → captureVisibleTab()  → PNG (base64)  ─┐
eSource tab → content script      → a11y tree (text) ─┤→ Gemini Vision → PageState
```

---

## Vocabulary Discovery

Run **once per platform** (cached by `window.location.hostname`):

1. Navigate to "add field" flow via perception (Gemini finds the button, content script clicks it)
2. Screenshot the type picker
3. Gemini prompt: *"List every option in this type picker. For each, state the label exactly as shown and which of the 13 canonical types it maps to, with confidence 0–1 and reasoning."*
4. Returns `VocabEntry[]`
5. Entries with `confidence < 0.8` → queued as escalation items before any field is built
6. Store as `VocabularyMap` in `chrome.storage.local`

**Why it generalizes:** Gemini reasons semantically. "Check List" → `multi_select`, "Tick Box" → `checkbox`. The model is never shown both at training time — it infers from meaning.

### Concept breakdown

The input JSON uses 13 standard type names (`integer`, `single_select`, `checkbox`, etc.). Every eSource platform uses its own names for the same things — "Whole Number," "Coded Pick List," "Tick Box." Before creating any fields, the agent needs a lookup table: *on this platform, what do I actually click to get a field of type `integer`?* That table is the **vocabulary map**.

**How it's built:** The agent navigates to the type picker (the dropdown where a human would choose a field type), screenshots it, and sends it to Gemini. Gemini reads every option and reasons about what each one means — not by matching strings, but by understanding semantics. It also returns a confidence score per mapping. Anything below 80% is flagged for human review before a single field is touched.

**Caching:** Once built, the map is saved to `chrome.storage.local` keyed by the platform's hostname. Re-running the extension on the same platform skips discovery entirely.

| Piece | What it does |
|---|---|
| `loadCachedVocabulary` | Check if we've already mapped this platform's types before |
| `cacheVocabulary` | Save the lookup table so the next run skips discovery |
| `buildVocabularyResult` | Convert Gemini's answers into the map; flag anything under 80% confident |
| `applyVocabOverride` | Apply a human's correction to a mapping |
| `runVocabularyDiscovery` | Full sequence: navigate → screenshot type picker → ask Gemini → build map → cache → return escalations |
| `sendInteract` | Tell the content script to click something (also reused by Phase 5) |

---

## Action Executor

The agent's hands. For every step: **perceive → Gemini picks control → interact → verify**. Repeats up to 2× on failure before escalating to the human.

### `addField` sub-step order (strict — order matters)
1. **Type first** — platforms silently wipe range/options if type changes after they're set
2. Label → required flag → **save + verify**
3. Options (code AND label per entry)
4. Range (min / max / units)
5. Skip logic last — target field must already exist in the form

### Key behaviours
- **Save confirmation:** after every save, re-perceive and ask Gemini "did this work?" — never assume a click succeeded
- **Checkpointing:** `chrome.storage.local` is written after every step so the run survives Chrome killing the service worker (~5 min MV3 limit)
- **Idempotency:** before creating anything, check the a11y tree for the label — skip if already present

| Function | What it does |
|---|---|
| `createVisit` | Find add-visit → fill name → save → verify |
| `createForm` | Navigate to visit → add form → fill name + repeating flag → save → verify |
| `addField` | 7 ordered sub-steps as above; escalates on any unconfirmed save |
| `saveAndVerify` | Click save → re-perceive → Gemini checks result → retry once → escalate |
| `existsOnScreen` | A11y tree label check before creating — prevents duplicates |
| `runLoop` | Walks BuildStep[], triggers vocab discovery before first field, checkpoints every step |

---

## Human Escalation Gate

**Triggers:**
- Vocabulary mapping confidence < 0.8
- Save unconfirmed after 2 retries
- Verification fails (label/type mismatch after save)
- Skip logic target field not found in the same form

**Flow:**
1. Push `EscalationItem` to `runState.escalationQueue`
2. Background worker pauses execution
3. Side panel renders escalation card (screenshot + issue + best guess)
4. Human clicks Approve / Override / Skip → `RESOLVE_ESCALATION` message → background resumes

---

## Potential Breaks

| Break | Root cause | Current mitigation |
|---|---|---|
| Type picker is a multi-step modal | Platform hides types behind secondary dialog | Perception loop retries; Gemini detects intermediate state |
| Bulk-option import replaces existing options | Platform replaces instead of appends | Post-import screenshot check; re-add missing options |
| Range silently discarded after type change | Platform resets state on type edit | **Type always set first** |
| Skip logic target not found | Build order or label drift | Topological sort; mismatch → escalate |
| Form requires rebuild per visit | No shared-form support | Flat BuildPlan already rebuilds per visit |
| Service worker killed (MV3 ~5 min) | Chrome lifecycle | Checkpoint to storage after every step; resume on next activation |
| Gemini API rate limit (15 RPM) | 195 fields × ~3 calls | Exponential backoff; ~4s delay between calls |
| Save click swallowed | Network lag or unexpected confirmation dialog | 2-retry then escalate; never assume success |
| Claude debug hooks used at runtime | `__readState()` / `__exportState()` on mock only | Not used by agent — for manual developer spot-check only |

---

## Rate Limit Budget

195 fields × ~3 Gemini calls each = ~585 calls.  
At 15 RPM with ~4s spacing: ~585 / 15 = ~39 minutes for a full run.  
Free tier daily cap: 1,500 requests — one full run comfortably fits.

---

## What's Cut (vs. ideal)

| Feature | Status | Reason |
|---|---|---|
| Full read-back (re-navigate + verify options/range/skip) | Skipped | Time; post-save screenshot covers most cases |
| Live field-level progress tree | Skipped | Status counts in side panel are enough |
| Exportable audit report | Skipped | `chrome.storage` inspector for manual checks |
| Dry-run / preview mode | Skipped | Nice-to-have |
| Unit tests | Skipped | Manual spot-check via `__exportState()` |

---

## Verification Plan

1. Load unpacked from `dist/` in Chrome, set Gemini API key in options
2. Open eSource mock platform in a tab, open side panel, load input JSON, click Run
3. After run: in DevTools console, call `__exportState()` and diff against input JSON
4. Re-run the extension → confirm no duplicate visits/forms/fields (idempotency)
5. Record an unedited screen capture showing at least one escalation card
