import { describe, expect, test } from 'bun:test';

import {
  classifyCodexLine,
  isCodexCandidateLine,
} from '@llmtally/core/parsers/codex/records.ts';

function tokenCountLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    timestamp: '2026-08-10T07:50:17.300Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: 17984,
          cached_input_tokens: 9984,
          cache_write_input_tokens: 0,
          output_tokens: 404,
          reasoning_output_tokens: 230,
          total_tokens: 18388,
        },
        last_token_usage: {
          input_tokens: 17984,
          cached_input_tokens: 9984,
          cache_write_input_tokens: 0,
          output_tokens: 404,
          reasoning_output_tokens: 230,
          total_tokens: 18388,
        },
        model_context_window: 258400,
      },
      rate_limits: {},
    },
    ...overrides,
  });
}

describe('isCodexCandidateLine', () => {
  test('accepts meta, turn, token, and response lines but skips others', () => {
    expect(isCodexCandidateLine('{"type":"session_meta","payload":{}}')).toBe(true);
    expect(isCodexCandidateLine('{"type":"turn_context","payload":{}}')).toBe(true);
    expect(isCodexCandidateLine(tokenCountLine())).toBe(true);
    expect(isCodexCandidateLine('{"type":"response_item","payload":{}}')).toBe(true);
    expect(isCodexCandidateLine('{"type":"compacted","payload":{}}')).toBe(false);
  });
});

describe('classifyCodexLine', () => {
  test('extracts rollout identity and provider from session_meta', () => {
    // Arrange
    const line = JSON.stringify({
      timestamp: '2026-07-06T09:10:38.985Z',
      type: 'session_meta',
      payload: {
        session_id: 'root-session',
        id: 'rollout-1',
        cwd: '/tmp/proj',
        model_provider: 'openai',
        source: 'cli',
      },
    });

    // Act & Assert
    expect(classifyCodexLine(line)).toEqual({
      kind: 'session_meta',
      rolloutId: 'rollout-1',
      sessionId: 'root-session',
      modelProvider: 'openai',
      cwd: '/tmp/proj',
      isSidechain: false,
      parentThreadId: null,
      agentPath: null,
    });
  });

  test('reads the agent path of a spawned subagent from thread_spawn', () => {
    // Arrange
    const line = JSON.stringify({
      type: 'session_meta',
      payload: {
        id: 'rollout-3',
        session_id: 'root-session',
        source: {
          subagent: {
            thread_spawn: { parent_thread_id: 'root-session', depth: 1, agent_path: '/root/audit' },
          },
        },
        parent_thread_id: 'root-session',
      },
    });

    // Act & Assert
    expect(classifyCodexLine(line)).toMatchObject({
      kind: 'session_meta',
      isSidechain: true,
      agentPath: '/root/audit',
    });
  });

  test('marks subagent session_meta as sidechain with parent thread', () => {
    // Arrange
    const line = JSON.stringify({
      type: 'session_meta',
      payload: {
        id: 'rollout-2',
        session_id: 'root-session',
        source: { subagent: { role: 'worker' } },
        parent_thread_id: 'rollout-1',
      },
    });

    // Act & Assert
    expect(classifyCodexLine(line)).toMatchObject({
      kind: 'session_meta',
      isSidechain: true,
      parentThreadId: 'rollout-1',
    });
  });

  test('parses turn_context with model, effort, and cwd', () => {
    // Arrange
    const line = JSON.stringify({
      type: 'turn_context',
      payload: { turn_id: 'turn-1', model: 'gpt-5.5', effort: 'xhigh', cwd: '/tmp/proj' },
    });

    // Act & Assert
    expect(classifyCodexLine(line)).toEqual({
      kind: 'turn_context',
      turnId: 'turn-1',
      model: 'gpt-5.5',
      effort: 'xhigh',
      cwd: '/tmp/proj',
    });
  });

  test('rejects turn_context without turn_id or model', () => {
    // Act & Assert
    expect(
      classifyCodexLine(JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.5' } })),
    ).toMatchObject({ kind: 'invalid' });
  });

  test('parses usage-bearing token_count with raw last and total usage', () => {
    // Act
    const record = classifyCodexLine(tokenCountLine());

    // Assert
    expect(record).toMatchObject({
      kind: 'token_count',
      tsUtc: 1_786_348_217,
      last: { inputTokens: 17984, cachedInputTokens: 9984, outputTokens: 404, reasoningOutputTokens: 230 },
    });
  });

  test('skips rate-limit-only token_count with null info', () => {
    // Arrange
    const line = JSON.stringify({
      timestamp: '2026-08-10T07:50:17.300Z',
      type: 'event_msg',
      payload: { type: 'token_count', info: null, rate_limits: {} },
    });

    // Act & Assert
    expect(classifyCodexLine(line)).toEqual({ kind: 'skipped' });
  });

  test('rejects token_count with negative tokens or naive timestamps', () => {
    // Act & Assert
    const negative = tokenCountLine();
    expect(
      classifyCodexLine(negative.replace('"output_tokens":404', '"output_tokens":-1')),
    ).toMatchObject({ kind: 'invalid' });
    expect(
      classifyCodexLine(tokenCountLine({ timestamp: '2026-08-10T07:50:17.300' })),
    ).toMatchObject({ kind: 'invalid' });
  });

  test('collects raw input_text blocks from user response items', () => {
    // Arrange
    const line = JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'first block' },
          { type: 'input_image', image_url: 'ignored' },
          { type: 'input_text', text: 'second block' },
        ],
      },
    });

    // Act & Assert
    expect(classifyCodexLine(line)).toEqual({
      kind: 'user',
      rawTexts: ['first block', 'second block'],
    });
  });

  test('classifies inter-agent mail with author, recipient, and encryption flag', () => {
    // Arrange — a NEW_TASK whose body travels encrypted
    const line = JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'agent_message',
        id: 'amsg-1',
        author: '/root',
        recipient: '/root/audit',
        content: [
          { type: 'input_text', text: 'Message Type: NEW_TASK\nTask name: /root/audit\nSender: /root\nPayload:\n' },
          { type: 'encrypted_content', encrypted_content: 'gAAAAAB…' },
        ],
      },
    });

    // Act & Assert
    expect(classifyCodexLine(line)).toEqual({
      kind: 'agent_message',
      author: '/root',
      recipient: '/root/audit',
      rawTexts: ['Message Type: NEW_TASK\nTask name: /root/audit\nSender: /root\nPayload:\n'],
      hasEncryptedPayload: true,
    });
  });

  test('skips agent mail without any plaintext block', () => {
    // Arrange
    const line = JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'agent_message',
        author: '/root',
        recipient: '/root/audit',
        content: [{ type: 'encrypted_content', encrypted_content: 'gAAAAAB…' }],
      },
    });

    // Act & Assert
    expect(classifyCodexLine(line)).toEqual({ kind: 'skipped' });
  });

  test('skips developer and assistant response items', () => {
    // Arrange
    const line = JSON.stringify({
      type: 'response_item',
      payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'x' }] },
    });

    // Act & Assert
    expect(classifyCodexLine(line)).toEqual({ kind: 'skipped' });
  });

  test('reports malformed json with a fixed reason', () => {
    // Act & Assert
    expect(classifyCodexLine('{"type":"event_msg","payload":{"token_count"')).toEqual({
      kind: 'malformed',
      reason: 'line is not parseable as JSON',
    });
  });
});
