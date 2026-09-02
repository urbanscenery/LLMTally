import { describe, expect, test } from 'bun:test';

import {
  classifyCursorCliLine,
  cursorCliProviderFromModel,
  isCursorCliCandidateLine,
  usageTokenSum,
} from '@llmtally/core/parsers/cursor-cli/records.ts';

const FILE_MTIME = 1_786_549_100;

describe('isCursorCliCandidateLine', () => {
  test('parses usage, user, and result lines and skips tool payloads', () => {
    expect(isCursorCliCandidateLine('{"type":"user","message":{}}')).toBe(true);
    expect(isCursorCliCandidateLine('{"type":"result","usage":{}}')).toBe(true);
    expect(isCursorCliCandidateLine('{"type":"assistant","message":{"usage":{}}}')).toBe(true);
    expect(isCursorCliCandidateLine('{"type":"tool_call","name":"read"}')).toBe(false);
  });
});

describe('cursorCliProviderFromModel', () => {
  test('maps native models to cursor and third-party models to their vendor', () => {
    expect(cursorCliProviderFromModel('grok-4.6')).toBe('cursor');
    expect(cursorCliProviderFromModel('composer-2.5')).toBe('cursor');
    expect(cursorCliProviderFromModel('claude-4-sonnet')).toBe('anthropic');
    expect(cursorCliProviderFromModel('gpt-5.4')).toBe('openai');
    expect(cursorCliProviderFromModel('mystery-model')).toBe('other');
  });
});

describe('classifyCursorCliLine', () => {
  test('joins a user prompt from message.content text blocks', () => {
    const record = classifyCursorCliLine(
      JSON.stringify({
        type: 'user',
        session_id: 'sess-1',
        uuid: 'user-1',
        message: { role: 'user', content: [{ type: 'text', text: 'summarize this' }] },
      }),
      FILE_MTIME,
    );
    expect(record).toEqual({
      kind: 'user',
      sessionId: 'sess-1',
      text: 'summarize this',
      promptKey: 'user-1',
    });
  });

  test('skips injected user wrappers that start with <', () => {
    const record = classifyCursorCliLine(
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'text', text: '<user_info>cwd</user_info>' }] },
      }),
      FILE_MTIME,
    );
    expect(record.kind).toBe('skipped');
  });

  test('reads camelCase result usage and snake_case assistant usage', () => {
    const result = classifyCursorCliLine(
      JSON.stringify({
        type: 'result',
        session_id: 'sess-1',
        request_id: 'req-9',
        timestamp: '2026-08-17T01:00:00Z',
        model: 'grok-4.6',
        usage: {
          inputTokens: 10,
          outputTokens: 4,
          cacheReadTokens: 2,
          cacheWriteTokens: 1,
        },
      }),
      FILE_MTIME,
    );
    expect(result.kind).toBe('usage');
    if (result.kind === 'usage') {
      expect(result.usage.inputTokens).toBe(10);
      expect(result.usage.cacheRead).toBe(2);
      expect(result.usage.requestId).toBe('req-9');
      expect(usageTokenSum(result.usage)).toBe(17);
    }

    const assistant = classifyCursorCliLine(
      JSON.stringify({
        type: 'assistant',
        session_id: 'sess-1',
        timestamp: 1_786_549_000,
        message: {
          model: 'claude-4-sonnet',
          usage: {
            input_tokens: 3,
            output_tokens: 1,
            cache_read_input_tokens: 8,
            cache_creation_input_tokens: 0,
          },
        },
      }),
      FILE_MTIME,
    );
    expect(assistant.kind).toBe('usage');
    if (assistant.kind === 'usage') {
      expect(assistant.usage.cacheRead).toBe(8);
      expect(assistant.usage.model).toBe('claude-4-sonnet');
    }
  });

  test('skips assistant events that carry no usage instead of inventing tokens', () => {
    const record = classifyCursorCliLine(
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-08-17T01:00:00Z',
        message: { content: [{ type: 'text', text: 'hello' }] },
      }),
      FILE_MTIME,
    );
    expect(record.kind).toBe('skipped');
  });

  test('falls back to file mtime when the event has no timestamp', () => {
    const record = classifyCursorCliLine(
      JSON.stringify({
        type: 'result',
        usage: { inputTokens: 1, outputTokens: 1 },
        model: 'grok-4.6',
      }),
      FILE_MTIME,
    );
    expect(record.kind).toBe('usage');
    if (record.kind === 'usage') {
      expect(record.usage.tsUtc).toBe(FILE_MTIME);
    }
  });

  test('reports malformed JSON without throwing', () => {
    const record = classifyCursorCliLine('{not json', FILE_MTIME);
    expect(record.kind).toBe('malformed');
  });
});
