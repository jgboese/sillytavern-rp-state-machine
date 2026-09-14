import { describe, expect, it, vi } from 'vitest';
import { RpStateMachine } from '../src/runtime';
import { emptyState, getContainer } from '../src/persistence';

function fixture() {
  const handlers: Record<string, () => void> = {};
  const context = {
    chat: [{ is_user: true, name: 'You', mes: 'Start' }],
    chatId: 'a',
    chatMetadata: {},
    extensionSettings: {},
    saveMetadata: vi.fn().mockResolvedValue(undefined),
    generateRaw: vi
      .fn()
      .mockResolvedValue(
        '{"events":[{"type":"location.set","location":"Docks"}],"explanation":"Arrival"}',
      ),
    setExtensionPrompt: vi.fn(),
    eventSource: {
      on: vi.fn((type: string, fn: () => void) => {
        handlers[type] = fn;
      }),
      off: vi.fn(),
    },
    eventTypes: {
      MESSAGE_RECEIVED: 'received',
      MESSAGE_UPDATED: 'updated',
      MESSAGE_DELETED: 'deleted',
      MESSAGE_SWIPED: 'swiped',
      GENERATION_STARTED: 'start',
      GENERATION_ENDED: 'end',
      CHAT_CHANGED: 'changed',
    },
  };
  return { context, handlers };
}
function deferred<T>() {
  const control: { resolve?: (value: T | PromiseLike<T>) => void } = {};
  const promise = new Promise<T>((resolve) => {
    control.resolve = resolve;
  });
  return { promise, resolve: (value: T) => control.resolve!(value) };
}
describe('runtime reconciliation', () => {
  it('commits one valid assistant transaction after a normal generation', async () => {
    const { context, handlers } = fixture();
    const machine = new RpStateMachine(() => context);
    machine.start();
    await machine.seed(emptyState('2026-01-01T00:00', 'Inn'));
    context.chat.push({
      is_user: false,
      name: 'Mira',
      mes: 'We arrive at the docks.',
    });
    handlers.received();
    await machine.retry();
    const result = getContainer(context)!;
    expect(result.currentState.world.location).toBe('Docks');
    expect(result.transactions).toHaveLength(1);
    expect(context.generateRaw).toHaveBeenCalledTimes(1);
  });
  it('marks a pre-seed edit as needing reseed', async () => {
    const { context, handlers } = fixture();
    const machine = new RpStateMachine(() => context);
    machine.start();
    await machine.seed(emptyState('2026-01-01T00:00', 'Inn'));
    context.chat[0].mes = 'Changed baseline';
    handlers.updated();
    await machine.retry();
    expect(getContainer(context)!.status).toBe('needs-reseed');
  });
  it('uses in-chat system injection and skips quiet generations', async () => {
    const { context } = fixture();
    const machine = new RpStateMachine(() => context);
    await machine.seed(emptyState('2026-01-01T00:00', 'Inn'));
    await machine.inject('normal');
    expect(context.setExtensionPrompt).toHaveBeenLastCalledWith(
      'rp-state-machine',
      expect.any(String),
      1,
      0,
      false,
      0,
    );
    await machine.inject('quiet');
    expect(context.setExtensionPrompt).toHaveBeenLastCalledWith(
      'rp-state-machine',
      '',
      1,
      0,
      false,
      0,
    );
  });
  it('preserves a seed-anchored manual edit through replay without a false missing-anchor review', async () => {
    const { context, handlers } = fixture();
    const machine = new RpStateMachine(() => context);
    machine.start();
    await machine.seed(emptyState('2026-01-01T00:00', 'Inn'));
    await machine.manual(
      [{ type: 'location.set', location: 'Manual Inn' }],
      'manual',
    );
    context.chat.push({ is_user: false, name: 'Mira', mes: 'At docks' });
    handlers.updated();
    await machine.retry();
    expect(getContainer(context)!.currentState.world.location).toBe('Docks');
    expect(
      getContainer(context)!.transactions.some((t) => t.origin === 'manual'),
    ).toBe(true);
    expect(getContainer(context)!.reviewQueue).toEqual([]);
  });
  it('keeps reviewed corrections anchored to their source message without duplicate extraction', async () => {
    const { context, handlers } = fixture();
    const machine = new RpStateMachine(() => context);
    machine.start();
    await machine.seed(emptyState('2026-01-01T00:00', 'Inn'));
    context.chat.push({ is_user: false, name: 'Mira', mes: 'At docks' });
    handlers.updated();
    await machine.retry();
    const stored = (context.chatMetadata as Record<string, any>)
      .rp_state_machine;
    const source = stored.messages[1];
    stored.transactions = [];
    stored.reviewQueue.push({
      id: 'review-1',
      kind: 'extraction',
      message: 'Fix',
      sourceFingerprint: source.fingerprint,
      createdAt: new Date().toISOString(),
    });
    const before = context.generateRaw.mock.calls.length;
    await machine.applyReviewedEvents('review-1', [
      { type: 'location.set', location: 'Reviewed Docks' },
    ]);
    const manual = getContainer(context)!.transactions.find(
      (t) => t.origin === 'manual',
    )!;
    expect(manual.sourceFingerprint).toBe(source.fingerprint);
    expect(manual.sourceOrdinal).toBe(1);
    expect(manual.sourceSwipeId).toBe(source.swipeId);
    await machine.retry();
    expect(context.generateRaw.mock.calls.length).toBe(before);
  });
  it('does not commit when the chat changes during extraction and clears prompts on stop', async () => {
    const { context, handlers } = fixture();
    context.generateRaw.mockImplementation(async () => {
      context.chatId = 'other';
      return '{"events":[{"type":"location.set","location":"Leak"}],"explanation":"x"}';
    });
    const machine = new RpStateMachine(() => context);
    machine.start();
    await machine.seed(emptyState('2026-01-01T00:00', 'Inn'));
    context.chat.push({ is_user: false, name: 'Mira', mes: 'Move' });
    handlers.updated();
    await machine.retry();
    expect(getContainer(context)!.currentState.world.location).toBe('Inn');
    machine.stop();
    expect(context.setExtensionPrompt).toHaveBeenLastCalledWith(
      'rp-state-machine',
      '',
      1,
      0,
      false,
      0,
    );
  });
  it('replays assistant edits and swipe changes from the seed', async () => {
    const { context } = fixture();
    context.generateRaw.mockImplementation(async ({ prompt }: any) =>
      JSON.stringify({
        events: [
          {
            type: 'inventory.add',
            item: 'gem',
            quantity: prompt.includes('three')
              ? 3
              : prompt.includes('two')
                ? 2
                : 1,
          },
        ],
        explanation: 'gain',
      }),
    );
    const machine = new RpStateMachine(() => context);
    await machine.seed(emptyState('2026-01-01T00:00', 'Inn'));
    context.chat.push({ is_user: false, name: 'Mira', mes: 'gain one' });
    await machine.retry();
    expect(getContainer(context)!.currentState.inventory.gem.quantity).toBe(1);
    context.chat[1].mes = 'gain two';
    await machine.retry();
    expect(getContainer(context)!.currentState.inventory.gem.quantity).toBe(2);
    context.chat[1].mes = 'gain three';
    (context.chat[1] as any).swipe_id = 1;
    await machine.retry();
    expect(getContainer(context)!.currentState.inventory.gem.quantity).toBe(3);
    expect(getContainer(context)!.transactions).toHaveLength(1);
  });
  it('replays single and truncate-from-message deletions', async () => {
    const { context } = fixture();
    const state = emptyState('2026-01-01T00:00', 'Inn');
    state.currencies.gold = { id: 'gold', name: 'Gold', amount: 10 };
    context.generateRaw.mockImplementation(async ({ prompt }: any) =>
      JSON.stringify({
        events: [
          {
            type: 'currency.adjust',
            currency: 'gold',
            amount: prompt.includes('gain') ? 5 : -2,
          },
        ],
        explanation: 'money',
      }),
    );
    const machine = new RpStateMachine(() => context);
    await machine.seed(state);
    context.chat.push(
      { is_user: false, name: 'Mira', mes: 'gain' },
      { is_user: false, name: 'Mira', mes: 'spend' },
    );
    await machine.retry();
    expect(getContainer(context)!.currentState.currencies.gold.amount).toBe(13);
    context.chat.splice(2, 1);
    await machine.retry();
    expect(getContainer(context)!.currentState.currencies.gold.amount).toBe(15);
    context.chat.splice(1);
    await machine.retry();
    expect(getContainer(context)!.currentState.currencies.gold.amount).toBe(10);
    expect(getContainer(context)!.transactions).toEqual([]);
  });
  it('preserves manual ordering and reviews a deleted manual anchor', async () => {
    const { context } = fixture();
    const state = emptyState('2026-01-01T00:00', 'Inn');
    state.currencies.gold = { id: 'gold', name: 'Gold', amount: 0 };
    context.generateRaw.mockImplementation(async ({ prompt }: any) =>
      JSON.stringify({
        events: [
          {
            type: 'currency.adjust',
            currency: 'gold',
            amount: prompt.includes('later') ? 3 : 5,
          },
        ],
        explanation: 'money',
      }),
    );
    const machine = new RpStateMachine(() => context);
    await machine.seed(state);
    context.chat.push({ is_user: false, name: 'Mira', mes: 'first' });
    await machine.retry();
    await machine.manual(
      [{ type: 'currency.set', currency: 'gold', amount: 2 }],
      'override',
    );
    context.chat.push({ is_user: false, name: 'Mira', mes: 'later' });
    await machine.retry();
    expect(getContainer(context)!.currentState.currencies.gold.amount).toBe(5);
    context.chat[2].mes = 'later edited';
    await machine.retry();
    expect(getContainer(context)!.currentState.currencies.gold.amount).toBe(5);
    context.chat.splice(1, 1);
    await machine.retry();
    expect(
      getContainer(context)!.reviewQueue.some((item) =>
        item.message.includes('anchor no longer exists'),
      ),
    ).toBe(true);
  });
  it('applies reviewed corrections at their source before later transactions', async () => {
    const { context } = fixture();
    const state = emptyState('2026-01-01T00:00', 'Inn');
    state.currencies.gold = { id: 'gold', name: 'Gold', amount: 10 };
    context.generateRaw.mockImplementation(async ({ prompt }: any) =>
      JSON.stringify({
        events: [
          {
            type: 'currency.adjust',
            currency: 'gold',
            amount: prompt.includes('first') ? 5 : -2,
          },
        ],
        explanation: 'money',
      }),
    );
    const machine = new RpStateMachine(() => context);
    await machine.seed(state);
    context.chat.push(
      { is_user: false, name: 'Mira', mes: 'first' },
      { is_user: false, name: 'Mira', mes: 'later' },
    );
    await machine.retry();
    const stored = (context.chatMetadata as any).rp_state_machine;
    const first = stored.messages[1];
    stored.transactions = stored.transactions.filter(
      (transaction: any) => transaction.sourceOrdinal !== 1,
    );
    stored.reviewQueue.push({
      id: 'correct-first',
      kind: 'semantic',
      message: 'correct it',
      sourceFingerprint: first.fingerprint,
      createdAt: new Date().toISOString(),
    });
    await machine.applyReviewedEvents('correct-first', [
      { type: 'currency.set', currency: 'gold', amount: 4 },
    ]);
    const result = getContainer(context)!;
    expect(result.currentState.currencies.gold.amount).toBe(2);
    expect(result.transactions.map((t) => t.sourceOrdinal)).toEqual([1, 2]);
  });
  it('keeps metadata isolated between chats and rejects queued work after a switch', async () => {
    const a = fixture().context,
      b = fixture().context;
    b.chatId = 'b';
    const machineA = new RpStateMachine(() => a);
    const machineB = new RpStateMachine(() => b);
    await machineA.seed(emptyState('2026-01-01T00:00', 'A'));
    await machineB.seed(emptyState('2026-01-01T00:00', 'B'));
    await machineA.manual([{ type: 'location.set', location: 'A2' }], 'a only');
    expect(getContainer(a)!.currentState.world.location).toBe('A2');
    expect(getContainer(b)!.currentState.world.location).toBe('B');
    const active = { value: a };
    const blocker = deferred<void>();
    const machine = new RpStateMachine(() => active.value);
    const first = machine.enqueue(() => blocker.promise);
    const reset = machine.resetState();
    active.value = b;
    blocker.resolve();
    await first;
    await expect(reset).rejects.toThrow(/Chat changed/);
    expect(getContainer(a)).toBeDefined();
    expect(getContainer(b)).toBeDefined();
  });
  it('serializes reset behind extraction so state cannot be resurrected', async () => {
    const { context } = fixture();
    const extraction = deferred<string>();
    const began = deferred<void>();
    context.generateRaw.mockImplementation(() => {
      began.resolve();
      return extraction.promise;
    });
    const machine = new RpStateMachine(() => context);
    await machine.seed(emptyState('2026-01-01T00:00', 'Inn'));
    context.chat.push({ is_user: false, name: 'Mira', mes: 'move' });
    const retry = machine.retry();
    await began.promise;
    const reset = machine.resetState();
    extraction.resolve(
      '{"events":[{"type":"location.set","location":"Docks"}],"explanation":"move"}',
    );
    await retry;
    await reset;
    expect(getContainer(context)).toBeUndefined();
  });
  it('aborts the whole batch when the source fingerprint changes during extraction', async () => {
    const { context } = fixture();
    const extraction = deferred<string>();
    const began = deferred<void>();
    context.generateRaw.mockImplementation(() => {
      began.resolve();
      return extraction.promise;
    });
    const machine = new RpStateMachine(() => context);
    await machine.seed(emptyState('2026-01-01T00:00', 'Inn'));
    context.chat.push({ is_user: false, name: 'Mira', mes: 'original' });
    const retry = machine.retry();
    await began.promise;
    context.chat[1].mes = 'edited while extracting';
    extraction.resolve(
      '{"events":[{"type":"location.set","location":"Wrong"}],"explanation":"stale"}',
    );
    await retry;
    const result = getContainer(context)!;
    expect(result.currentState.world.location).toBe('Inn');
    expect(result.transactions).toEqual([]);
  });
});
