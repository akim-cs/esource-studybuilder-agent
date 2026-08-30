// Gemini 2.0 Flash API wrapper — all LLM calls go through here.
// Swap model name here if Google updates the free tier offering.

import { GoogleGenAI, type GenerateContentResponse } from '@google/genai'

const MODEL = 'gemini-2.0-flash'

let ai: GoogleGenAI | null = null

export function initGemini(apiKey: string): void {
  ai = new GoogleGenAI({ apiKey })
}

function client(): GoogleGenAI {
  if (!ai) throw new Error('Gemini not initialized — configure API key in extension options')
  return ai
}

export interface GeminiImagePart {
  inlineData: { data: string; mimeType: string }
}

// Low-level call: text + optional image parts → raw response text
export async function callGemini(
  systemPrompt: string,
  userText: string,
  imageParts: GeminiImagePart[] = [],
): Promise<string> {
  const model = client().models
  const contents = [
    { role: 'user', parts: [...imageParts, { text: userText }] },
  ]
  const response: GenerateContentResponse = await model.generateContent({
    model: MODEL,
    systemInstruction: systemPrompt,
    contents,
  })
  return response.text ?? ''
}

// Convenience: call Gemini and parse the response as JSON.
// Throws if parsing fails — caller should handle.
export async function callGeminiJSON<T>(
  systemPrompt: string,
  userText: string,
  imageParts: GeminiImagePart[] = [],
): Promise<T> {
  const raw = await callGemini(systemPrompt, userText, imageParts)
  const cleaned = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim()
  return JSON.parse(cleaned) as T
}

// Convert a base64 data URL (data:image/png;base64,...) into a GeminiImagePart
export function dataUrlToImagePart(dataUrl: string): GeminiImagePart {
  const [header, data] = dataUrl.split(',')
  const mimeType = header.replace('data:', '').replace(';base64', '')
  return { inlineData: { data, mimeType } }
}
