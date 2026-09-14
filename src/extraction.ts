import {
  extractionSchema,
  EXTRACTION_JSON_SCHEMA,
  type Extraction,
} from './schema';
import type { GameState, StateTransaction } from './types';
import { applyTransaction } from './reducer';
import {
  StateAgentConfigurationError,
  StateAgentTransportError,
  type StateAgent,
  type StateAgentRequest,
} from './state-agent';
export class ExtractionError extends Error {
  constructor(
    message: string,
    readonly raw?: string,
  ) {
    super(message);
  }
}
const safeRaw = (value: unknown) =>
  (typeof value === 'string' ? value : (JSON.stringify(value) ?? '')).slice(
    0,
    4000,
  );
const allowed =
  'time.advance, time.set, location.set, currency.adjust, inventory.add, inventory.remove, condition.add, condition.remove, relationship.adjust, relationship.note';
export function extractionPrompt(
  state: GameState,
  turn: {
    user?: string;
    userSpeaker?: string;
    assistant: string;
    assistantSpeaker?: string;
  },
) {
  return `Extract only explicit, durable changes from this RP turn. Return JSON only matching the supplied schema. Allowed event types: ${allowed}. Relationship adjustment must be -5..5 and include a concrete reason. Do not invent facts.\nCURRENT STATE:\n${JSON.stringify(state)}\nUSER TURN (${turn.userSpeaker ?? 'User'}):\n${turn.user ?? ''}\nASSISTANT TURN (${turn.assistantSpeaker ?? 'Assistant'}):\n${turn.assistant}`;
}
export function parseExtraction(value: unknown): Extraction {
  const parsed =
    typeof value === 'string'
      ? (() => {
          const cleaned = value
            .trim()
            .replace(/^```(?:json)?\s*/i, '')
            .replace(/\s*```$/, '');
          try {
            return JSON.parse(cleaned);
          } catch {
            return value;
          }
        })()
      : value;
  if (parsed && typeof parsed === 'object' && Object.keys(parsed).length === 0)
    throw new Error('Extractor returned an empty object');
  const result = extractionSchema.safeParse(parsed);
  if (!result.success)
    throw new Error(
      result.error.issues
        .map((x) => `${x.path.join('.')}: ${x.message}`)
        .join('; '),
    );
  if (
    result.data.events.some(
      (x) =>
        x.type === 'currency.set' ||
        x.type === 'inventory.set' ||
        x.type === 'relationship.set' ||
        x.type === 'character.set',
    )
  )
    throw new Error('Absolute set events are reserved for manual edits');
  return result.data;
}
export async function extract(
  agent: StateAgent,
  state: GameState,
  turn: {
    user?: string;
    userSpeaker?: string;
    assistant: string;
    assistantSpeaker?: string;
  },
  options: { maxTokens: number; signal?: AbortSignal },
): Promise<Extraction> {
  const prompt = extractionPrompt(state, turn);
  const firstRequest: StateAgentRequest = {
    prompt,
    systemPrompt: 'You are a precise RP state extractor.',
    jsonSchema: EXTRACTION_JSON_SCHEMA,
    maxTokens: options.maxTokens,
    signal: options.signal,
  };
  let firstRaw: unknown;
  let receivedFirstResponse = false;
  try {
    firstRaw = await agent.generate(firstRequest);
    receivedFirstResponse = true;
    return parseExtraction(firstRaw);
  } catch (error) {
    if (
      error instanceof StateAgentConfigurationError ||
      error instanceof StateAgentTransportError ||
      options.signal?.aborted ||
      (error instanceof DOMException && error.name === 'AbortError')
    )
      throw error;
    // A rejected request is a provider failure; only a received malformed
    // response gets a JSON-only retry.
    if (!receivedFirstResponse) throw error;
  }
  const fallbackRequest: StateAgentRequest = {
    prompt: `${prompt}\nJSON ONLY. No markdown or prose.`,
    systemPrompt: 'Return exactly one JSON object.',
    maxTokens: options.maxTokens,
    signal: options.signal,
  };
  let fallbackRaw: unknown;
  let receivedFallbackResponse = false;
  try {
    fallbackRaw = await agent.generate(fallbackRequest);
    receivedFallbackResponse = true;
    return parseExtraction(fallbackRaw);
  } catch (error) {
    if (
      error instanceof StateAgentConfigurationError ||
      error instanceof StateAgentTransportError ||
      options.signal?.aborted ||
      (error instanceof DOMException && error.name === 'AbortError')
    )
      throw error;
    if (!receivedFallbackResponse) throw error;
    throw new ExtractionError(
      `Structured extraction failed; fallback failed: ${String(error)}`,
      `${safeRaw(firstRaw)}\n--- fallback ---\n${safeRaw(fallbackRaw)}`,
    );
  }
}
export function automaticTransaction(
  extraction: Extraction,
  sourceFingerprint: string,
  sourceOrdinal: number,
  swipeId: string,
): StateTransaction {
  return {
    id: crypto.randomUUID(),
    origin: 'automatic',
    sourceFingerprint,
    sourceOrdinal,
    sourceSwipeId: swipeId,
    events: extraction.events,
    timestamp: new Date().toISOString(),
    explanation: extraction.explanation,
  };
}
export function validateExtraction(state: GameState, extraction: Extraction) {
  return applyTransaction(state, extraction.events);
}
