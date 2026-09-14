import { automaticTransaction, extract, ExtractionError, validateExtraction } from './extraction';
import { chatPrefixFingerprint, fingerprintMessages, type TavernMessage } from './fingerprint';
import { getContainer, preferences, putContainer } from './persistence';
import { applyTransaction, normalize } from './reducer';
import { renderPrompt } from './prompt';
import type { GameState, ReviewItem, RpStateContainer, StateTransaction } from './types';
import { containerSchema, gameStateSchema } from './schema';

export interface TavernContext {
  chat: TavernMessage[]; chatId?: string; chatMetadata: Record<string, unknown>; extensionSettings: Record<string, unknown>;
  saveMetadata(): Promise<void>; saveSettingsDebounced?: () => void; generateRaw(options: Record<string, unknown>): Promise<unknown>;
  getTokenCountAsync?: (text: string) => Promise<number>; setExtensionPrompt?: (...args: unknown[]) => void;
  eventSource: { on(type: string, fn: (...args: unknown[]) => unknown): unknown; off?: (type: string, fn: (...args: unknown[]) => unknown) => unknown; removeListener?: (type: string, fn: (...args: unknown[]) => unknown) => unknown };
  eventTypes: Record<string, string>; SlashCommandParser?: { addCommandObject(command: unknown): unknown }; SlashCommand?: { fromProps(props: unknown): unknown };
}
type GetContext = () => TavernContext;
const PROMPT_KEY = 'rp-state-machine';
const messageEvents = ['MESSAGE_RECEIVED', 'MESSAGE_UPDATED', 'MESSAGE_DELETED', 'MESSAGE_SWIPED'];
const lifecycleEvents = ['GENERATION_STARTED', 'GENERATION_ENDED', 'CHAT_CHANGED'];
function review(container: RpStateContainer, item: Omit<ReviewItem, 'id' | 'createdAt'>) { container.reviewQueue.push({ ...item, id: crypto.randomUUID(), createdAt: new Date().toISOString() }); }
function sameChat(ctx: TavernContext, chatId: string | undefined) { return ctx.chatId === chatId; }
export class RpStateMachine {
  private queue: Promise<void> = Promise.resolve(); private unsubs: Array<() => void> = []; private changed = false; private generating = false; private disposed = false; private revision = 0; private reconcileTimer?: ReturnType<typeof setTimeout>;
  constructor(private readonly getContext: GetContext, private readonly onChange: () => void = () => {}) {}
  enqueue(work: () => Promise<void>) { const result = this.queue.then(work); this.queue = result.catch(error => console.error('[RP State Machine]', error)); return result; }
  start() {
    const ctx = this.getContext();
    for (const key of [...messageEvents, ...lifecycleEvents]) { const type = ctx.eventTypes[key]; if (!type) continue; const handler = () => this.handle(key); ctx.eventSource.on(type, handler); this.unsubs.push(() => { if (ctx.eventSource.off) ctx.eventSource.off(type, handler); else ctx.eventSource.removeListener?.(type, handler); }); }
    const props = { name: 'rpstate', helpString: 'Open RP State Machine', unnamedArgumentList: [{ name: 'action', enumList: ['pause', 'resume', 'retry', 'replay'], isRequired: false }], callback: (_args: unknown, value: string) => { void this.command(String(value ?? '')); return ''; } };
    ctx.SlashCommandParser?.addCommandObject(ctx.SlashCommand?.fromProps ? ctx.SlashCommand.fromProps(props) : props);
  }
  stop() { this.disposed = true; this.revision++; if (this.reconcileTimer) clearTimeout(this.reconcileTimer); this.unsubs.splice(0).forEach(fn => fn()); try { this.getContext().setExtensionPrompt?.(PROMPT_KEY, '', 1, 0, false, 0); } catch { /* chat may be gone */ } }
  private handle(event: string) {
    if (event === 'GENERATION_STARTED') { this.generating = true; return; }
    if (event === 'CHAT_CHANGED') { this.changed = true; this.scheduleReconcile(); this.onChange(); return; }
    if (messageEvents.includes(event)) { this.changed = true; this.scheduleReconcile(); this.onChange(); return; }
    if (event === 'GENERATION_ENDED') { this.generating = false; void this.enqueue(() => this.reconcile()); }
  }
  private scheduleReconcile() { if (this.generating || this.reconcileTimer) return; this.reconcileTimer = setTimeout(() => { this.reconcileTimer = undefined; void this.enqueue(() => this.reconcile()); }, 75); }
  async inject(generationType?: unknown) {
    const ctx = this.getContext(), chatId = ctx.chatId, metadataRef = ctx.chatMetadata.rp_state_machine, container = getContainer(ctx), prefs = preferences(ctx);
    const quietOrImpersonation = /quiet|impersonat/i.test(String(generationType ?? ''));
    if (!container || container.status !== 'ready' || prefs.paused || !prefs.injectionEnabled || quietOrImpersonation) { ctx.setExtensionPrompt?.(PROMPT_KEY, '', 1, 0, false, 0); return; }
    const recentIds = container.transactions.slice().reverse().flatMap(t => t.events.flatMap(e => ('item' in e ? [e.item] : 'character' in e ? [e.character] : 'id' in e ? [e.id] : [])));
    const text = await renderPrompt(container.currentState, prefs.tokenCeiling, async x => ctx.getTokenCountAsync ? ctx.getTokenCountAsync(x) : Math.ceil(x.length / 4), recentIds);
    if (!sameChat(this.getContext(), chatId) || this.getContext().chatMetadata.rp_state_machine !== metadataRef) { this.getContext().setExtensionPrompt?.(PROMPT_KEY, '', 1, 0, false, 0); return; }
    ctx.setExtensionPrompt?.(PROMPT_KEY, text, 1, 0, false, 0);
  }
  private async reconcile() {
    if (this.disposed || this.generating) return;
    const ctx = this.getContext(), chatId = ctx.chatId, revision = this.revision, container = getContainer(ctx), prefs = preferences(ctx); if (prefs.debug) console.debug('[RP State Machine] reconcile start', chatId);
    if (!container || prefs.paused || !this.changed) return;
    this.changed = false;
    const messages = await fingerprintMessages(ctx.chat);
    const currentPrefix = await chatPrefixFingerprint(messages, container.seed.messageCount);
    if (this.disposed || !sameChat(this.getContext(), chatId) || revision !== this.revision) return;
    if (currentPrefix !== container.seed.chatPrefixFingerprint) { container.status = 'needs-reseed'; review(container, { kind: 'replay', message: 'A message before the seed changed; reseed is required.' }); putContainer(ctx, container); await ctx.saveMetadata(); this.onChange(); return; }
    const old = container.messages; const start = this.firstChanged(old, messages, container.seed.messageCount, container.transactions);
    if (start === -1) return;
    container.status = 'replaying';
    const anchoredManual = container.transactions.filter(t => t.origin === 'manual'); const seedAnchor = this.seedAnchor(container);
    const retained = container.transactions.filter(t => t.sourceFingerprint === seedAnchor || (t.sourceOrdinal !== undefined && t.sourceOrdinal < start));
    const retainedState = retained.reduce((state, transaction) => { try { return applyTransaction(state, transaction.events); } catch (error) { review(container, { kind: 'replay', message: `Retained transaction invalid: ${String(error)}`, transaction }); return state; } }, structuredClone(container.seed.baseState));
    type ReplayResult = { state: GameState; history: StateTransaction[]; aborted: boolean };
    const replayAt = async (i: number, state: GameState, history: StateTransaction[]): Promise<ReplayResult> => {
      if (i >= messages.length) return { state, history, aborted: false };
      const fp = messages[i];
      const applyAnchoredManual = (currentState: GameState, currentHistory: StateTransaction[]) => anchoredManual.filter(t => t.sourceFingerprint === fp.fingerprint).reduce((acc, manual) => { try { const replayed = { ...manual, sourceOrdinal: i, sourceSwipeId: fp.swipeId }; return { state: applyTransaction(acc.state, replayed.events), history: [...acc.history, replayed] }; } catch (error) { review(container, { kind: 'manual', message: `Manual transaction invalid at its anchor: ${String(error)}`, transaction: manual }); return acc; } }, { state: currentState, history: currentHistory });
      if (!fp.isAssistant) { const manualResult = applyAnchoredManual(state, history); return replayAt(i + 1, manualResult.state, manualResult.history); }
      if (!sameChat(this.getContext(), chatId) || this.getContext().chat[i] === undefined) return { state, history, aborted: true };
      const automaticResult = await (async (): Promise<ReplayResult> => {
      try {
        container.status = 'extracting';
        const priorUserMessage = [...ctx.chat.slice(0, i)].reverse().find(x => x.is_user);
        const result = await extract(ctx, state, { user: priorUserMessage?.mes, userSpeaker: priorUserMessage?.name, assistant: String(ctx.chat[i].mes ?? ''), assistantSpeaker: ctx.chat[i].name });
        const latest = sameChat(this.getContext(), chatId) ? await fingerprintMessages(this.getContext().chat) : [];
        if (!sameChat(this.getContext(), chatId) || revision !== this.revision || latest[i]?.fingerprint !== fp.fingerprint) return { state, history, aborted: true };
        const nextState = validateExtraction(state, result);
        container.reviewQueue = container.reviewQueue.filter(item => !(item.sourceFingerprint === fp.fingerprint && (item.kind === 'extraction' || item.kind === 'semantic')));
        return { state: nextState, history: [...history, automaticTransaction(result, fp.fingerprint, i, fp.swipeId)], aborted: false };
      } catch (error) { review(container, { kind: 'extraction', message: String(error), raw: error instanceof ExtractionError ? error.raw : undefined, sourceFingerprint: fp.fingerprint }); if (prefs.debug) console.debug('[RP State Machine] extraction rejected', fp.fingerprint, error); return { state, history, aborted: false }; }
      })();
      if (automaticResult.aborted) return automaticResult;
      const manualResult = applyAnchoredManual(automaticResult.state, automaticResult.history);
      return replayAt(i + 1, manualResult.state, manualResult.history);
    };
    const replayed = await replayAt(start, retainedState, [...retained]);
    // Manual transactions without a surviving anchor remain auditable but cannot be reapplied.
    for (const manual of anchoredManual.filter(t => t.sourceFingerprint !== seedAnchor && (!t.sourceFingerprint || !messages.some(m => m.fingerprint === t.sourceFingerprint)))) review(container, { kind: 'manual', message: 'Manual transaction anchor no longer exists.', transaction: manual });
    if (replayed.aborted || !sameChat(this.getContext(), chatId) || revision !== this.revision) return;
    container.currentState = replayed.state; container.messages = messages; container.transactions = replayed.history; container.status = 'ready';
    putContainer(this.getContext(), container); await this.getContext().saveMetadata(); if (prefs.debug) console.debug('[RP State Machine] reconcile committed', chatId); this.onChange();
  }
  private firstChanged(old: RpStateContainer['messages'], next: RpStateContainer['messages'], minimum: number, transactions: StateTransaction[]) { if (!old.length) return minimum; const length = Math.max(old.length, next.length); const changed = Array.from({ length: Math.max(0, length - minimum) }, (_, offset) => minimum + offset).find(i => old[i]?.fingerprint !== next[i]?.fingerprint); if (changed !== undefined) return changed; return Array.from({ length: Math.max(0, next.length - minimum) }, (_, offset) => minimum + offset).find(i => next[i].isAssistant && !transactions.some(t => t.sourceFingerprint === next[i].fingerprint && (t.origin === 'automatic' || t.explanation === 'Reviewed manual correction'))) ?? -1; }
  async seed(state: GameState) { const intended = this.getContext().chatId; await this.enqueue(async () => { const valid = gameStateSchema.safeParse(state); if (!valid.success) throw new Error(`Invalid seed: ${valid.error.issues[0]?.message}`); const ctx = this.getContext(); if (!sameChat(ctx, intended)) throw new Error('Chat changed while seeding'); const fingerprints = await fingerprintMessages(ctx.chat); const prefix = await chatPrefixFingerprint(fingerprints, fingerprints.length); if (!sameChat(this.getContext(), intended)) throw new Error('Chat changed while seeding'); const container: RpStateContainer = { schemaVersion: 1, status: 'ready', seed: { baseState: structuredClone(valid.data), chatPrefixFingerprint: prefix, messageCount: fingerprints.length }, currentState: structuredClone(valid.data), messages: fingerprints, transactions: [], reviewQueue: [] }; putContainer(this.getContext(), container); await this.getContext().saveMetadata(); this.onChange(); }); }
  private seedAnchor(container: RpStateContainer) { return `seed:${container.seed.chatPrefixFingerprint}`; }
  async manual(events: StateTransaction['events'], explanation: string, anchor?: string) { const intended = this.getContext().chatId; await this.enqueue(async () => { const ctx = this.getContext(), container = getContainer(ctx); if (!container || !sameChat(ctx, intended)) throw new Error('Seed this chat first'); const source = anchor ? container.messages.find(x => x.fingerprint === anchor) : container.messages[container.messages.length - 1]; const isPostSeed = !!source && source.ordinal >= container.seed.messageCount; const transaction: StateTransaction = { id: crypto.randomUUID(), origin: 'manual', sourceFingerprint: isPostSeed ? source!.fingerprint : this.seedAnchor(container), sourceOrdinal: isPostSeed ? source!.ordinal : undefined, sourceSwipeId: isPostSeed ? source!.swipeId : undefined, events, timestamp: new Date().toISOString(), explanation }; try { container.currentState = applyTransaction(container.currentState, events); container.transactions.push(transaction); } catch (error) { review(container, { kind: 'manual', message: String(error), transaction, sourceFingerprint: transaction.sourceFingerprint }); } if (!sameChat(this.getContext(), intended)) throw new Error('Chat changed during manual edit'); putContainer(ctx, container); await ctx.saveMetadata(); this.onChange(); }); }
  async discardReview(id: string) { const intended = this.getContext().chatId; await this.enqueue(async () => { const ctx = this.getContext(), container = getContainer(ctx); if (!container || !sameChat(ctx, intended)) return; container.reviewQueue = container.reviewQueue.filter(x => x.id !== id); putContainer(ctx, container); await ctx.saveMetadata(); this.onChange(); }); }
  async applyReviewedEvents(id: string, events: StateTransaction['events']) { const intended = this.getContext().chatId; await this.enqueue(async () => { const ctx = this.getContext(), container = getContainer(ctx); if (!container || !sameChat(ctx, intended)) throw new Error('State is unavailable'); const item = container.reviewQueue.find(x => x.id === id); if (!item) throw new Error('Review item no longer exists'); const source = item.sourceFingerprint; const anchor = container.messages.find(x => x.fingerprint === source); const transaction: StateTransaction = { id: crypto.randomUUID(), origin: 'manual', sourceFingerprint: anchor ? anchor.fingerprint : this.seedAnchor(container), sourceOrdinal: anchor?.ordinal, sourceSwipeId: anchor?.swipeId, events, timestamp: new Date().toISOString(), explanation: 'Reviewed manual correction' }; try { const ordered = [...container.transactions, transaction].map((value, index) => ({ value, index })).sort((a, b) => (a.value.sourceOrdinal ?? -1) - (b.value.sourceOrdinal ?? -1) || a.index - b.index).map(x => x.value); const rebuilt = ordered.reduce((state, entry) => applyTransaction(state, entry.events), structuredClone(container.seed.baseState)); container.currentState = rebuilt; container.transactions = ordered; container.reviewQueue = container.reviewQueue.filter(x => x.id !== id); } catch (error) { item.kind = 'manual'; item.message = `Reviewed events rejected: ${String(error)}`; item.transaction = transaction; putContainer(ctx, container); await ctx.saveMetadata(); this.onChange(); throw error; } putContainer(ctx, container); await ctx.saveMetadata(); this.onChange(); }); }
  async importState(value: unknown) { const intended = this.getContext().chatId; await this.enqueue(async () => { const parsed = containerSchema.safeParse(value); if (!parsed.success) throw new Error('Invalid import'); const ctx = this.getContext(); if (!sameChat(ctx, intended)) throw new Error('Chat changed during import'); this.revision++; putContainer(ctx, parsed.data as RpStateContainer); await ctx.saveMetadata(); this.onChange(); }); }
  async resetState() { const intended = this.getContext().chatId; await this.enqueue(async () => { const ctx = this.getContext(); if (!sameChat(ctx, intended)) throw new Error('Chat changed during reset'); this.revision++; delete ctx.chatMetadata.rp_state_machine; await ctx.saveMetadata(); this.onChange(); }); }
  async retry() { const intended = this.getContext().chatId; this.changed = true; await this.enqueue(async () => { if (!sameChat(this.getContext(), intended)) throw new Error('Chat changed before retry'); await this.reconcile(); }); }
  async command(value: string) { const command = value.trim().toLowerCase(); if (command === 'pause' || command === 'resume') { const ctx = this.getContext(); const p = preferences(ctx); p.paused = command === 'pause'; ctx.extensionSettings.rp_state_machine = p; ctx.saveSettingsDebounced?.(); this.onChange(); return; } if (command === 'retry' || command === 'replay') return this.retry(); document.querySelector<HTMLButtonElement>('[data-rpstate-open]')?.click(); }
}
