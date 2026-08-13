import { describe, expect, test } from 'bun:test';

import {
  classifyClaudeLine,
  isCandidateLine,
} from '@llmtally/core/parsers/claude-code/records.ts';
import { asTokenCount } from '@llmtally/core/parsers/shared.ts';

function usageLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'assistant',
    uuid: 'a1',
    parentUuid: 'u1',
    isSidechain: false,
    sessionId: 'sess-1',
    cwd: '/tmp/proj',
    timestamp: '2026-08-01T10:00:05.000Z',
    requestId: 'req_001',
    effort: 'high',
    message: {
      role: 'assistant',
      model: 'claude-fable-5',
      usage: {
        input_tokens: 12,
        cache_creation_input_tokens: 100,
        cache_read_input_tokens: 200,
        output_tokens: 34,
      },
    },
    ...overrides,
  });
}

describe('isCandidateLine', () => {
  test('accepts usage lines and user lines but rejects unrelated records', () => {
    // Arrange & Act & Assert
    expect(isCandidateLine(usageLine())).toBe(true);
    expect(isCandidateLine('{"type":"user","message":{}}')).toBe(true);
    expect(isCandidateLine('{"type":"summary","summary":"..."}')).toBe(false);
  });
});

describe('classifyClaudeLine', () => {
  test('maps a full assistant usage record including effort and cache tokens', () => {
    // Act
    const record = classifyClaudeLine(usageLine());

    // Assert
    expect(record).toEqual({
      kind: 'usage',
      uuid: 'a1',
      parentUuid: 'u1',
      isSidechain: false,
      tsUtc: 1_785_578_405,
      model: 'claude-fable-5',
      effort: 'high',
      requestId: 'req_001',
      sessionId: 'sess-1',
      cwd: '/tmp/proj',
      inputTokens: 12,
      outputTokens: 34,
      cacheWrite: 100,
      cacheRead: 200,
    });
  });

  test('extracts string prompts from user records', () => {
    // Arrange
    const line = JSON.stringify({
      type: 'user',
      uuid: 'u1',
      parentUuid: null,
      isSidechain: false,
      message: { role: 'user', content: 'plain question' },
    });

    // Act
    const record = classifyClaudeLine(line);

    // Assert
    expect(record).toEqual({
      kind: 'user',
      uuid: 'u1',
      parentUuid: null,
      isSidechain: false,
      promptText: 'plain question',
    });
  });

  test('joins only text blocks from array content', () => {
    // Arrange
    const line = JSON.stringify({
      type: 'user',
      uuid: 'u2',
      message: {
        content: [
          { type: 'text', text: 'first part' },
          { type: 'tool_result', content: 'noise' },
          { type: 'text', text: 'second part' },
        ],
      },
    });

    // Act
    const record = classifyClaudeLine(line);

    // Assert
    expect(record).toMatchObject({ kind: 'user', promptText: 'first part\nsecond part' });
  });

  test('skips meta and system-like user records', () => {
    // Arrange
    const metaLine = JSON.stringify({
      type: 'user',
      isMeta: true,
      message: { content: 'bookkeeping' },
    });
    const systemLine = JSON.stringify({
      type: 'user',
      message: { content: '  <system-reminder>hidden</system-reminder>' },
    });

    // Act & Assert
    expect(classifyClaudeLine(metaLine)).toEqual({ kind: 'skipped' });
    expect(classifyClaudeLine(systemLine)).toEqual({ kind: 'skipped' });
  });

  test('skips assistant records without a usage object', () => {
    // Arrange
    const line = JSON.stringify({
      type: 'assistant',
      message: { model: 'claude-fable-5', content: 'mentions "usage" only in text' },
    });

    // Act & Assert
    expect(classifyClaudeLine(line)).toEqual({ kind: 'skipped' });
  });

  test('rejects usage records with missing model or invalid timestamp or bad tokens', () => {
    // Act
    const noModel = classifyClaudeLine(usageLine({ message: { usage: { input_tokens: 1 } } }));
    const badTimestamp = classifyClaudeLine(usageLine({ timestamp: 'not-a-date' }));
    const badTokens = classifyClaudeLine(
      usageLine({
        message: {
          model: 'claude-fable-5',
          usage: { input_tokens: -5, output_tokens: 1 },
        },
      }),
    );

    // Assert
    expect(noModel.kind).toBe('invalid');
    expect(badTimestamp.kind).toBe('invalid');
    expect(badTokens.kind).toBe('invalid');
  });

  test('treats missing token fields as zero', () => {
    // Act
    const record = classifyClaudeLine(
      usageLine({
        message: { model: 'claude-fable-5', usage: { output_tokens: 7 } },
      }),
    );

    // Assert
    expect(record).toMatchObject({ kind: 'usage', inputTokens: 0, cacheWrite: 0, cacheRead: 0, outputTokens: 7 });
  });

  test('reports malformed json with a fixed reason that never quotes source tokens', () => {
    // Act
    const record = classifyClaudeLine('{"secret_prompt": leaked_token_here}');

    // Assert
    expect(record).toEqual({ kind: 'malformed', reason: 'line is not parseable as JSON' });
  });

  test('rejects timestamps without an explicit utc designator or offset', () => {
    // Act — offset-less ISO strings parse as LOCAL time and must not slip in
    const record = classifyClaudeLine(usageLine({ timestamp: '2026-08-01T10:00:05.000' }));

    // Assert
    expect(record.kind).toBe('invalid');
  });

  test('accepts timestamps with an explicit numeric offset', () => {
    // Act
    const record = classifyClaudeLine(usageLine({ timestamp: '2026-08-01T19:00:05.000+09:00' }));

    // Assert
    expect(record).toMatchObject({ kind: 'usage', tsUtc: 1_785_578_405 });
  });
});

describe('asTokenCount bounds', () => {
  test('rejects values past MAX_SAFE_INTEGER instead of poisoning sums', () => {
    expect(asTokenCount(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
    expect(asTokenCount(Number.MAX_SAFE_INTEGER + 2)).toBeNull();
    expect(asTokenCount(1e300)).toBeNull();
  });
});
