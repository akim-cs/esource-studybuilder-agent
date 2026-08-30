// Vocabulary discovery — maps canonical types to platform-specific labels.
// Runs once per platform (keyed by hostname) and caches the result in storage.
// Low-confidence mappings (<0.8) are escalated to the human before any field is built.

import type { VocabularyMap, CanonicalType, EscalationItem } from './types'
import type { VocabEntry } from './gemini'

const CONFIDENCE_THRESHOLD = 0.8

// ── Storage ────────────────────────────────────────────────────────────────────

function storageKey(hostname: string): string {
  return `vocab_${hostname}`
}

export async function loadCachedVocabulary(hostname: string): Promise<VocabularyMap | null> {
  const key = storageKey(hostname)
  const result = await chrome.storage.local.get(key)
  return (result[key] as VocabularyMap) ?? null
}

export async function cacheVocabulary(hostname: string, map: VocabularyMap): Promise<void> {
  await chrome.storage.local.set({ [storageKey(hostname)]: map })
}

// ── Build map from Gemini entries ──────────────────────────────────────────────

export interface VocabDiscoveryResult {
  map: VocabularyMap
  escalations: EscalationItem[]   // low-confidence mappings queued for human review
  missing: CanonicalType[]        // canonical types not found on this platform at all
}

export function buildVocabularyResult(
  entries: VocabEntry[],
  screenshot: string,
): VocabDiscoveryResult {
  const map: Partial<VocabularyMap> = {}
  const escalations: EscalationItem[] = []
  const covered = new Set<CanonicalType>()

  for (const entry of entries) {
    const ct = entry.canonicalType as CanonicalType
    // If we see the same canonical type from multiple entries, keep the highest-confidence one
    const existing = map[ct]
    const existingEntry = entries.find((e) => e.platformLabel === existing)
    if (existing && existingEntry && existingEntry.confidence >= entry.confidence) continue

    map[ct] = entry.platformLabel
    covered.add(ct)

    if (entry.confidence < CONFIDENCE_THRESHOLD) {
      escalations.push({
        id: `vocab_${ct}`,
        stepId: `vocab_${ct}`,
        inputRef: `vocabulary.${ct}`,
        issue: `Type mapping uncertain — "${entry.platformLabel}" mapped to "${ct}" with ${Math.round(entry.confidence * 100)}% confidence. ${entry.reasoning}`,
        screenshot,
        bestGuess: entry.platformLabel,
        confidence: entry.confidence,
      })
    }
  }

  const ALL_CANONICAL: CanonicalType[] = [
    'text', 'textarea', 'integer', 'decimal',
    'date', 'time', 'datetime', 'boolean',
    'single_select', 'multi_select', 'radio', 'checkbox', 'calculated',
  ]
  const missing = ALL_CANONICAL.filter((ct) => !covered.has(ct))

  return {
    map: map as VocabularyMap,
    escalations,
    missing,
  }
}

// ── Apply human resolution to vocabulary map ───────────────────────────────────
// Called when a vocab escalation is resolved with 'override'.

export function applyVocabOverride(
  map: VocabularyMap,
  canonicalType: CanonicalType,
  overrideValue: string,
): VocabularyMap {
  return { ...map, [canonicalType]: overrideValue }
}
