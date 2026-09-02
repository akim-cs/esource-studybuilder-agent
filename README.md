# eSource StudyBuilder Agent

A Chrome extension that autonomously builds clinical trial study structures in eSource web platforms from a JSON specification file. Driven by Gemini 3.6 Flash (vision + reasoning) — no hardcoded UI selectors.

## Setup

### 1. Get a Gemini API key (free)
Visit [aistudio.google.com](https://aistudio.google.com), sign in, and create an API key. No billing required.

### 2. Install and build
```bash
npm install
npm run build
```

### 3. Load the extension in Chrome
1. Go to `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** → select the `dist/` folder

### 4. Configure the API key
Click the extension icon → **Options** → paste your Gemini API key → **Save**

### 5. Run
1. Open your eSource platform in a Chrome tab
2. Click the extension icon → **Open side panel**
3. Click **Load JSON & Run** → select your study IR JSON file
4. Monitor progress in the side panel; resolve any escalations that appear

---

## Architecture

```
[ Side Panel UI ]
   ↕ chrome.runtime messages
[ Background Service Worker ]  ← orchestrates build plan, calls Gemini API
   ↕ chrome.tabs / chrome.scripting
[ Content Script ]             ← injected into eSource tab
   ├── captures accessibility tree
   ├── performs clicks / typing / selections
   └── confirms interactions
       ↓
[ eSource Web App ]
```

All state (build plan, vocabulary cache, traceability log) is persisted in `chrome.storage.local` — the run survives page reloads and service worker restarts.

---

## How it generalizes across platforms

The agent never uses CSS selectors, element IDs, or hardcoded button labels. Instead:

1. **Perception** — screenshots the active tab and extracts the accessibility tree; sends both to Gemini Vision to understand what's on screen
2. **Vocabulary discovery** — navigates to the field-type picker once per platform; Gemini semantically maps each option to one of the 13 canonical field types (done once, cached)
3. **Action targeting** — Gemini identifies which control to interact with by label and role; the content script finds it via accessible name matching (not selectors)

---

## Input file format

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

### Canonical field types
`text` · `textarea` · `integer` · `decimal` · `date` · `time` · `datetime` · `boolean` · `single_select` · `multi_select` · `radio` · `checkbox` · `calculated`

---

## Human escalation

The agent pauses and shows a review card in the side panel when:
- A type mapping confidence is below 80%
- A save action cannot be confirmed after 2 retries
- A skip logic target field cannot be found

The reviewer sees the screenshot, the issue, and the agent's best guess, then can approve, override, or skip.

---

## Known limitations

See [DESIGN.md](DESIGN.md#potential-breaks) for the full failure mode log.

Key limitations in the current 2-day build:
- Lightweight post-save verification (not full re-navigation read-back)
- No exportable audit report (use `chrome.storage` inspector for manual checks)
- No dry-run / preview mode

---

## Development

```bash
npm run build      # full build (HTML pages + scripts)
npm run dev        # watch mode
npm run typecheck  # TypeScript check without building
```

Build output goes to `dist/`. Load `dist/` as an unpacked extension.
