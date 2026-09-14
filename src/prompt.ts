import type { GameState } from './types';
import { normalize } from './reducer';
function ordered<T extends { id: string }>(values: Record<string, T>) { return Object.values(values).sort((a, b) => a.id.localeCompare(b.id)); }
export function compactState(state: GameState, truncated = false): string {
  const lines = [`RP STATE — authoritative. Do not narrate this block.`, `Time: ${state.world.localDateTime}`, `Location: ${state.world.location}`];
  if (Object.keys(state.currencies).length) lines.push(`Currencies: ${ordered(state.currencies).map(x => `${x.name}=${x.amount}`).join(', ')}`);
  if (state.player.conditions.length) lines.push(`Player conditions: ${state.player.conditions.join(', ')}`);
  if (!truncated && Object.keys(state.inventory).length) lines.push(`Inventory: ${ordered(state.inventory).map(x => `${x.name}×${x.quantity}${x.note ? ` (${x.note})` : ''}`).join('; ')}`);
  if (!truncated && Object.keys(state.characters).length) lines.push(`Characters: ${ordered(state.characters).map(x => `${x.displayName}[rel:${x.relationship.score}${x.relationship.note ? `; ${x.relationship.note}` : ''}${x.conditions.length ? `; ${x.conditions.join(',')}` : ''}]`).join('; ')}`);
  if (truncated) lines.push('[State snapshot truncated: inventory and character detail omitted.]');
  return lines.join('\n');
}
export async function renderPrompt(state: GameState, ceiling: number, countTokens: (text: string) => Promise<number>, recentIds: string[] = []): Promise<string> {
  const full = compactState(state); if (await countTokens(full) <= ceiling) return full;
  const marker = '[State snapshot truncated: further detail omitted.]';
  const core = compactState(state, true).replace('\n[State snapshot truncated: inventory and character detail omitted.]', '');
  const recent = recentIds.map(normalize); const rank = (...refs: string[]) => { const positions = refs.map(normalize).map(x => recent.indexOf(x)).filter(x => x >= 0); return positions.length ? Math.min(...positions) : Number.MAX_SAFE_INTEGER; };
  const details = [...Object.values(state.inventory).sort((a, b) => rank(a.id, a.name) - rank(b.id, b.name) || a.id.localeCompare(b.id)).map(x => `Inventory: ${x.name}×${x.quantity}${x.note ? ` (${x.note})` : ''}`), ...Object.values(state.characters).sort((a, b) => rank(a.id, a.displayName, ...a.aliases) - rank(b.id, b.displayName, ...b.aliases) || a.id.localeCompare(b.id)).map(x => `Character: ${x.displayName}[rel:${x.relationship.score}${x.relationship.note ? `; ${x.relationship.note}` : ''}${x.conditions.length ? `; ${x.conditions.join(',')}` : ''}]`)];
  const appendDetails = async (index: number, current: string): Promise<string> => { if (index >= details.length) return current; const candidate = `${current}\n${details[index]}\n${marker}`; return appendDetails(index + 1, await countTokens(candidate) <= ceiling ? `${current}\n${details[index]}` : current); };
  const compact = `${await appendDetails(0, core)}\n${marker}`; if (await countTokens(compact) <= ceiling) return compact;
  // Providers may report a tiny ceiling. Retain the explicit marker and then
  // deterministically trim from the end until the tokenizer confirms the cap.
  const priority = '[State snapshot truncated]\n' + core.split('\n').slice(1, 3).join('\n');
  const fittingPrefix = async (low: number, high: number): Promise<number> => { if (low >= high) return low; const middle = Math.ceil((low + high) / 2); return await countTokens(priority.slice(0, middle)) <= ceiling ? fittingPrefix(middle, high) : fittingPrefix(low, middle - 1); };
  return priority.slice(0, await fittingPrefix(0, priority.length));
}
