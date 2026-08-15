import { describe, expect, test } from 'bun:test';

import {
  classifyClaudeLine,
  isCandidateLine,
} from '@llmtally/core/parsers/claude-code/records.ts';
import { MAX_TOKENS_PER_EVENT, asTokenCount } from '@llmtally/core/parsers/shared.ts';

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

  test('accepts every sidechain line so subagent chains can be walked', () => {
    // Arrange & Act & Assert — attachments carry neither usage nor a user type
    expect(isCandidateLine('{"type":"attachment","uuid":"at1","isSidechain":true}')).toBe(true);
    expect(isCandidateLine('{"type":"attachment","uuid":"at1","isSidechain": true}')).toBe(true);
    expect(isCandidateLine('{"type":"attachment","uuid":"at1","isSidechain":false}')).toBe(false);
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
      messageId: null,
      parentUuid: 'u1',
      isSidechain: false,
      spawnedPrompt: null,
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

  test('extracts the API message id when present', () => {
    // Arrange — Claude Code repeats message.id across the block lines of
    // one assistant message, so it must surface for dedup keying
    const line = usageLine({
      message: {
        id: 'msg_abc123',
        role: 'assistant',
        model: 'claude-fable-5',
        usage: { input_tokens: 12, output_tokens: 34 },
      },
    });

    // Act
    const record = classifyClaudeLine(line);

    // Assert
    expect(record).toMatchObject({ kind: 'usage', messageId: 'msg_abc123' });
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

    // Act & Assert — neither is a prompt; without a uuid there is nothing to link
    expect(classifyClaudeLine(metaLine)).toEqual({ kind: 'skipped' });
    expect(classifyClaudeLine(systemLine)).toEqual({ kind: 'skipped' });
  });

  test('turns non-prompt records with a uuid into chain links', () => {
    // Arrange — attachment hop, tool_result user, meta user, usage-less assistant
    const attachment = JSON.stringify({ type: 'attachment', uuid: 'at1', parentUuid: 'su1', isSidechain: true });
    const toolResult = JSON.stringify({
      type: 'user',
      uuid: 'tr1',
      parentUuid: 'sa1',
      isSidechain: true,
      message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] },
    });
    const meta = JSON.stringify({ type: 'user', uuid: 'm1', parentUuid: 'x', isMeta: true, message: { content: 'body' } });
    const noUsage = JSON.stringify({ type: 'assistant', uuid: 'a1', parentUuid: 'p', message: { model: 'claude-fable-5' } });
    const noUuid = JSON.stringify({ type: 'attachment', parentUuid: 'su1', isSidechain: true });

    // Act & Assert
    expect(classifyClaudeLine(attachment)).toEqual({ kind: 'link', uuid: 'at1', parentUuid: 'su1', isSidechain: true });
    expect(classifyClaudeLine(toolResult)).toEqual({ kind: 'link', uuid: 'tr1', parentUuid: 'sa1', isSidechain: true });
    expect(classifyClaudeLine(meta)).toEqual({ kind: 'link', uuid: 'm1', parentUuid: 'x', isSidechain: false });
    expect(classifyClaudeLine(noUsage)).toEqual({ kind: 'link', uuid: 'a1', parentUuid: 'p', isSidechain: false });
    expect(classifyClaudeLine(noUuid)).toEqual({ kind: 'skipped' });
  });

  test('extracts the Agent tool_use prompt from an assistant record verbatim', () => {
    // Arrange — the spawning record as copied into a fork transcript
    const spawning = JSON.stringify({
      type: 'assistant',
      uuid: 'fa1',
      parentUuid: null,
      isSidechain: true,
      timestamp: '2026-08-16T01:00:00.000Z',
      message: {
        id: 'msg_parent',
        model: 'claude-fable-5',
        usage: { input_tokens: 5, output_tokens: 6 },
        content: [
          { type: 'text', text: 'Spawning a helper.' },
          { type: 'tool_use', name: 'Agent', input: { subagent_type: 'fork', description: 'Fix parser', prompt: 'You are the fork owning Task #3.' } },
        ],
      },
    });
    const otherTool = JSON.stringify({
      type: 'assistant',
      uuid: 'a2',
      timestamp: '2026-08-16T01:00:00.000Z',
      message: { model: 'claude-fable-5', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls', prompt: 'not an agent' } }] },
    });

    // Act & Assert — the prompt only, never the description; other tools give null
    expect(classifyClaudeLine(spawning)).toMatchObject({ kind: 'usage', spawnedPrompt: 'You are the fork owning Task #3.' });
    expect(classifyClaudeLine(otherTool)).toMatchObject({ kind: 'usage', spawnedPrompt: null });
  });

  test('rebuilds slash commands into the typed form and skips other tag-led text', () => {
    // Arrange
    const withArgs = JSON.stringify({
      type: 'user',
      uuid: 'c1',
      message: { content: '<command-message>ecc:multi-workflow</command-message>\n<command-name>/ecc:multi-workflow</command-name>\n<command-args>  build it  </command-args>' },
    });
    const nameFirst = JSON.stringify({
      type: 'user',
      uuid: 'c2',
      message: { content: '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args></command-args>' },
    });
    const stdout = JSON.stringify({
      type: 'user',
      uuid: 'c3',
      message: { content: '<local-command-stdout>Set model to Fable 5</local-command-stdout>' },
    });
    const nameless = JSON.stringify({
      type: 'user',
      uuid: 'c4',
      message: { content: '<command-message>only a message</command-message>' },
    });

    // Act & Assert
    expect(classifyClaudeLine(withArgs)).toMatchObject({ kind: 'user', promptText: '/ecc:multi-workflow build it' });
    expect(classifyClaudeLine(nameFirst)).toMatchObject({ kind: 'user', promptText: '/model' });
    expect(classifyClaudeLine(stdout)).toMatchObject({ kind: 'link', uuid: 'c3' });
    expect(classifyClaudeLine(nameless)).toMatchObject({ kind: 'link', uuid: 'c4' });
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
  test('rejects values past the per-event cap instead of poisoning sums', () => {
    expect(asTokenCount(MAX_TOKENS_PER_EVENT)).toBe(MAX_TOKENS_PER_EVENT);
    expect(asTokenCount(MAX_TOKENS_PER_EVENT + 1)).toBeNull();
    expect(asTokenCount(Number.MAX_SAFE_INTEGER)).toBeNull();
    expect(asTokenCount(1e300)).toBeNull();
  });
});
