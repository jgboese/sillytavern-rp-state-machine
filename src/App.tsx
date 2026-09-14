import { useCallback, useEffect, useMemo, useState } from 'react';
import type { GameState, RpStateContainer, StateEvent } from './types';
import type { ConnectionProfile } from './state-agent';
import { emptyState, getContainer, preferences } from './persistence';
import { gameStateSchema, manualEventsSchema } from './schema';
import type { RpStateMachine, TavernContext } from './runtime';
import './styles.css';

type Change = (events: StateEvent[], note: string) => Promise<void>;
const tabs = [
  'Overview',
  'Inventory',
  'Characters',
  'History & Review',
  'Settings',
];

export function StateApp({
  runtime,
  getContext,
}: {
  runtime: RpStateMachine;
  getContext: () => TavernContext;
}) {
  const [, redraw] = useState(0);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState('Overview');
  const context = getContext();
  const container = getContainer(context);
  const malformed =
    context.chatMetadata.rp_state_machine !== undefined && !container;
  const prefs = preferences(context);
  const defaultTime = useMemo(() => {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  }, []);
  const [dateTime, setDateTime] = useState(defaultTime);
  const [location, setLocation] = useState('');
  const [seedJson, setSeedJson] = useState('');
  const refresh = () => redraw((n) => n + 1);
  const seed = async () => {
    if (!dateTime || !location.trim()) return;
    try {
      const initial = emptyState(dateTime, location.trim());
      const fragment = seedJson.trim() ? JSON.parse(seedJson) : {};
      if (!fragment || typeof fragment !== 'object' || Array.isArray(fragment))
        throw new Error();
      const input = fragment as Partial<GameState>;
      const result: GameState = {
        ...initial,
        ...input,
        world: {
          ...initial.world,
          ...input.world,
          localDateTime: dateTime,
          location: location.trim(),
        },
        player: { ...initial.player, ...input.player },
        currencies: input.currencies ?? initial.currencies,
        inventory: input.inventory ?? initial.inventory,
        characters: input.characters ?? initial.characters,
      };
      const valid = gameStateSchema.safeParse(result);
      if (!valid.success) throw new Error();
      await runtime.seed(valid.data);
      refresh();
    } catch {
      alert('Optional seed JSON must be a valid GameState fragment.');
    }
  };
  const change: Change = async (events, note) => {
    await runtime.manual(events, note);
    refresh();
  };
  return (
    <>
      <button
        className="menu_button rpstate-launcher"
        type="button"
        data-rpstate-open
        aria-label="Open RP State Machine"
        onClick={() => {
          setOpen(true);
          refresh();
        }}
      >
        State
      </button>
      {open && (
        <aside className="rpstate-drawer" aria-label="RP State Machine">
          <header className="rpstate-drawer-header">
            <div>
              <p className="rpstate-eyebrow">Roleplay companion</p>
              <h2>RP State</h2>
            </div>
            <button
              className="rpstate-icon-button"
              type="button"
              aria-label="Close RP State Machine"
              onClick={() => setOpen(false)}
            >
              ×
            </button>
          </header>
          {!container ? (
            <section className="rpstate-card rpstate-seed">
              <h3>
                {malformed ? 'Stored state needs reset' : 'Seed this chat'}
              </h3>
              {malformed && (
                <p className="rpstate-review">
                  The saved state failed schema validation. Export or repair it
                  externally, or confirm a new seed below.
                </p>
              )}
              <p>State tracking begins only after you confirm a baseline.</p>
              <div className="rpstate-field-grid">
                <label>
                  Local date/time
                  <input
                    type="datetime-local"
                    value={dateTime}
                    onChange={(e) => setDateTime(e.target.value)}
                    required
                  />
                </label>
                <label>
                  Location
                  <input
                    value={location}
                    onChange={(e) => setLocation(e.target.value)}
                    required
                  />
                </label>
              </div>
              <label>
                Optional currencies, inventory, player conditions, and
                characters JSON
                <textarea
                  value={seedJson}
                  onChange={(e) => setSeedJson(e.target.value)}
                  placeholder={
                    '{"currencies":{"gold":{"id":"gold","name":"Gold","amount":10}},"player":{"conditions":["tired"]},"characters":{}}'
                  }
                />
              </label>
              <Actions>
                <Primary onClick={seed}>Save baseline</Primary>
              </Actions>
            </section>
          ) : (
            <>
              <nav className="rpstate-tabs" aria-label="State views">
                {tabs.map((name) => (
                  <button
                    key={name}
                    type="button"
                    className={tab === name ? 'active' : ''}
                    aria-current={tab === name ? 'page' : undefined}
                    onClick={() => setTab(name)}
                  >
                    {name}
                  </button>
                ))}
              </nav>
              <div className="rpstate-content">
                {tab === 'Overview' && (
                  <Overview
                    state={container.currentState}
                    status={container.status}
                    change={change}
                  />
                )}
                {tab === 'Inventory' && (
                  <Inventory state={container.currentState} change={change} />
                )}
                {tab === 'Characters' && (
                  <Characters state={container.currentState} change={change} />
                )}
                {tab === 'History & Review' && (
                  <History
                    container={container}
                    runtime={runtime}
                    refresh={refresh}
                  />
                )}
                {tab === 'Settings' && (
                  <Settings
                    context={context}
                    runtime={runtime}
                    prefs={prefs}
                    refresh={refresh}
                  />
                )}
              </div>
            </>
          )}
        </aside>
      )}
    </>
  );
}

function Actions({ children }: { children: React.ReactNode }) {
  return <div className="rpstate-actions">{children}</div>;
}
function Button({
  kind = 'subtle',
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  kind?: 'primary' | 'secondary' | 'subtle' | 'danger';
}) {
  return (
    <button
      {...props}
      className={`rpstate-button rpstate-button-${kind}`}
      type="button"
    >
      {children}
    </button>
  );
}
function Primary(props: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return <Button {...props} kind="primary" />;
}
function Overview({
  state,
  status,
  change,
}: {
  state: GameState;
  status: string;
  change: Change;
}) {
  const [time, setTime] = useState(state.world.localDateTime);
  const [location, setLocation] = useState(state.world.location);
  const [currency, setCurrency] = useState('');
  const [amount, setAmount] = useState(0);
  const [condition, setCondition] = useState('');
  useEffect(() => {
    setTime(state.world.localDateTime);
    setLocation(state.world.location);
  }, [state.world.localDateTime, state.world.location]);
  return (
    <>
      <Card title="World">
        <p className="rpstate-status">{status}</p>
        <div className="rpstate-field-grid">
          <label>
            Date/time
            <input
              type="datetime-local"
              value={time}
              onChange={(e) => setTime(e.target.value)}
            />
          </label>
          <label>
            Location
            <input
              value={location}
              onChange={(e) => setLocation(e.target.value)}
            />
          </label>
        </div>
        <Actions>
          <Primary
            onClick={() =>
              change(
                [
                  { type: 'time.set', localDateTime: time },
                  { type: 'location.set', location },
                ],
                'Manual world edit',
              )
            }
          >
            Save world
          </Primary>
        </Actions>
      </Card>
      <Card title="Current state">
        <dl className="rpstate-summary">
          <dt>Currencies</dt>
          <dd>
            {Object.values(state.currencies)
              .map((x) => `${x.name}: ${x.amount}`)
              .join(', ') || 'None'}
          </dd>
          <dt>Player conditions</dt>
          <dd>{state.player.conditions.join(', ') || 'None'}</dd>
        </dl>
      </Card>
      <Card title="Currency">
        <div className="rpstate-field-grid">
          <label>
            Currency
            <input
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
            />
          </label>
          <label>
            Amount
            <input
              type="number"
              step="1"
              value={amount}
              onChange={(e) => setAmount(Number(e.target.value))}
            />
          </label>
        </div>
        <Actions>
          <Button
            kind="secondary"
            onClick={() =>
              currency &&
              change(
                [{ type: 'currency.set', currency, name: currency, amount }],
                'Manual currency edit',
              )
            }
          >
            Save currency
          </Button>
        </Actions>
      </Card>
      <Card title="Player condition">
        <label>
          Condition
          <input
            value={condition}
            onChange={(e) => setCondition(e.target.value)}
          />
        </label>
        <Actions>
          <Button
            kind="secondary"
            onClick={() =>
              condition &&
              change(
                [{ type: 'condition.add', target: 'player', condition }],
                'Manual player condition edit',
              )
            }
          >
            Add condition
          </Button>
        </Actions>
      </Card>
    </>
  );
}
function Card({
  title,
  children,
  className = '',
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`rpstate-card ${className}`}>
      <h3>{title}</h3>
      {children}
    </section>
  );
}
function Inventory({ state, change }: { state: GameState; change: Change }) {
  const [search, setSearch] = useState('');
  const [item, setItem] = useState('');
  const [quantity, setQuantity] = useState(1);
  const visible = Object.values(state.inventory).filter((x) =>
    x.name.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <>
      <Card title="Inventory">
        <label>
          Search inventory
          <input
            placeholder="Search inventory"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <ul className="rpstate-list">
          {visible.map((x) => (
            <InventoryRow key={x.id} item={x} change={change} />
          ))}
          {!visible.length && (
            <li className="rpstate-empty">No matching items.</li>
          )}
        </ul>
      </Card>
      <Card title="Add item">
        <div className="rpstate-field-grid">
          <label>
            Item
            <input value={item} onChange={(e) => setItem(e.target.value)} />
          </label>
          <label>
            Quantity
            <input
              type="number"
              min="1"
              value={quantity}
              onChange={(e) => setQuantity(Number(e.target.value))}
            />
          </label>
        </div>
        <Actions>
          <Primary
            onClick={() =>
              item &&
              change(
                [{ type: 'inventory.add', item, quantity, name: item }],
                'Manual inventory edit',
              )
            }
          >
            Add item
          </Primary>
        </Actions>
      </Card>
    </>
  );
}
function InventoryRow({
  item,
  change,
}: {
  item: GameState['inventory'][string];
  change: Change;
}) {
  const [quantity, setQuantity] = useState(item.quantity);
  const [note, setNote] = useState(item.note ?? '');
  useEffect(() => {
    setQuantity(item.quantity);
    setNote(item.note ?? '');
  }, [item.quantity, item.note]);
  return (
    <li className="rpstate-list-item">
      <strong>{item.name}</strong>
      <div className="rpstate-field-grid">
        <label>
          Quantity
          <input
            aria-label={`${item.name} quantity`}
            type="number"
            min="0"
            value={quantity}
            onChange={(e) => setQuantity(Number(e.target.value))}
          />
        </label>
        <label>
          Note
          <input
            aria-label={`${item.name} note`}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
      </div>
      <Actions>
        <Button
          onClick={() =>
            change(
              [{ type: 'inventory.set', item: item.id, quantity, note }],
              'Manual inventory edit',
            )
          }
        >
          Save {item.name}
        </Button>
      </Actions>
    </li>
  );
}
function Characters({ state, change }: { state: GameState; change: Change }) {
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  return (
    <>
      <div className="rpstate-stack">
        {Object.values(state.characters).map((x) => (
          <Character key={x.id} character={x} change={change} />
        ))}
        {!Object.keys(state.characters).length && (
          <p className="rpstate-card rpstate-empty">
            No characters are tracked yet.
          </p>
        )}
      </div>
      <Card title="Add character">
        <div className="rpstate-field-grid">
          <label>
            Stable id
            <input value={id} onChange={(e) => setId(e.target.value)} />
          </label>
          <label>
            Display name
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
        </div>
        <Actions>
          <Primary
            onClick={() =>
              id &&
              name &&
              change(
                [
                  {
                    type: 'character.set',
                    id,
                    displayName: name,
                    aliases: [],
                    conditions: [],
                  },
                ],
                'Manual character creation',
              )
            }
          >
            Add character
          </Primary>
        </Actions>
      </Card>
    </>
  );
}
function Character({
  character,
  change,
}: {
  character: GameState['characters'][string];
  change: Change;
}) {
  const [score, setScore] = useState(character.relationship.score);
  const [note, setNote] = useState(character.relationship.note ?? '');
  const [condition, setCondition] = useState('');
  const [aliases, setAliases] = useState(character.aliases.join(', '));
  useEffect(() => {
    setScore(character.relationship.score);
    setNote(character.relationship.note ?? '');
    setAliases(character.aliases.join(', '));
  }, [
    character.relationship.score,
    character.relationship.note,
    character.aliases,
  ]);
  return (
    <Card title={character.displayName}>
      <label>
        Aliases
        <input value={aliases} onChange={(e) => setAliases(e.target.value)} />
      </label>
      <Actions>
        <Button
          onClick={() =>
            change(
              [
                {
                  type: 'character.set',
                  id: character.id,
                  displayName: character.displayName,
                  aliases: aliases
                    .split(',')
                    .map((x) => x.trim())
                    .filter(Boolean),
                  conditions: character.conditions,
                  relationshipScore: character.relationship.score,
                  relationshipNote: character.relationship.note,
                },
              ],
              'Manual alias edit',
            )
          }
        >
          Save aliases
        </Button>
      </Actions>
      <p className="rpstate-muted">
        Conditions: {character.conditions.join(', ') || '—'}
      </p>
      {character.relationship.lastReason && (
        <p className="rpstate-muted">
          Recent change: {character.relationship.lastReason}
        </p>
      )}
      <div className="rpstate-field-grid">
        <label>
          Relationship score
          <input
            type="number"
            min="-100"
            max="100"
            value={score}
            onChange={(e) => setScore(Number(e.target.value))}
          />
        </label>
        <label>
          Relationship note
          <input value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
      </div>
      <Actions>
        <Button
          kind="secondary"
          onClick={() =>
            change(
              [
                {
                  type: 'relationship.set',
                  character: character.id,
                  score,
                  note,
                  reason: 'Manual relationship edit',
                },
              ],
              'Manual relationship edit',
            )
          }
        >
          Save relationship
        </Button>
        <Button
          onClick={() =>
            change(
              [
                {
                  type: 'relationship.adjust',
                  character: character.id,
                  amount: 1,
                  reason: 'Manual adjustment',
                },
              ],
              'Manual relationship edit',
            )
          }
        >
          +1
        </Button>
        <Button
          onClick={() =>
            change(
              [
                {
                  type: 'relationship.adjust',
                  character: character.id,
                  amount: -1,
                  reason: 'Manual adjustment',
                },
              ],
              'Manual relationship edit',
            )
          }
        >
          −1
        </Button>
      </Actions>
      <label>
        Add condition
        <input
          value={condition}
          onChange={(e) => setCondition(e.target.value)}
        />
      </label>
      <Actions>
        <Button
          onClick={() =>
            condition &&
            change(
              [{ type: 'condition.add', target: character.id, condition }],
              'Manual character condition edit',
            )
          }
        >
          Add condition
        </Button>
      </Actions>
    </Card>
  );
}
function History({
  container,
  runtime,
  refresh,
}: {
  container: RpStateContainer;
  runtime: RpStateMachine;
  refresh: () => void;
}) {
  return (
    <>
      <Card title="Transactions">
        <Actions>
          <Button
            kind="secondary"
            onClick={() => runtime.retry().then(refresh)}
          >
            Replay / retry
          </Button>
        </Actions>
        <ol className="rpstate-transactions">
          {container.transactions.map((x) => (
            <li key={x.id}>
              <strong>{x.origin}</strong>:{' '}
              {x.explanation || `${x.events.length} event(s)`}
            </li>
          ))}
          {!container.transactions.length && (
            <li className="rpstate-empty">No transactions yet.</li>
          )}
        </ol>
      </Card>
      <div className="rpstate-stack">
        <h3>Review</h3>
        {container.reviewQueue.length ? (
          container.reviewQueue.map((x) => (
            <Review key={x.id} item={x} runtime={runtime} refresh={refresh} />
          ))
        ) : (
          <p className="rpstate-card rpstate-empty">Nothing to review.</p>
        )}
      </div>
    </>
  );
}
function Review({
  item,
  runtime,
  refresh,
}: {
  item: RpStateContainer['reviewQueue'][number];
  runtime: RpStateMachine;
  refresh: () => void;
}) {
  const [raw, setRaw] = useState(
    JSON.stringify(item.transaction?.events ?? [], null, 2),
  );
  useEffect(
    () => setRaw(JSON.stringify(item.transaction?.events ?? [], null, 2)),
    [item.id, item.transaction],
  );
  const apply = async () => {
    try {
      const parsed = manualEventsSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) return alert('Events JSON is invalid.');
      await runtime.applyReviewedEvents(item.id, parsed.data);
      refresh();
    } catch {
      alert('Reviewed events were not applied; details remain in review.');
    }
  };
  return (
    <Card title="Review item" className="rpstate-review">
      <p>{item.message}</p>
      {item.raw && (
        <details>
          <summary>Rejected extractor output</summary>
          <pre>{item.raw}</pre>
        </details>
      )}
      <label>
        Review events JSON
        <textarea value={raw} onChange={(e) => setRaw(e.target.value)} />
      </label>
      <Actions>
        <Button kind="secondary" onClick={() => runtime.retry().then(refresh)}>
          Retry extraction
        </Button>
        <Primary onClick={apply}>Edit & apply</Primary>
        <Button
          kind="danger"
          onClick={() => runtime.discardReview(item.id).then(refresh)}
        >
          Discard
        </Button>
      </Actions>
    </Card>
  );
}
function Settings({
  context,
  runtime,
  prefs,
  refresh,
}: {
  context: TavernContext;
  runtime: RpStateMachine;
  prefs: ReturnType<typeof preferences>;
  refresh: () => void;
}) {
  const [profiles, setProfiles] = useState<ConnectionProfile[]>([]);
  const refreshProfiles = useCallback(() => {
    try {
      setProfiles(
        context.ConnectionManagerRequestService?.getSupportedProfiles() ?? [],
      );
    } catch {
      setProfiles([]);
    }
  }, [context]);
  useEffect(() => {
    refreshProfiles();
    const subscriptions: Array<() => void> = [];
    for (const key of [
      'CONNECTION_PROFILE_CREATED',
      'CONNECTION_PROFILE_UPDATED',
      'CONNECTION_PROFILE_DELETED',
    ]) {
      const type = context.eventTypes[key];
      if (!type) continue;
      context.eventSource.on(type, refreshProfiles);
      subscriptions.push(() => {
        if (context.eventSource.off)
          context.eventSource.off(type, refreshProfiles);
        else context.eventSource.removeListener?.(type, refreshProfiles);
      });
    }
    return () => subscriptions.forEach((unsubscribe) => unsubscribe());
  }, [context, refreshProfiles]);
  const update = (patch: Partial<typeof prefs>) => {
    context.extensionSettings.rp_state_machine = { ...prefs, ...patch };
    context.saveSettingsDebounced?.();
    refresh();
  };
  const exportState = () => {
    const blob = new Blob([JSON.stringify(getContainer(context), null, 2)], {
      type: 'application/json',
    });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'rp-state-machine.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 0);
  };
  const importState = async (file?: File) => {
    if (!file || !confirm('Replace this chat state from the selected JSON?'))
      return;
    try {
      await runtime.importState(JSON.parse(await file.text()));
      refresh();
    } catch (error) {
      alert(`Import rejected: ${String(error)}`);
    }
  };
  const reseed = () => {
    if (!confirm('Reseed from the current state and discard replay history?'))
      return;
    const c = getContainer(context);
    if (c) runtime.seed(c.currentState).then(refresh);
  };
  return (
    <>
      <Card title="Behavior">
        <label className="rpstate-check">
          <input
            type="checkbox"
            checked={!prefs.paused}
            onChange={(e) => update({ paused: !e.target.checked })}
          />
          Extract changes
        </label>
        <label className="rpstate-check">
          <input
            type="checkbox"
            checked={prefs.injectionEnabled}
            onChange={(e) => update({ injectionEnabled: e.target.checked })}
          />
          Prompt injection
        </label>
        <label>
          Snapshot ceiling
          <input
            type="number"
            value={prefs.tokenCeiling}
            min="100"
            onChange={(e) => update({ tokenCeiling: Number(e.target.value) })}
          />
        </label>
        <label className="rpstate-check">
          <input
            type="checkbox"
            checked={prefs.debug}
            onChange={(e) => update({ debug: e.target.checked })}
          />
          Debug logging
        </label>
      </Card>
      <Card title="State extraction model">
        <label>
          Connection profile
          <select
            value={prefs.stateAgentProfileId ?? ''}
            onChange={(event) =>
              update({ stateAgentProfileId: event.target.value || null })
            }
          >
            <option value="">Current active connection (legacy)</option>
            {prefs.stateAgentProfileId &&
              !profiles.some((x) => x.id === prefs.stateAgentProfileId) && (
                <option value={prefs.stateAgentProfileId} disabled>
                  Previously selected profile — unavailable
                </option>
              )}
            {profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name}
                {profile.model ? ` — ${profile.model}` : ''}
              </option>
            ))}
          </select>
        </label>
        <label>
          Maximum output tokens
          <input
            type="number"
            min="128"
            max="4096"
            step="1"
            value={prefs.stateAgentMaxTokens}
            onChange={(event) =>
              update({ stateAgentMaxTokens: Number(event.target.value) })
            }
          />
        </label>
        <p className="rpstate-muted">
          Choose a fast, literal profile with reasoning disabled. Narration
          continues using SillyTavern's active connection.
        </p>
      </Card>
      <Card title="Import & export">
        <Actions>
          <Button kind="secondary" onClick={exportState}>
            Export JSON
          </Button>
        </Actions>
        <label>
          Import JSON
          <input
            type="file"
            accept="application/json"
            onChange={(e) => importState(e.target.files?.[0])}
          />
        </label>
      </Card>
      <Card title="Danger zone" className="rpstate-danger-zone">
        <p>These actions replace or discard stored state for this chat.</p>
        <Actions>
          <Button kind="danger" onClick={reseed}>
            Reseed current state
          </Button>
          <Button
            kind="danger"
            onClick={() => {
              if (confirm('Reset the state for this chat?'))
                runtime.resetState().then(refresh);
            }}
          >
            Reset state
          </Button>
          <Button onClick={() => runtime.command('replay')}>Replay</Button>
        </Actions>
      </Card>
    </>
  );
}
