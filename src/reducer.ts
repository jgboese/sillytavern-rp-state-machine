import type { Character, GameState, StateEvent } from './types';
import { localDateTime } from './schema';

export class StateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StateError';
  }
}
export const normalize = (value: string) =>
  value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLocaleLowerCase()
    .replace(/\s+/g, ' ');
export function normalizeConditions(values: string[]) {
  return [...new Set(values.map(normalize).filter(Boolean))].sort();
}
function named<
  T extends {
    id: string;
    name?: string;
    displayName?: string;
    aliases?: string[];
  },
>(map: Record<string, T>, reference: string): string | undefined {
  if (map[reference]) return reference;
  const wanted = normalize(reference);
  const matches = Object.values(map).filter(
    (v) =>
      normalize(v.id) === wanted ||
      normalize(v.name ?? v.displayName ?? '') === wanted ||
      (v.aliases ?? []).some((a) => normalize(a) === wanted),
  );
  if (matches.length === 1) return matches[0].id;
  if (matches.length > 1)
    throw new StateError(`Ambiguous reference: ${reference}`);
  return undefined;
}
function character(state: GameState, ref: string): Character {
  const id = named(state.characters, ref);
  if (!id) throw new StateError(`Unknown character: ${ref}`);
  return state.characters[id];
}
function asLocalDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new StateError(`Invalid local date/time: ${value}`);
  const [, y, mo, day, h, mi] = match;
  const d = new Date(
    Number(y),
    Number(mo) - 1,
    Number(day),
    Number(h),
    Number(mi),
  );
  if (
    d.getFullYear() !== Number(y) ||
    d.getMonth() !== Number(mo) - 1 ||
    d.getDate() !== Number(day) ||
    d.getHours() !== Number(h) ||
    d.getMinutes() !== Number(mi)
  )
    throw new StateError(`Invalid local date/time: ${value}`);
  return d;
}
function localFormat(d: Date) {
  const pad = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function date(value: string) {
  if (!localDateTime.safeParse(value).success)
    throw new StateError(`Invalid local date/time: ${value}`);
  asLocalDate(value);
}
function idFor(ref: string) {
  return (
    normalize(ref)
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '') || 'unnamed'
  );
}
function currency(state: GameState, ref: string, name?: string) {
  const existing = named(state.currencies, ref);
  const id = existing ?? idFor(ref);
  return state.currencies[id] ?? { id, name: name ?? ref, amount: 0 };
}
function item(state: GameState, ref: string, name?: string) {
  const existing = named(state.inventory, ref);
  const id = existing ?? idFor(ref);
  return state.inventory[id] ?? { id, name: name ?? ref, quantity: 0 };
}
export function applyEvent(state: GameState, event: StateEvent): GameState {
  switch (event.type) {
    case 'time.advance': {
      if (!Number.isInteger(event.minutes))
        throw new StateError('Minutes must be an integer');
      const d = asLocalDate(state.world.localDateTime);
      d.setMinutes(d.getMinutes() + event.minutes);
      return {
        ...state,
        world: { ...state.world, localDateTime: localFormat(d) },
      };
    }
    case 'time.set':
      date(event.localDateTime);
      return {
        ...state,
        world: { ...state.world, localDateTime: event.localDateTime },
      };
    case 'location.set':
      if (!event.location.trim()) throw new StateError('Location is required');
      return {
        ...state,
        world: { ...state.world, location: event.location.trim() },
      };
    case 'currency.adjust': {
      const x = currency(state, event.currency, event.name);
      if (!Number.isInteger(event.amount) || x.amount + event.amount < 0)
        throw new StateError(`Currency underflow: ${x.name}`);
      const updated = { ...x, amount: x.amount + event.amount };
      return {
        ...state,
        currencies: { ...state.currencies, [updated.id]: updated },
      };
    }
    case 'currency.set': {
      const x = currency(state, event.currency, event.name);
      if (!Number.isInteger(event.amount) || event.amount < 0)
        throw new StateError('Currency amount must be a non-negative integer');
      const updated = { ...x, amount: event.amount };
      return {
        ...state,
        currencies: { ...state.currencies, [updated.id]: updated },
      };
    }
    case 'inventory.add': {
      const x = item(state, event.item, event.name);
      if (!Number.isInteger(event.quantity) || event.quantity < 1)
        throw new StateError('Quantity must be positive');
      const updated = {
        ...x,
        quantity: x.quantity + event.quantity,
        ...(event.note === undefined ? {} : { note: event.note }),
      };
      return {
        ...state,
        inventory: { ...state.inventory, [updated.id]: updated },
      };
    }
    case 'inventory.remove': {
      const id = named(state.inventory, event.item);
      if (
        !id ||
        !Number.isInteger(event.quantity) ||
        event.quantity < 1 ||
        state.inventory[id].quantity < event.quantity
      )
        throw new StateError(`Inventory underflow: ${event.item}`);
      const quantity = state.inventory[id].quantity - event.quantity;
      const remaining = { ...state.inventory };
      delete remaining[id];
      return {
        ...state,
        inventory:
          quantity === 0
            ? remaining
            : { ...remaining, [id]: { ...state.inventory[id], quantity } },
      };
    }
    case 'inventory.set': {
      const x = item(state, event.item, event.name);
      if (!Number.isInteger(event.quantity) || event.quantity < 0)
        throw new StateError('Quantity must be non-negative');
      const remaining = { ...state.inventory };
      delete remaining[x.id];
      if (event.quantity === 0) return { ...state, inventory: remaining };
      const updated = {
        ...x,
        quantity: event.quantity,
        ...(event.note === undefined ? {} : { note: event.note }),
      };
      return { ...state, inventory: { ...remaining, [updated.id]: updated } };
    }
    case 'condition.add': {
      const conditions =
        event.target === 'player'
          ? state.player.conditions
          : character(state, event.target).conditions;
      const updated = normalizeConditions([...conditions, event.condition]);
      if (event.target === 'player')
        return { ...state, player: { conditions: updated } };
      const c = character(state, event.target);
      return {
        ...state,
        characters: {
          ...state.characters,
          [c.id]: { ...c, conditions: updated },
        },
      };
    }
    case 'condition.remove': {
      const conditions =
        event.target === 'player'
          ? state.player.conditions
          : character(state, event.target).conditions;
      const value = normalize(event.condition);
      const updated = conditions.filter((x) => normalize(x) !== value);
      if (event.target === 'player')
        return { ...state, player: { conditions: updated } };
      const c = character(state, event.target);
      return {
        ...state,
        characters: {
          ...state.characters,
          [c.id]: { ...c, conditions: updated },
        },
      };
    }
    case 'relationship.adjust': {
      const c = character(state, event.character);
      if (
        !Number.isInteger(event.amount) ||
        event.amount < -5 ||
        event.amount > 5 ||
        !event.reason.trim()
      )
        throw new StateError(
          'Relationship adjustment requires a -5..5 integer and reason',
        );
      const relationship = {
        ...c.relationship,
        score: Math.max(
          -100,
          Math.min(100, c.relationship.score + event.amount),
        ),
        lastReason: event.reason.trim(),
      };
      return {
        ...state,
        characters: { ...state.characters, [c.id]: { ...c, relationship } },
      };
    }
    case 'relationship.note': {
      const c = character(state, event.character);
      return {
        ...state,
        characters: {
          ...state.characters,
          [c.id]: {
            ...c,
            relationship: { ...c.relationship, note: event.note.trim() },
          },
        },
      };
    }
    case 'relationship.set': {
      const c = character(state, event.character);
      if (
        !Number.isInteger(event.score) ||
        event.score < -100 ||
        event.score > 100
      )
        throw new StateError('Relationship score must be -100..100');
      const relationship = {
        ...c.relationship,
        score: event.score,
        ...(event.note === undefined ? {} : { note: event.note }),
        ...(event.reason ? { lastReason: event.reason } : {}),
      };
      return {
        ...state,
        characters: { ...state.characters, [c.id]: { ...c, relationship } },
      };
    }
    case 'character.set': {
      const old = state.characters[event.id];
      const updated: Character = {
        id: event.id,
        displayName: event.displayName.trim(),
        aliases: [...new Set(event.aliases.map(normalize).filter(Boolean))],
        conditions: normalizeConditions(event.conditions),
        relationship: {
          score: event.relationshipScore ?? old?.relationship.score ?? 0,
          note: event.relationshipNote ?? old?.relationship.note,
          lastReason: old?.relationship.lastReason,
        },
      };
      return {
        ...state,
        characters: { ...state.characters, [updated.id]: updated },
      };
    }
  }
}
/** Applies all-or-nothing using immutable copy-on-write transitions. */
export function applyTransaction(
  state: GameState,
  events: StateEvent[],
): GameState {
  return events.reduce(applyEvent, state);
}
