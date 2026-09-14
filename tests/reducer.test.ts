import { describe, expect, it } from 'vitest';
import {
  applyTransaction,
  normalizeConditions,
  StateError,
} from '../src/reducer';
import { emptyState } from '../src/persistence';
import { gameStateSchema, localDateTime } from '../src/schema';

const base = () => ({
  ...emptyState('2026-01-31T23:50', 'Inn'),
  currencies: { gold: { id: 'gold', name: 'Gold', amount: 10 } },
  inventory: { rope: { id: 'rope', name: 'Rope', quantity: 2 } },
  characters: {
    mira: {
      id: 'mira',
      displayName: 'Mira',
      aliases: ['Captain'],
      conditions: [],
      relationship: { score: 99 },
    },
  },
});
describe('reducer', () => {
  it('rolls time over month boundaries', () =>
    expect(
      applyTransaction(base(), [{ type: 'time.advance', minutes: 20 }]).world
        .localDateTime,
    ).toBe('2026-02-01T00:10'));
  it('rejects impossible Gregorian local dates before state is persisted', () =>
    expect(localDateTime.safeParse('2026-02-31T10:00').success).toBe(false));
  it('normalizes and deduplicates conditions', () =>
    expect(normalizeConditions([' Tired ', 'tired', 'Injured'])).toEqual([
      'injured',
      'tired',
    ]));
  it('rejects currency and inventory underflow atomically', () => {
    const state = base();
    expect(() =>
      applyTransaction(state, [
        { type: 'currency.adjust', currency: 'gold', amount: -11 },
      ]),
    ).toThrow(StateError);
    expect(() =>
      applyTransaction(state, [
        { type: 'location.set', location: 'Road' },
        { type: 'inventory.remove', item: 'rope', quantity: 3 },
      ]),
    ).toThrow();
    expect(state.world.location).toBe('Inn');
  });
  it('resolves aliases and clamps relationship bounds', () =>
    expect(
      applyTransaction(base(), [
        {
          type: 'relationship.adjust',
          character: 'captain',
          amount: 5,
          reason: 'Rescue',
        },
      ]).characters.mira.relationship.score,
    ).toBe(100));
  it('rejects non-conservative relationship deltas', () =>
    expect(() =>
      applyTransaction(base(), [
        {
          type: 'relationship.adjust',
          character: 'mira',
          amount: 6,
          reason: 'No',
        },
      ]),
    ).toThrow());
  it('supports manual absolute set events', () => {
    const state = applyTransaction(base(), [
      { type: 'inventory.set', item: 'rope', quantity: 9 },
      { type: 'currency.set', currency: 'gold', amount: 3 },
    ]);
    expect(state.inventory.rope.quantity).toBe(9);
    expect(state.currencies.gold.amount).toBe(3);
  });
  it('handles every remaining supported event deterministically', () => {
    const state = applyTransaction(base(), [
      { type: 'time.set', localDateTime: '2026-02-01T10:00' },
      { type: 'location.set', location: 'Road' },
      { type: 'currency.adjust', currency: 'gold', amount: -2 },
      { type: 'inventory.add', item: 'rope', quantity: 1 },
      { type: 'condition.add', target: 'player', condition: 'Tired' },
      { type: 'condition.remove', target: 'player', condition: 'tired' },
      { type: 'condition.add', target: 'mira', condition: 'Wet' },
      { type: 'condition.remove', target: 'mira', condition: 'wet' },
      { type: 'relationship.note', character: 'mira', note: 'Trusting' },
      {
        type: 'relationship.set',
        character: 'mira',
        score: -2,
        note: 'Uneasy',
      },
      {
        type: 'character.set',
        id: 'new',
        displayName: 'New',
        aliases: ['N'],
        conditions: ['Fine'],
      },
    ]);
    expect(state.world.location).toBe('Road');
    expect(state.currencies.gold.amount).toBe(8);
    expect(state.inventory.rope.quantity).toBe(3);
    expect(state.characters.mira.relationship.score).toBe(-2);
    expect(state.characters.new.aliases).toEqual(['n']);
  });
  it('rejects ambiguous aliases', () => {
    const state = base() as ReturnType<typeof base> & {
      characters: Record<string, any>;
    };
    state.characters.other = {
      id: 'other',
      displayName: 'Other',
      aliases: ['Captain'],
      conditions: [],
      relationship: { score: 0 },
    };
    expect(() =>
      applyTransaction(state, [
        { type: 'relationship.note', character: 'Captain', note: 'x' },
      ]),
    ).toThrow(/Ambiguous/);
  });
  it('rejects record keys that do not match stable entity IDs', () => {
    const state = base();
    state.inventory.rope.id = 'different';
    expect(gameStateSchema.safeParse(state).success).toBe(false);
  });
});
