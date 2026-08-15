import { describe, expect, test } from 'bun:test';

import { PromptTracker } from '@llmtally/core/parsers/claude-code/prompts.ts';
import type {
  ClaudeLinkRecord,
  ClaudeUsageRecord,
  ClaudeUserRecord,
} from '@llmtally/core/parsers/claude-code/records.ts';

function userRecord(overrides: Partial<ClaudeUserRecord>): ClaudeUserRecord {
  return {
    kind: 'user',
    uuid: 'u1',
    parentUuid: null,
    isSidechain: false,
    promptText: 'main prompt',
    ...overrides,
  };
}

function linkRecord(overrides: Partial<ClaudeLinkRecord>): ClaudeLinkRecord {
  return {
    kind: 'link',
    uuid: 'l1',
    parentUuid: 'su1',
    isSidechain: true,
    ...overrides,
  };
}

/** The words only — most assertions do not care about the key. */
function textOf(tracker: PromptTracker, record: ClaudeUsageRecord): string | null {
  return tracker.resolvePrompt(record)?.promptText ?? null;
}

function usageRecord(overrides: Partial<ClaudeUsageRecord>): ClaudeUsageRecord {
  return {
    kind: 'usage',
    uuid: 'a1',
    parentUuid: 'u1',
    isSidechain: false,
    spawnedPrompt: null,
    tsUtc: 1_785_578_405,
    model: 'claude-fable-5',
    effort: null,
    messageId: null,
    requestId: null,
    sessionId: null,
    cwd: null,
    inputTokens: 1,
    outputTokens: 1,
    cacheWrite: 0,
    cacheRead: 0,
    ...overrides,
  };
}

describe('PromptTracker', () => {
  test('resolves main branch usage to the last eligible main prompt', () => {
    // Arrange
    const tracker = new PromptTracker();
    tracker.recordUserPrompt(userRecord({ promptText: 'first' }));
    tracker.recordUserPrompt(userRecord({ uuid: 'u2', promptText: 'second' }));

    // Act & Assert
    expect(textOf(tracker, usageRecord({}))).toBe('second');
  });

  test('keeps the prompt available for several assistant records', () => {
    // Arrange
    const tracker = new PromptTracker();
    tracker.recordUserPrompt(userRecord({ promptText: 'stays' }));

    // Act & Assert
    expect(textOf(tracker, usageRecord({ uuid: 'a1' }))).toBe('stays');
    expect(textOf(tracker, usageRecord({ uuid: 'a2' }))).toBe('stays');
  });

  test('correlates sidechain usage through the uuid chain without touching main', () => {
    // Arrange
    const tracker = new PromptTracker();
    tracker.recordUserPrompt(userRecord({ promptText: 'main prompt' }));
    tracker.recordUserPrompt(
      userRecord({ uuid: 'su1', isSidechain: true, promptText: 'sidechain prompt' }),
    );

    // Act
    const first = textOf(tracker, 
      usageRecord({ uuid: 'sa1', parentUuid: 'su1', isSidechain: true }),
    );
    const chained = textOf(tracker, 
      usageRecord({ uuid: 'sa2', parentUuid: 'sa1', isSidechain: true }),
    );
    const main = textOf(tracker, usageRecord({ uuid: 'ma2' }));

    // Assert
    expect(first).toBe('sidechain prompt');
    expect(chained).toBe('sidechain prompt');
    expect(main).toBe('main prompt');
  });

  test('returns null for sidechain usage before any sidechain prompt was seen', () => {
    // Arrange — only a main prompt exists; a subagent line with an
    // unknown parent has nothing to fall back to
    const tracker = new PromptTracker();
    tracker.recordUserPrompt(userRecord({ promptText: 'main prompt' }));

    // Act & Assert
    expect(textOf(tracker, usageRecord({ isSidechain: true, parentUuid: 'unknown' }))).toBeNull();
    expect(textOf(tracker, usageRecord({ isSidechain: true, parentUuid: null }))).toBeNull();
  });

  test('falls back to the latest sidechain prompt when the uuid chain is broken', () => {
    // Arrange — two subagent prompts; the second is the most recent
    const tracker = new PromptTracker();
    tracker.recordUserPrompt(userRecord({ promptText: 'main prompt' }));
    tracker.recordUserPrompt(userRecord({ uuid: 'su1', isSidechain: true, promptText: 'first side' }));
    tracker.recordUserPrompt(userRecord({ uuid: 'su2', isSidechain: true, promptText: 'second side' }));

    // Act
    const broken = textOf(tracker, usageRecord({ uuid: 'sa9', parentUuid: 'unknown', isSidechain: true }));
    const chained = textOf(tracker, usageRecord({ uuid: 'sa1', parentUuid: 'su1', isSidechain: true }));

    // Assert — a walkable chain still wins over the fallback
    expect(broken).toBe('second side');
    expect(chained).toBe('first side');
  });

  test('bridges the chain across usage-less hops such as attachments and tool results', () => {
    // Arrange — user(su1) → attachment(at1) → attachment(at2) → assistant(sa1)
    //           → user tool_result(tr1) → assistant(sa2), as Claude Code writes it
    const tracker = new PromptTracker();
    tracker.recordUserPrompt(userRecord({ uuid: 'su1', isSidechain: true, promptText: 'side prompt' }));
    tracker.link(linkRecord({ uuid: 'at1', parentUuid: 'su1' }));
    tracker.link(linkRecord({ uuid: 'at2', parentUuid: 'at1' }));

    // Act
    const first = tracker.resolvePrompt(usageRecord({ uuid: 'sa1', parentUuid: 'at2', isSidechain: true }));
    tracker.link(linkRecord({ uuid: 'tr1', parentUuid: 'sa1' }));
    const second = tracker.resolvePrompt(usageRecord({ uuid: 'sa2', parentUuid: 'tr1', isSidechain: true }));

    // Assert — both hops resolve to the prompt and carry its uuid as key
    expect(first).toEqual({ promptText: 'side prompt', promptKey: 'su1' });
    expect(second).toEqual({ promptText: 'side prompt', promptKey: 'su1' });
  });

  test('main-branch links never move a prompt and unknown parents link nothing', () => {
    // Arrange
    const tracker = new PromptTracker();
    tracker.recordUserPrompt(userRecord({ promptText: 'main prompt' }));
    tracker.recordUserPrompt(userRecord({ uuid: 'su1', isSidechain: true, promptText: 'side prompt' }));

    // Act
    tracker.link(linkRecord({ uuid: 'm-hop', parentUuid: 'u1', isSidechain: false }));
    tracker.link(linkRecord({ uuid: 'orphan', parentUuid: 'nobody' }));

    // Assert — the main slot is untouched and the orphan created no key;
    // resolving through it lands on the latest-sidechain fallback
    expect(textOf(tracker, usageRecord({}))).toBe('main prompt');
    expect(Object.keys(tracker.toJson())).not.toContain('sidechain:orphan');
    expect(textOf(tracker, usageRecord({ isSidechain: true, parentUuid: 'orphan' }))).toBe('side prompt');
  });

  test('registers a sidechain spawn prompt for its own record and the chain below it', () => {
    // Arrange — the fork file's first billing record carries the Agent prompt
    const tracker = new PromptTracker();
    tracker.recordUserPrompt(userRecord({ promptText: 'main prompt' }));
    const spawning = usageRecord({ uuid: 'fa1', parentUuid: null, isSidechain: true, spawnedPrompt: 'do the fork work' });

    // Act
    tracker.recordSpawnedPrompt(spawning);
    const self = tracker.resolvePrompt(spawning);
    tracker.link(linkRecord({ uuid: 'ft1', parentUuid: 'fa1' }));
    const child = tracker.resolvePrompt(usageRecord({ uuid: 'fa2', parentUuid: 'ft1', isSidechain: true }));
    const main = tracker.resolvePrompt(usageRecord({}));

    // Assert — keyed by the spawning uuid; main is untouched
    expect(self).toEqual({ promptText: 'do the fork work', promptKey: 'fa1' });
    expect(child).toEqual({ promptText: 'do the fork work', promptKey: 'fa1' });
    expect(main).toEqual({ promptText: 'main prompt', promptKey: 'u1' });
  });

  test('a main-branch spawn prompt is ignored so the parent keeps its prompt', () => {
    // Arrange
    const tracker = new PromptTracker();
    tracker.recordUserPrompt(userRecord({ promptText: 'main prompt' }));

    // Act
    tracker.recordSpawnedPrompt(usageRecord({ uuid: 'pa1', isSidechain: false, spawnedPrompt: 'fork prompt' }));

    // Assert
    expect(textOf(tracker, usageRecord({ uuid: 'pa2' }))).toBe('main prompt');
    expect(Object.keys(tracker.toJson())).toEqual(['main']);
  });

  test('exposes the prompt uuid as the key and null when the prompt had none', () => {
    // Arrange
    const tracker = new PromptTracker();
    tracker.recordUserPrompt(userRecord({ uuid: 'u-main', promptText: 'keyed' }));

    // Act
    const keyed = tracker.resolvePrompt(usageRecord({}));
    tracker.recordUserPrompt(userRecord({ uuid: null, promptText: 'keyless' }));
    const keyless = tracker.resolvePrompt(usageRecord({}));

    // Assert
    expect(keyed).toEqual({ promptText: 'keyed', promptKey: 'u-main' });
    expect(keyless).toEqual({ promptText: 'keyless', promptKey: null });
  });

  test('round-trips pending prompts through cursor json', () => {
    // Arrange
    const tracker = new PromptTracker();
    tracker.recordUserPrompt(userRecord({ promptText: 'persisted' }));
    tracker.recordUserPrompt(
      userRecord({ uuid: 'su1', isSidechain: true, promptText: 'side persisted' }),
    );

    // Act
    const restored = PromptTracker.fromJson(tracker.toJson());

    // Assert — main, chained and the latest-sidechain fallback all survive
    expect(textOf(restored, usageRecord({}))).toBe('persisted');
    expect(
      textOf(restored, usageRecord({ isSidechain: true, parentUuid: 'su1' })),
    ).toBe('side persisted');
    expect(
      textOf(restored, usageRecord({ isSidechain: true, parentUuid: 'unknown' })),
    ).toBe('side persisted');
  });

  test('caps accumulated sidechain prompts while keeping the main prompt', () => {
    // Arrange
    const tracker = new PromptTracker();
    tracker.recordUserPrompt(userRecord({ promptText: 'main survives' }));
    for (let index = 0; index < 400; index += 1) {
      tracker.recordUserPrompt(
        userRecord({ uuid: `su-${index}`, isSidechain: true, promptText: `side ${index}` }),
      );
    }

    // Act
    const serialized = tracker.toJson();

    // Assert — cursor json stays bounded (256 chain keys + main + latest)
    // and neither pinned slot is ever evicted
    expect(Object.keys(serialized).length).toBeLessThanOrEqual(258);
    expect(serialized['sidechain-latest']?.promptText).toBe('side 399');
    expect(textOf(tracker, usageRecord({}))).toBe('main survives');
    expect(
      textOf(tracker, usageRecord({ isSidechain: true, parentUuid: 'su-399' })),
    ).toBe('side 399');
  });

  test('ignores corrupt cursor json instead of failing the scan', () => {
    // Act
    const restored = PromptTracker.fromJson([1, 2, 3]);

    // Assert
    expect(textOf(restored, usageRecord({}))).toBeNull();
  });
});
