# RP State Machine

A self-contained SillyTavern 1.18.0 UI extension that maintains an auditable,
per-chat canonical roleplay state. It uses only the active SillyTavern
connection and `chatMetadata`; there is no server plugin, database,
localStorage canonical data, or separate credential.

## Install

In SillyTavern 1.18.0 or newer, open **Extensions**, choose **Install
Extension**, and paste:

```text
https://github.com/jgboese/sillytavern-rp-state-machine
```

SillyTavern downloads the committed `dist/index.js`; users do not need Node.js
or a separate build step.

## Build from source

This repository started from SillyTavern's official React/Webpack extension
template. For development, install dependencies and rebuild the distributable:

```sh
npm install
npm run build
```

The distributable is `dist/index.js`. The manifest declares
`minimum_client_version: 1.18.0` and the `rpStateMachineGenerationInterceptor`
generation interceptor.

## Use

Open **State** in the toolbar (or `/rpstate`). Confirm an initial local
Gregorian date/time and location; this creates an explicit baseline. The
extension will then, after normal generation ends, invisibly ask the active
connection to emit a constrained JSON event list. Zod and the deterministic
reducer validate the whole transaction before state can change. Invalid output
is kept in **History & Review** and cannot mutate state.

`/rpstate pause`, `/rpstate resume`, `/rpstate retry`, and `/rpstate replay`
are also available. Settings can pause extraction, disable prompt injection,
set the snapshot token ceiling (default 1,500), enable debug preference,
export/import complete-schema-validated JSON, reseed, or reset the chat state.
Every destructive state replacement is confirmation-gated. Manual edits are
append-only, auditable transactions.

The next ordinary RP generation receives a depth-zero system snapshot. It is
not injected for unseeded, paused, quiet, or impersonation generations. When
the snapshot exceeds the ceiling, world/currency/player-condition data stays
first, followed by the most recently changed inventory/character detail that
fits, plus an explicit truncation marker.

## Safety and replay

Messages use SHA-256 fingerprints of ordered role, speaker, text, and active
swipe. An edit, deletion, or swipe restores the seed and unchanged transaction
prefix, then re-extracts affected assistant turns behind one mutex. The chat ID
and message context are checked again before an extraction can commit. A change
before the seed is marked `needs-reseed`, because the manual baseline is no
longer trustworthy. Duplicate display names are never identifiers: references
must resolve by stable ID or a single normalized name/alias. Reducer transitions
use immutable copy-on-write state, so a rejected transaction cannot partially
mutate its input.

## Manual SillyTavern 1.18.0 smoke checklist

1. Seed a solo chat, reload the page, and confirm the state remains intact.
2. Generate an assistant reply that clearly gains currency; verify one hidden
   extraction and one automatic transaction, then inspect the next prompt.
3. Return malformed extractor JSON; verify state is untouched and a review
   item appears.
4. Create and select a swipe, edit an assistant message, and delete a message;
   compare the rebuilt state with a fresh replay from the seed.
5. Repeat in a group chat with duplicate display names and one member without a
   `characterId`; only unique aliases or stable IDs should resolve.
6. Switch chats while an extraction is running; confirm neither chat receives
   the other's transaction. Disable the extension and confirm its injection and
   event listeners are removed.

## Development

`npm run format:check` verifies Prettier formatting and `npm run lint` runs
ESLint's recommended JavaScript/TypeScript and React Hooks checks. `npm test` runs Vitest/React Testing Library checks for reducer atomicity and
every event type, extraction fallback/diagnostics, replay after edits, swipes,
and deletions, manual ordering, chat-switch races, persistence isolation,
prompt truncation, and drawer synchronization. `npm run typecheck` and
`npm run build` should both pass before installation.
