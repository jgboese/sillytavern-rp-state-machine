import { describe, expect, it } from 'vitest';
import { normalizeStateAgentMaxTokens } from '../src/persistence';

describe('state-agent token limit normalization', () => {
  it('uses the safe default for corrupt persisted values', () => {
    expect(normalizeStateAgentMaxTokens(Number.NaN)).toBe(512);
    expect(normalizeStateAgentMaxTokens(Number.POSITIVE_INFINITY)).toBe(512);
    expect(normalizeStateAgentMaxTokens('512')).toBe(512);
    expect(normalizeStateAgentMaxTokens(undefined)).toBe(512);
  });
  it('bounds and integer-normalizes finite numeric values', () => {
    expect(normalizeStateAgentMaxTokens(127.9)).toBe(128);
    expect(normalizeStateAgentMaxTokens(512.8)).toBe(512);
    expect(normalizeStateAgentMaxTokens(9000)).toBe(4096);
  });
});
