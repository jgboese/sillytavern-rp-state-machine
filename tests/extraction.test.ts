import { describe, expect, it, vi } from 'vitest';
import {
  extract,
  extractionPrompt,
  parseExtraction,
  validateExtraction,
} from '../src/extraction';
import { emptyState } from '../src/persistence';
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
    const generateRaw = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce('{"events":[],"explanation":"none"}');
    const result = await extract(
      { generateRaw },
      emptyState('2026-01-01T00:00', 'Inn'),
      { assistant: 'Nothing happens.' },
    );
    expect(result.events).toEqual([]);
    expect(generateRaw).toHaveBeenCalledTimes(2);
  });
  it('accepts fenced JSON and sends SillyTavern jsonSchema wrapper', async () => {
    const generateRaw = vi
      .fn()
      .mockResolvedValue('```json\n{"events":[],"explanation":"none"}\n```');
    await extract({ generateRaw }, emptyState('2026-01-01T00:00', 'Inn'), {
      assistant: 'Nothing.',
    });
    expect(generateRaw.mock.calls[0][0].jsonSchema).toMatchObject({
      name: 'rp_state_events',
      strict: true,
      value: { additionalProperties: false },
    });
    expect(generateRaw.mock.calls[0][0].responseLength).toBe(512);
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
    const generateRaw = vi.fn().mockResolvedValue('not json');
    await expect(
      extract({ generateRaw }, emptyState('2026-01-01T00:00', 'Inn'), {
        assistant: 'x',
      }),
    ).rejects.toThrow(/fallback failed/);
    expect(generateRaw).toHaveBeenCalledTimes(2);
    expect(generateRaw.mock.calls[1][0].responseLength).toBe(512);
  });
});
