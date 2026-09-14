export type Origin = 'automatic' | 'manual';
export type Status = 'ready' | 'extracting' | 'replaying' | 'needs-reseed' | 'error';

export interface Entity { id: string; name: string; amount?: number; quantity?: number; note?: string }
export interface Character {
  id: string; displayName: string; aliases: string[]; conditions: string[];
  relationship: { score: number; note?: string; lastReason?: string };
}
export interface GameState {
  world: { localDateTime: string; location: string };
  player: { conditions: string[] };
  currencies: Record<string, Required<Pick<Entity, 'id' | 'name' | 'amount'>>>;
  inventory: Record<string, Required<Pick<Entity, 'id' | 'name' | 'quantity'>> & { note?: string }>;
  characters: Record<string, Character>;
}
export interface MessageFingerprint {
  fingerprint: string; role: 'user' | 'assistant' | 'system'; speaker: string;
  swipeId: string; ordinal: number; isAssistant: boolean;
}
export type StateEvent =
 | { type: 'time.advance'; minutes: number }
 | { type: 'time.set'; localDateTime: string }
 | { type: 'location.set'; location: string }
 | { type: 'currency.adjust'; currency: string; amount: number; name?: string }
 | { type: 'currency.set'; currency: string; amount: number; name?: string }
 | { type: 'inventory.add'; item: string; quantity: number; name?: string; note?: string }
 | { type: 'inventory.remove'; item: string; quantity: number }
 | { type: 'inventory.set'; item: string; quantity: number; name?: string; note?: string }
 | { type: 'condition.add'; target: 'player' | string; condition: string }
 | { type: 'condition.remove'; target: 'player' | string; condition: string }
 | { type: 'relationship.adjust'; character: string; amount: number; reason: string }
 | { type: 'relationship.note'; character: string; note: string }
 | { type: 'relationship.set'; character: string; score: number; note?: string; reason?: string }
 | { type: 'character.set'; id: string; displayName: string; aliases: string[]; conditions: string[]; relationshipScore?: number; relationshipNote?: string };
export interface StateTransaction {
  id: string; origin: Origin; sourceFingerprint?: string; sourceOrdinal?: number;
  sourceSwipeId?: string; events: StateEvent[]; timestamp: string; explanation: string;
}
export interface ReviewItem {
  id: string; kind: 'extraction' | 'semantic' | 'manual' | 'replay'; message: string;
  raw?: string; transaction?: StateTransaction; sourceFingerprint?: string; createdAt: string;
}
export interface RpStateContainer {
  schemaVersion: 1; status: Status;
  seed: { baseState: GameState; chatPrefixFingerprint: string; messageCount: number };
  currentState: GameState; messages: MessageFingerprint[]; transactions: StateTransaction[];
  reviewQueue: ReviewItem[];
}
export interface Preferences { paused: boolean; injectionEnabled: boolean; tokenCeiling: number; debug: boolean }
export const DEFAULT_PREFERENCES: Preferences = { paused: false, injectionEnabled: true, tokenCeiling: 1500, debug: false };
