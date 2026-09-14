# Separate Narrator and State Agent Implementation Plan

This plan is implemented by a `gpt-5.6-terra` agent with medium reasoning effort and reviewed by the primary agent.

## 1. Target Architecture

Keep SillyTavern's active connection responsible for narration while routing state extraction through an independently selected Connection Manager profile:

```text
Active SillyTavern connection
          |
          v
      Narrator LLM
          | prose
          v
     SillyTavern chat
          |
          v
Configured state profile
          | StateEvent[] JSON
          v
 Zod -> reducer -> canonical state
          |
          v
  Next narrator injection
```

Do not change the canonical-state schema, deterministic reducer, transaction history, replay behavior, fingerprinting, or prompt-injection ownership.

## 2. Implementation Steps

### Step 1: Define the state-agent boundary

Create `src/state-agent.ts` and replace the current `RawGenerator` abstraction with request types that do not expose SillyTavern-specific option names:

```ts
export interface StateAgentRequest {
  prompt: string;
  systemPrompt: string;
  jsonSchema?: StructuredOutputSchema;
  maxTokens: number;
  signal?: AbortSignal;
}

export interface StateAgent {
  generate(request: StateAgentRequest): Promise<unknown>;
}
```

Add the minimum local types required for Connection Manager:

```ts
export interface ConnectionProfile {
  id: string;
  name: string;
  api?: string;
  model?: string;
}

export interface ConnectionManagerResponse {
  content: unknown;
  reasoning?: string;
}

export interface ConnectionManagerRequestService {
  getSupportedProfiles(): ConnectionProfile[];

  sendRequest(
    profileId: string,
    prompt: Array<{
      role: 'system' | 'user' | 'assistant';
      content: string;
    }>,
    maxTokens: number,
    options?: {
      stream?: boolean;
      signal?: AbortSignal | null;
      extractData?: boolean;
      includePreset?: boolean;
      includeInstruct?: boolean;
    },
    overridePayload?: Record<string, unknown>,
  ): Promise<ConnectionManagerResponse | (() => AsyncGenerator<unknown>)>;
}
```

Extend `TavernContext` with an optional `ConnectionManagerRequestService` property so tests and unavailable-service handling remain explicit.

### Step 2: Implement both adapters

The backward-compatible adapter maps the new request into the existing `generateRaw()` API:

```ts
export class ActiveConnectionStateAgent implements StateAgent {
  constructor(private readonly context: TavernContext) {}

  generate(request: StateAgentRequest): Promise<unknown> {
    return this.context.generateRaw({
      prompt: request.prompt,
      systemPrompt: request.systemPrompt,
      jsonSchema: request.jsonSchema,
      responseLength: request.maxTokens,
      signal: request.signal,
    });
  }
}
```

The profile adapter sends the same logical request through the selected profile without switching the active narrator:

```ts
export class ConnectionProfileStateAgent implements StateAgent {
  constructor(
    private readonly context: TavernContext,
    private readonly profileId: string,
  ) {}

  async generate(request: StateAgentRequest): Promise<unknown> {
    const service = this.context.ConnectionManagerRequestService;

    if (!service) {
      throw new StateAgentConfigurationError(
        'Connection Manager request service is unavailable.',
      );
    }

    if (
      !service
        .getSupportedProfiles()
        .some((profile) => profile.id === this.profileId)
    ) {
      throw new StateAgentConfigurationError(
        `State connection profile is unavailable: ${this.profileId}`,
      );
    }

    const result = await service.sendRequest(
      this.profileId,
      [
        { role: 'system', content: request.systemPrompt },
        { role: 'user', content: request.prompt },
      ],
      request.maxTokens,
      {
        stream: false,
        extractData: true,
        includePreset: true,
        includeInstruct: true,
        signal: request.signal ?? null,
      },
      {
        temperature: 0,
        json_schema: request.jsonSchema,
      },
    );

    if (typeof result === 'function') {
      throw new StateAgentTransportError(
        'State connection unexpectedly returned a streaming response.',
      );
    }

    return result.content;
  }
}
```

Use explicit error classes and a resolver:

```ts
export class StateAgentConfigurationError extends Error {}
export class StateAgentTransportError extends Error {}
export class StateAgentOutputError extends Error {}

export function createStateAgent(
  context: TavernContext,
  profileId: string | null,
): StateAgent {
  return profileId
    ? new ConnectionProfileStateAgent(context, profileId)
    : new ActiveConnectionStateAgent(context);
}
```

A configured but invalid profile must throw. Only `null` selects the active narrator connection.

### Step 3: Add backward-compatible preferences

Extend `Preferences`:

```ts
export interface Preferences {
  paused: boolean;
  injectionEnabled: boolean;
  tokenCeiling: number;
  debug: boolean;
  stateAgentProfileId: string | null;
  stateAgentMaxTokens: number;
}

export const DEFAULT_PREFERENCES: Preferences = {
  paused: false,
  injectionEnabled: true,
  tokenCeiling: 1500,
  debug: false,
  stateAgentProfileId: null,
  stateAgentMaxTokens: 512,
};
```

Continue merging stored partial settings over these defaults. Do not change `RpStateContainer` or increment its schema version.

Normalize the extraction limit before use:

```ts
export function normalizeStateAgentMaxTokens(value: number): number {
  return Math.min(4096, Math.max(128, Math.trunc(value)));
}
```

### Step 4: Refactor extraction and retry handling

Change extraction to accept `StateAgent` and an explicit token limit:

```ts
export async function extract(
  agent: StateAgent,
  state: GameState,
  turn: RpTurn,
  options: { maxTokens: number; signal?: AbortSignal },
): Promise<Extraction>;
```

Construct the first request using the existing prompt and schema:

```ts
const firstRequest: StateAgentRequest = {
  prompt: extractionPrompt(state, turn),
  systemPrompt: 'You are a precise RP state extractor.',
  jsonSchema: EXTRACTION_JSON_SCHEMA,
  maxTokens: options.maxTokens,
  signal: options.signal,
};
```

Apply this retry policy:

```text
Generate response
    |
    +-- Configuration/network/provider failure
    |       +-- Stop immediately and create a review item
    |
    +-- Response received
            |
            +-- Parses and validates
            |       +-- Return extraction
            |
            +-- Malformed/empty output
                    +-- Retry once through the same StateAgent
```

The fallback request omits structured-output enforcement but retains the same agent:

```ts
const fallbackRequest: StateAgentRequest = {
  prompt: `${prompt}\nJSON ONLY. No markdown or prose.`,
  systemPrompt: 'Return exactly one JSON object.',
  maxTokens: options.maxTokens,
  signal: options.signal,
};
```

Do not retry configuration, transport, abort, authentication, network, or provider failures. Continue truncating rejected raw output before storing it in the review queue.

### Step 5: Route reconciliation through the selected agent

At reconciliation start:

```ts
const prefs = preferences(ctx);
const agent = createStateAgent(ctx, prefs.stateAgentProfileId);
const maxTokens = normalizeStateAgentMaxTokens(prefs.stateAgentMaxTokens);
```

Replace the current extraction call with:

```ts
const result = await extract(
  agent,
  state,
  {
    user: priorUserMessage?.mes,
    userSpeaker: priorUserMessage?.name,
    assistant: String(ctx.chat[i].mes ?? ''),
    assistantSpeaker: ctx.chat[i].name,
  },
  {
    maxTokens,
    signal: abortController.signal,
  },
);
```

Resolve the agent once per reconciliation batch. Preserve the current chat-ID, revision, and fingerprint checks before committing. Abort an in-flight profile request when the extension stops, the active chat changes, or a new revision invalidates reconciliation. Profile failures enter the existing review queue and never mutate state.

### Step 6: Add the Settings UI

Add a “State extraction model” card:

```tsx
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
    Choose a fast, literal profile with reasoning disabled. Narration continues
    using SillyTavern's active connection.
  </p>
</Card>
```

Populate the selector with `getSupportedProfiles()`, catching service errors so a disabled Connection Manager does not crash the drawer. Subscribe to `CONNECTION_PROFILE_CREATED`, `CONNECTION_PROFILE_UPDATED`, and `CONNECTION_PROFILE_DELETED`, and remove each listener during cleanup.

If the configured profile is absent, show a disabled “Previously selected profile — unavailable” option. Do not automatically clear or replace it.

### Step 7: Update documentation and distribution

Update the README to explain separate narrator/state profiles, backward-compatible fallback, reasoning guidance, missing-profile behavior, Connection Manager credential ownership, and cross-provider authentication caveats.

Set the extension version to `0.2.0`, retain SillyTavern `1.18.0` as the minimum version, and rebuild committed `dist/index.js`.

## 3. Tests and Acceptance Criteria

Add tests proving:

- The active adapter maps requests to `generateRaw()` correctly.
- The profile adapter passes the profile ID, messages, limit, options, temperature, and `json_schema`.
- Profile responses normalize string and parsed-object `content`.
- Streaming, missing service, and missing profile cases fail explicitly.
- No selected profile retains existing behavior.
- A selected profile never calls `generateRaw()`.
- Malformed output retries once through the same profile.
- Provider failures are not retried.
- Missing configured profiles never fall back to the narrator.
- Existing replay, swipe, edit, deletion, manual correction, and race tests continue passing.
- UI selection, token limits, profile refresh, and listener cleanup work.

Manual smoke tests cover Chat Completion, Text Completion, same-provider and cross-provider configurations, deleted profiles, disabled Connection Manager, chat switches, and extension shutdown during extraction.

Completion requires:

```powershell
npm test
npm run typecheck
npm run lint
npm run format:check
npm run build
git diff --check
```

The primary-agent review checks for no active-profile switching, credential storage or logging, silent fallback, canonical-state schema changes, listener leaks, abort leaks, or unrelated modifications.

## 4. Delegation and Handoff

1. The primary agent saves this plan.
2. The primary agent spawns one `gpt-5.6-terra` implementation agent with medium reasoning.
3. The Terra agent implements source, tests, documentation, version metadata, and the production bundle.
4. The Terra agent runs the full verification suite and reports anything requiring manual SillyTavern testing.
5. The primary agent reviews the complete diff and reruns appropriate checks.
6. The primary agent delivers changed-file links, verification results, and remaining manual smoke checks.

## Assumptions

- The selected profile governs provider, model, credentials, preset, and instruct formatting.
- Temperature is overridden to `0`; provider-specific reasoning fields are not injected.
- Reasoning is disabled by configuring the chosen SillyTavern profile.
- The extractor proposes events; Zod and the reducer remain authoritative.
- Profile selection is extension-wide, while canonical state remains per chat.
- No server plugin, database, credential UI, or pre-narration simulation phase is introduced.
