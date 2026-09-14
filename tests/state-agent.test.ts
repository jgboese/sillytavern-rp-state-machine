import { describe, expect, it, vi } from 'vitest';
import {
  ActiveConnectionStateAgent,
  ConnectionProfileStateAgent,
  StateAgentConfigurationError,
  StateAgentTransportError,
  createStateAgent,
} from '../src/state-agent';
import { EXTRACTION_JSON_SCHEMA } from '../src/schema';

const request = {
  prompt: 'turn',
  systemPrompt: 'system',
  jsonSchema: EXTRACTION_JSON_SCHEMA,
  maxTokens: 321,
};
const context = (service?: any) =>
  ({
    generateRaw: vi.fn().mockResolvedValue('{}'),
    ConnectionManagerRequestService: service,
  }) as any;

describe('state agents', () => {
  it('maps active-connection requests to generateRaw', async () => {
    const ctx = context();
    await new ActiveConnectionStateAgent(ctx).generate(request);
    expect(ctx.generateRaw).toHaveBeenCalledWith({
      prompt: 'turn',
      systemPrompt: 'system',
      jsonSchema: EXTRACTION_JSON_SCHEMA,
      responseLength: 321,
      signal: undefined,
    });
  });
  it('uses the chosen profile without calling the narrator', async () => {
    const service = {
      getSupportedProfiles: vi.fn(() => [
        { id: 'state', name: 'State', model: 'm' },
      ]),
      sendRequest: vi.fn().mockResolvedValue({ content: { events: [] } }),
    };
    const ctx = context(service);
    await new ConnectionProfileStateAgent(ctx, 'state').generate(request);
    expect(ctx.generateRaw).not.toHaveBeenCalled();
    expect(service.sendRequest).toHaveBeenCalledWith(
      'state',
      [
        { role: 'system', content: 'system' },
        { role: 'user', content: 'turn' },
      ],
      321,
      expect.objectContaining({
        stream: false,
        extractData: true,
        includePreset: true,
        includeInstruct: true,
      }),
      { temperature: 0, json_schema: EXTRACTION_JSON_SCHEMA },
    );
  });
  it('fails explicitly for unavailable services, profiles, and streaming responses', async () => {
    await expect(
      new ConnectionProfileStateAgent(context(), 'state').generate(request),
    ).rejects.toBeInstanceOf(StateAgentConfigurationError);
    const missing = context({
      getSupportedProfiles: () => [],
      sendRequest: vi.fn(),
    });
    await expect(
      new ConnectionProfileStateAgent(missing, 'state').generate(request),
    ).rejects.toBeInstanceOf(StateAgentConfigurationError);
    const streaming = context({
      getSupportedProfiles: () => [{ id: 'state', name: 'State' }],
      sendRequest: vi.fn().mockResolvedValue(() => (async function* () {})()),
    });
    await expect(
      new ConnectionProfileStateAgent(streaming, 'state').generate(request),
    ).rejects.toBeInstanceOf(StateAgentTransportError);
  });
  it('uses active connection only for null selection', () => {
    const ctx = context();
    expect(createStateAgent(ctx, null)).toBeInstanceOf(
      ActiveConnectionStateAgent,
    );
    expect(createStateAgent(ctx, 'missing')).toBeInstanceOf(
      ConnectionProfileStateAgent,
    );
  });
  it('returns profile content unchanged for both JSON strings and parsed objects', async () => {
    const service = {
      getSupportedProfiles: () => [{ id: 'state', name: 'State' }],
      sendRequest: vi
        .fn()
        .mockResolvedValueOnce({ content: '{"events":[]}' })
        .mockResolvedValueOnce({ content: { events: [] } }),
    };
    const agent = new ConnectionProfileStateAgent(context(service), 'state');
    await expect(agent.generate(request)).resolves.toBe('{"events":[]}');
    await expect(agent.generate(request)).resolves.toEqual({ events: [] });
  });
});
