import type { GameState, Preferences, RpStateContainer } from './types';
import { DEFAULT_PREFERENCES } from './types';
import { containerSchema } from './schema';
export const METADATA_KEY = 'rp_state_machine';
export const SETTINGS_KEY = 'rp_state_machine';
export function emptyState(localDateTime: string, location: string): GameState { return { world: { localDateTime, location }, player: { conditions: [] }, currencies: {}, inventory: {}, characters: {} }; }
export function seedContainer(baseState: GameState, prefix: string, messageCount: number): RpStateContainer { return { schemaVersion: 1, status: 'ready', seed: { baseState, chatPrefixFingerprint: prefix, messageCount }, currentState: structuredClone(baseState), messages: [], transactions: [], reviewQueue: [] }; }
export function getContainer(context: { chatMetadata: Record<string, unknown> }): RpStateContainer | undefined { const value = context.chatMetadata[METADATA_KEY]; const parsed = containerSchema.safeParse(value); return parsed.success ? parsed.data as RpStateContainer : undefined; }
export function putContainer(context: { chatMetadata: Record<string, unknown> }, container: RpStateContainer) { context.chatMetadata[METADATA_KEY] = container; }
export function preferences(context: { extensionSettings: Record<string, unknown> }): Preferences { const settings = (context.extensionSettings[SETTINGS_KEY] ?? {}) as Partial<Preferences>; return { ...DEFAULT_PREFERENCES, ...settings }; }
export function setPreferences(context: { extensionSettings: Record<string, unknown> }, next: Preferences) { context.extensionSettings[SETTINGS_KEY] = next; }
