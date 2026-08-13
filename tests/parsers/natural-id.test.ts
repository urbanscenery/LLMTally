import { describe, expect, test } from 'bun:test';

import { buildNaturalId } from '@llmtally/core/parsers/claude-code/natural-id.ts';
import type { NaturalIdContext } from '@llmtally/core/parsers/claude-code/natural-id.ts';
import type { ClaudeUsageRecord } from '@llmtally/core/parsers/claude-code/records.ts';

function usageRecord(overrides: Partial<ClaudeUsageRecord>): ClaudeUsageRecord {
  return {
    kind: 'usage',
    uuid: 'a1',
    messageId: null,
    parentUuid: null,
    isSidechain: false,
    tsUtc: 1_785_578_405,
    model: 'claude-fable-5',
    effort: null,
    requestId: 'req_001',
    sessionId: 'sess-1',
    cwd: null,
    inputTokens: 1,
    outputTokens: 1,
    cacheWrite: 0,
    cacheRead: 0,
    ...overrides,
  };
}

const context: NaturalIdContext = {
  fingerprint: { device: 10, inode: 42, headSha256: 'sha256:h', tailSha256: 'sha256:t' },
  path: '/tmp/session.jsonl',
  lineStartOffset: 128,
};

describe('buildNaturalId', () => {
  test('prefers the API message id so block lines of one message collapse', () => {
    // Arrange — two lines of the same assistant message differ in uuid
    // but share message.id; both must map to the same natural id
    const firstBlock = usageRecord({ uuid: 'a1', messageId: 'msg_001' });
    const secondBlock = usageRecord({ uuid: 'a2', messageId: 'msg_001' });

    // Act & Assert
    expect(buildNaturalId(firstBlock, context)).toBe('msg:msg_001');
    expect(buildNaturalId(secondBlock, context)).toBe('msg:msg_001');
  });

  test('falls back to the line uuid when there is no message id', () => {
    // Act & Assert
    expect(buildNaturalId(usageRecord({}), context)).toBe('a1');
  });

  test('namespaces the requestId fallback with session and offset', () => {
    // Act
    const id = buildNaturalId(usageRecord({ uuid: null }), context);

    // Assert
    expect(id).toBe('request:req_001:session:sess-1:offset:128');
  });

  test('falls back to file identity when the session id is also missing', () => {
    // Act
    const id = buildNaturalId(usageRecord({ uuid: null, sessionId: null }), context);

    // Assert
    expect(id).toBe('request:req_001:file:10:42:offset:128');
  });

  test('uses the path when no fingerprint identity exists', () => {
    // Act
    const id = buildNaturalId(usageRecord({ uuid: null, sessionId: null }), {
      ...context,
      fingerprint: null,
    });

    // Assert
    expect(id).toBe('request:req_001:file:/tmp/session.jsonl:offset:128');
  });

  test('returns null when neither uuid nor requestId exists', () => {
    // Act & Assert
    expect(buildNaturalId(usageRecord({ uuid: null, requestId: null }), context)).toBeNull();
  });

  test('same record rescanned at the same offset produces the same id', () => {
    // Arrange
    const record = usageRecord({ uuid: null });

    // Act & Assert
    expect(buildNaturalId(record, context)).toBe(buildNaturalId(record, context));
  });
});
