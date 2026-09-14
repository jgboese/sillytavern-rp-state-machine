import type { EXTRACTION_JSON_SCHEMA } from './schema';
import type { TavernContext } from './runtime';

export type StructuredOutputSchema = typeof EXTRACTION_JSON_SCHEMA;

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
    prompt: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
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

export class StateAgentConfigurationError extends Error {}
export class StateAgentTransportError extends Error {}
export class StateAgentOutputError extends Error {}

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

export class ConnectionProfileStateAgent implements StateAgent {
  constructor(
    private readonly context: TavernContext,
    private readonly profileId: string,
  ) {}

  async generate(request: StateAgentRequest): Promise<unknown> {
    const service = this.context.ConnectionManagerRequestService;
    if (!service)
      throw new StateAgentConfigurationError(
        'Connection Manager request service is unavailable.',
      );
    if (!service.getSupportedProfiles().some((x) => x.id === this.profileId))
      throw new StateAgentConfigurationError(
        `State connection profile is unavailable: ${this.profileId}`,
      );
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
      { temperature: 0, json_schema: request.jsonSchema },
    );
    if (typeof result === 'function')
      throw new StateAgentTransportError(
        'State connection unexpectedly returned a streaming response.',
      );
    return result.content;
  }
}

export function createStateAgent(
  context: TavernContext,
  profileId: string | null,
): StateAgent {
  return profileId
    ? new ConnectionProfileStateAgent(context, profileId)
    : new ActiveConnectionStateAgent(context);
}
