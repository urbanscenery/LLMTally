import { describe, expect, test } from 'bun:test';

import {
  agentMessagePromptText,
  ENCRYPTED_PAYLOAD_MARKER,
  extractCodexPrompt,
} from '@llmtally/core/parsers/codex/prompts.ts';

describe('extractCodexPrompt', () => {
  test('keeps plain prompts untouched', () => {
    // Act & Assert
    expect(extractCodexPrompt(['fix the failing test'])).toEqual({
      promptText: 'fix the failing test',
      hasUnterminatedBlock: false,
    });
  });

  test('drops AGENTS.md instruction blocks entirely', () => {
    // Act
    const result = extractCodexPrompt([
      '# AGENTS.md instructions for /tmp/proj\n\n<INSTRUCTIONS>rules</INSTRUCTIONS>',
      'real user request',
    ]);

    // Assert
    expect(result.promptText).toBe('real user request');
  });

  test('strips stacked leading injected xml blocks but keeps the tail text', () => {
    // Act
    const result = extractCodexPrompt([
      '<permissions instructions>sandbox rules</permissions instructions>\n<environment_context>cwd info</environment_context>\nplease refactor the parser',
    ]);

    // Assert
    expect(result.promptText).toBe('\nplease refactor the parser');
    expect(result.hasUnterminatedBlock).toBe(false);
  });

  test('never removes injected-looking strings in the middle of user text', () => {
    // Arrange
    const text = 'my doc mentions <environment_context> as a literal tag';

    // Act & Assert
    expect(extractCodexPrompt([text]).promptText).toBe(text);
  });

  test('keeps an unterminated block intact and flags it', () => {
    // Arrange
    const text = '<permissions instructions>never closed';

    // Act
    const result = extractCodexPrompt([text]);

    // Assert
    expect(result.promptText).toBe(text);
    expect(result.hasUnterminatedBlock).toBe(true);
  });

  test('returns null when everything was injected content', () => {
    // Act & Assert
    expect(
      extractCodexPrompt(['# AGENTS.md instructions for /x', '<environment_context>x</environment_context>']),
    ).toEqual({ promptText: null, hasUnterminatedBlock: false });
  });

  test('drops a leading skill expansion block so the typed prompt survives', () => {
    // Arrange — codex appends the expanded skill body as its own message
    const expansion = '<skill>\n<name>omo:ulw-loop</name>\n<path>/Users/x/.codex/skills/ulw</path>\nULTRAWORK…\n</skill>';

    // Act
    const result = extractCodexPrompt([expansion]);

    // Assert
    expect(result.promptText).toBeNull();
    expect(result.hasUnterminatedBlock).toBe(false);
  });
});

describe('agentMessagePromptText', () => {
  test('keeps the plaintext header and marks an encrypted body', () => {
    // Arrange
    const header = 'Message Type: NEW_TASK\nTask name: /root/audit\nSender: /root\nPayload:\n';

    // Act
    const text = agentMessagePromptText([header], true);

    // Assert
    expect(text).toBe(`${header.trim()} ${ENCRYPTED_PAYLOAD_MARKER}`);
  });

  test('returns a clear-text body unchanged and null for an empty one', () => {
    // Act & Assert
    expect(agentMessagePromptText(['Message Type: MESSAGE\nPayload:\nplease retry'], false)).toBe(
      'Message Type: MESSAGE\nPayload:\nplease retry',
    );
    expect(agentMessagePromptText(['   '], true)).toBeNull();
  });
});
