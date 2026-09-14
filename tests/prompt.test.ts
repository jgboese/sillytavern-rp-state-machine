import { describe, expect, it } from 'vitest';
import { compactState, renderPrompt } from '../src/prompt';
import { emptyState } from '../src/persistence';
describe('prompt snapshot', () => {
  it('formats authoritative core state', () => {
    const state = emptyState('2026-01-01T00:00', 'Inn');
    state.currencies.gold = { id: 'gold', name: 'Gold', amount: 3 };
    expect(compactState(state)).toContain('Gold=3');
  });
  it('uses deterministic core-first truncation', async () => {
    const state = emptyState('2026-01-01T00:00', 'Inn');
    state.inventory.a = { id: 'a', name: 'Anvil', quantity: 1 };
    const prompt = await renderPrompt(state, 1, async (x) =>
      x.includes('Anvil') ? 2 : 1,
    );
    expect(prompt).toContain('truncated');
    expect(prompt).not.toContain('Anvil');
  });
  it('enforces the ceiling even when the priority-only snapshot is too long', async () => {
    const state = emptyState('2026-01-01T00:00', 'A very long location name');
    const prompt = await renderPrompt(state, 5, async (x) => x.length);
    expect(prompt.length).toBeLessThanOrEqual(5);
  });
  it('prefers recently changed entities resolved by normalized name or alias', async () => {
    const state = emptyState('2026-01-01T00:00', 'Inn');
    state.inventory.old = { id: 'old', name: 'Old Rope', quantity: 1 };
    state.inventory.new = { id: 'new', name: 'Silver Key', quantity: 1 };
    const prompt = await renderPrompt(
      state,
      175,
      async (x) => (x.includes('Old Rope') ? 1000 : x.length),
      [' silver  key '],
    );
    expect(prompt).toContain('Silver Key');
    expect(prompt).not.toContain('Old Rope');
  });
});
