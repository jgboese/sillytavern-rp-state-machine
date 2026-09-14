import { extractionSchema, EXTRACTION_JSON_SCHEMA, type Extraction } from './schema';
import type { GameState, StateTransaction } from './types';
import { applyTransaction } from './reducer';
export interface RawGenerator { generateRaw(options: Record<string, unknown>): Promise<unknown> }
export class ExtractionError extends Error { constructor(message: string, readonly raw?: string) { super(message); } }
const safeRaw = (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value) ?? '').slice(0, 4000);
type Attempt = { ok: true; value: Extraction; raw: unknown } | { ok: false; error: unknown; raw: unknown };
async function attempt(generator: RawGenerator, options: Record<string, unknown>): Promise<Attempt> {
  try { const raw = await generator.generateRaw(options); try { return { ok: true, value: parseExtraction(raw), raw }; } catch (error) { return { ok: false, error, raw }; } }
  catch (error) { return { ok: false, error, raw: undefined }; }
}
const allowed = 'time.advance, time.set, location.set, currency.adjust, inventory.add, inventory.remove, condition.add, condition.remove, relationship.adjust, relationship.note';
export function extractionPrompt(state: GameState, turn: { user?: string; userSpeaker?: string; assistant: string; assistantSpeaker?: string }) { return `Extract only explicit, durable changes from this RP turn. Return JSON only matching the supplied schema. Allowed event types: ${allowed}. Relationship adjustment must be -5..5 and include a concrete reason. Do not invent facts.\nCURRENT STATE:\n${JSON.stringify(state)}\nUSER TURN (${turn.userSpeaker ?? 'User'}):\n${turn.user ?? ''}\nASSISTANT TURN (${turn.assistantSpeaker ?? 'Assistant'}):\n${turn.assistant}`; }
export function parseExtraction(value: unknown): Extraction {
  const parsed = typeof value === 'string' ? (() => { const cleaned = value.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''); try { return JSON.parse(cleaned); } catch { return value; } })() : value;
  if (parsed && typeof parsed === 'object' && Object.keys(parsed).length === 0) throw new Error('Extractor returned an empty object');
  const result = extractionSchema.safeParse(parsed); if (!result.success) throw new Error(result.error.issues.map(x => `${x.path.join('.')}: ${x.message}`).join('; '));
  if (result.data.events.some(x => x.type === 'currency.set' || x.type === 'inventory.set' || x.type === 'relationship.set' || x.type === 'character.set')) throw new Error('Absolute set events are reserved for manual edits');
  return result.data;
}
export async function extract(generator: RawGenerator, state: GameState, turn: { user?: string; userSpeaker?: string; assistant: string; assistantSpeaker?: string }): Promise<Extraction> {
  const prompt = extractionPrompt(state, turn);
  const first = await attempt(generator, { prompt, systemPrompt: 'You are a precise RP state extractor.', jsonSchema: EXTRACTION_JSON_SCHEMA, responseLength: 512 });
  if (first.ok) return first.value;
  const second = await attempt(generator, { prompt: `${prompt}\nJSON ONLY. No markdown or prose.`, systemPrompt: 'Return exactly one JSON object.', responseLength: 512 });
  if (second.ok) return second.value;
  throw new ExtractionError(`Structured extraction failed: ${String(first.error)}; fallback failed: ${String(second.error)}`, `${safeRaw(first.raw)}\n--- fallback ---\n${safeRaw(second.raw)}`);
}
export function automaticTransaction(extraction: Extraction, sourceFingerprint: string, sourceOrdinal: number, swipeId: string): StateTransaction { return { id: crypto.randomUUID(), origin: 'automatic', sourceFingerprint, sourceOrdinal, sourceSwipeId: swipeId, events: extraction.events, timestamp: new Date().toISOString(), explanation: extraction.explanation }; }
export function validateExtraction(state: GameState, extraction: Extraction) { return applyTransaction(state, extraction.events); }
