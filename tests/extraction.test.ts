import { describe, expect, it, vi } from 'vitest';
import {
  extract,
  extractionPrompt,
  parseExtraction,
  validateExtraction,
} from '../src/extraction';
import { emptyState } from '../src/persistence';
const agentFrom = (generate: ReturnType<typeof vi.fn>) => ({ generate });
const options = { maxTokens: 512 };
describe('extraction protocol', () => {
  it('includes group speaker identity without relying on characterId', () =>
    expect(
      extractionPrompt(emptyState('2026-01-01T00:00', 'Inn'), {
        user: 'Hi',
        userSpeaker: 'Player',
        assistant: 'Hello',
        assistantSpeaker: 'Duplicate Name',
      }),
    ).toContain('ASSISTANT TURN (Duplicate Name)'));
  it('parses valid JSON and semantically validates it', () => {
    const result = parseExtraction(
      '{"events":[{"type":"location.set","location":"Docks"}],"explanation":"They arrive."}',
    );
    expect(
      validateExtraction(emptyState('2026-01-01T00:00', 'Inn'), result).world
        .location,
    ).toBe('Docks');
  });
  it('rejects malformed and empty structured output', () => {
    expect(() => parseExtraction('{}')).toThrow(/empty/);
    expect(() => parseExtraction('no json')).toThrow();
  });
  it('uses JSON-only fallback once', async () => {
    const generate = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce('{"events":[],"explanation":"none"}');
    const result = await extract(
      agentFrom(generate),
      emptyState('2026-01-01T00:00', 'Inn'),
      { assistant: 'Nothing happens.' },
      options,
    );
    expect(result.events).toEqual([]);
    expect(generate).toHaveBeenCalledTimes(2);
  });
  it('accepts fenced JSON and sends SillyTavern jsonSchema wrapper', async () => {
    const generate = vi
      .fn()
      .mockResolvedValue('```json\n{"events":[],"explanation":"none"}\n```');
    await extract(
      agentFrom(generate),
      emptyState('2026-01-01T00:00', 'Inn'),
      {
        assistant: 'Nothing.',
      },
      options,
    );
    expect(generate.mock.calls[0][0].jsonSchema).toMatchObject({
      name: 'rp_state_events',
      strict: true,
      value: { additionalProperties: false },
    });
    expect(generate.mock.calls[0][0].maxTokens).toBe(512);
  });
  it('keeps unknown references out of committed state', () => {
    const result = parseExtraction(
      '{"events":[{"type":"relationship.adjust","character":"Nobody","amount":1,"reason":"x"}],"explanation":"x"}',
    );
    expect(() =>
      validateExtraction(emptyState('2026-01-01T00:00', 'Inn'), result),
    ).toThrow(/Unknown/);
  });
  it('rejects manual-only character.set extractor events', () =>
    expect(() =>
      parseExtraction(
        '{"events":[{"type":"character.set","id":"mira","displayName":"Mira","aliases":[],"conditions":[]}],"explanation":"x"}',
      ),
    ).toThrow(/manual/i));
  it('reports unsupported structured output when fallback also fails', async () => {
    const generate = vi.fn().mockResolvedValue('not json');
    await expect(
      extract(
        agentFrom(generate),
        emptyState('2026-01-01T00:00', 'Inn'),
        {
          assistant: 'x',
        },
        options,
      ),
    ).rejects.toThrow(/fallback failed/);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate.mock.calls[1][0].maxTokens).toBe(512);
  });
  it('does not retry a provider rejection', async () => {
    const generate = vi
      .fn()
      .mockRejectedValue(new Error('authentication failed'));
    await expect(
      extract(
        agentFrom(generate),
        emptyState('2026-01-01T00:00', 'Inn'),
        { assistant: 'x' },
        options,
      ),
    ).rejects.toThrow('authentication failed');
    expect(generate).toHaveBeenCalledTimes(1);
  });
});
