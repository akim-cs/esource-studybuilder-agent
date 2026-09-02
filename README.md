# eSource StudyBuilder Agent

A Chrome extension that builds clinical trial study structures (visits → forms → fields) in eSource web platforms from a JSON spec. It perceives the page with Gemini 3.6 Flash (vision + accessibility tree) and targets controls by accessible name — no hardcoded selectors — so it works on platforms it has never seen.

**Demo:** <!-- TODO: link 2–3 min screen recording of an end-to-end run incl. the human gate -->

---

## Setup

1. **API key** — create one free at [aistudio.google.com](https://aistudio.google.com) (no billing required)
2. **Build** — `npm install && npm run build`
3. **Load** — `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select `dist/`
4. **Configure** — right-click the extension icon → **Options** → paste your key → **Save**
5. **Run** — open the eSource platform tab, open the side panel (right-click icon → **Open side panel**), then **Load JSON & Run**
6. Watch progress in the side panel; resolve any review cards that appear

---

## Architecture

```
[ Side panel (React) ]                → escalation cards, live status, log export
        ↕ chrome.runtime messages
[ Background service worker ]         → build plan, Gemini calls, run state
        ↕ chrome.tabs / chrome.scripting
[ Content script ]                    → reads the page, performs interactions
        ↓
[ eSource web app — any platform ]
```

Every step runs a **perceive → decide → act → confirm** loop:

- **Perceive** — capture a screenshot of the tab and extract the accessibility tree (interactive elements with label, role, position) from the live DOM; send both to Gemini
- **Decide** — one Gemini call plans the complete action sequence for the step (clicks, typing, selections)
- **Act** — the content script locates each control by accessible name + role (never CSS selectors) and performs the interaction
- **Confirm** — a fresh screenshot goes back to Gemini: "did this work?" A save is never assumed to have succeeded

State checkpoints to `chrome.storage.local` after every step, so a run survives service-worker restarts and page reloads, and can pause/resume and retry failed steps.

---

## Mapping canonical types to an unknown platform

The input JSON uses 13 canonical types (`integer`, `single_select`, …); every platform labels them differently ("Whole Number", "Coded Pick List", "Tick Box"). Once per platform — cached by hostname in `chrome.storage.local`:

1. The agent navigates into a form builder so the element library is visible
2. Gemini reads every type tile and maps each to a canonical type, with a confidence score and reasoning
3. Mappings under 80% confidence are queued for human review **before any field is created**
4. Human overrides update the map immediately and apply to all remaining fields in the run

This generalises because the mapping is semantic, not string matching — Gemini reasons about what each platform label *means*.

---

## Human gate

The agent pauses and shows a review card in the side panel when:

- A type-mapping confidence is below 80%
- A create/save cannot be confirmed by post-action verification
- Gemini returns no usable action plan for a step
- A skip-logic target field can't be found, or fields form a dependency cycle

The reviewer sees the **screenshot**, a plain-language **issue**, and the agent's **best guess with confidence**, then chooses **Approve**, **Override** (enter a replacement value), or **Skip**. The run resumes automatically once all pending cards are resolved.

---

## Does it generalise?

Design choices that keep it platform-agnostic:

- Click targets come from the live a11y tree (accessible name + role), not selectors, IDs, or coordinates — survives DOM restructures, relabelled buttons, moved layouts
- The type vocabulary is discovered at runtime (above), not hardcoded
- Fields are built in topological order so skip-logic targets always exist first
- Idempotency: before creating anything, the agent checks the page for an existing label — re-runs never duplicate

**Evidence:**

<!-- TODO: fill in honestly before submitting -->
- _Supplied mock:_ by-hand verification results — see checklist below
- _Modified / second mock:_ rename element library entries, move Save, reorder screens, swap a dropdown for radio, restructure the DOM (or a second mock of your own) — run the extension unchanged and record what % built correctly

### Verifying by hand

1. Run the extension end to end on the mock
2. In DevTools console on the mock, call `__readState()` / `__exportState()` to dump the saved study as JSON
3. Diff against the input file: every form present, every field present, every type correct, every coded value list complete with codes **and** labels, every range and unit, every skip-logic rule, the right forms marked repeating

<!-- TODO: paste summary of the diff results here -->

---

## Where it breaks

Known failure modes (full log in [DESIGN.md](DESIGN.md#potential-breaks)) and what the agent does about each:

| Break | What the agent does |
|---|---|
| Type picker hidden behind a multi-step modal | Perception loop retries; Gemini detects the intermediate state |
| Range/options silently wiped when the type changes | **Type is always set first**, before options/ranges |
| A save click gets swallowed (lag, unexpected dialog) | Re-perceive and verify; retry, then escalate — never assumes success |
| Skip-logic target missing or cyclic | Escalates with a card explaining the cycle |
| Service worker killed by Chrome (MV3) | Resumes from the per-step checkpoint in storage |
| Gemini rate limit (free tier, 15 RPM) | 4.5 s spacing between calls + exponential backoff on 429/503 |
| Unmapped field type / unrecognised screen | Stops and asks the human rather than guessing |

---

## How long a run takes

<!-- TODO: replace with the measured time from your recorded run -->
Designed budget: a full sample-study run (195 fields ≈ 585 Gemini calls) takes roughly **40 minutes**, driven almost entirely by the free-tier 15 requests/minute limit (4.5 s spacing between calls). The daily free-tier cap (1,500 requests) fits one full run comfortably.

---

## What's next (given two more weeks)

- **Full read-back verification** — re-navigate after each field and diff options/ranges/skip rules, not just save confirmation
- **Dry-run mode** — plan the whole study and show the action list without touching the platform
- **Generalisation test matrix** — scripted runs against several platform variants, with pass/fail reporting per study element
- **Live field-level progress tree** in the side panel
- **Exportable audit report** (beyond the current trace-log export)

---

## AI tools used

<!-- TODO: fill in — which tools (e.g. ChatGPT/Claude/Copilot/Matilda), for what parts, where they helped and where they got in the way -->

---

## Reference

### Input file format

```json
{
  "ir_version": "1.0",
  "study": { "protocol_id": "...", "title": "..." },
  "visits": [{
    "name": "Screening",
    "window_start_day": -7,
    "window_end_day": 0,
    "forms": [{
      "name": "Vital Signs",
      "repeating": false,
      "fields": [{
        "label": "Systolic BP",
        "type": "integer",
        "required": true,
        "min": 60,
        "max": 200,
        "units": "mmHg"
      }]
    }]
  }]
}
```

**Canonical field types:** `text` · `textarea` · `integer` · `decimal` · `date` · `time` · `datetime` · `boolean` · `single_select` · `multi_select` · `radio` · `checkbox` · `calculated`

### Development

```bash
npm run build      # full build (HTML pages + scripts)
npm run dev        # watch mode
npm run typecheck  # TypeScript check without building
```

Build output goes to `dist/`; load it as an unpacked extension. See [DESIGN.md](DESIGN.md) for the full design rationale.
