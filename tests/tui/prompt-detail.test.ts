import { describe, expect, test } from 'bun:test';

import type { PromptDetail } from '@llmtally/core/report/prompts.ts';
import { lineText } from '@llmtally/tui/rich-text.ts';
import type { RichLine } from '@llmtally/tui/rich-text.ts';
import { toPromptDetailViewModel } from '@llmtally/tui/view-model/prompt-detail.ts';
import {
  clampDetailScroll,
  promptDetailLines,
  promptDetailPlaceholder,
  renderPromptDetail,
} from '@llmtally/tui/views/prompt-detail.ts';
import type { TabViewLine } from '@llmtally/tui/views/shell.ts';

const NOW = 1_768_464_000; // 2026-01-15 08:00:00 UTC
const ESC = String.fromCharCode(27);

function detail(overrides: Partial<PromptDetail> = {}): PromptDetail {
  const tokens = { inputTokens: 1200, outputTokens: 300, cacheWrite: 50, cacheRead: 9000, reasoningTokens: 40 };
  return {
    prompt: {
      id: 7,
      tsUtc: NOW,
      agent: 'codex',
      model: 'gpt-5.6-sol',
      effort: 'high',
      tokens,
      nature: 'quota',
      costUsd: 0.1234,
      text: `first line\n\tindented${ESC}[31m red\nthird`,
      calls: 2,
      isSidechain: true,
    },
    provider: 'openai',
    sessionId: 'sess-9',
    cwd: '/work/repo',
    lastTsUtc: NOW + 90,
    calls: [
      { id: 7, tsUtc: NOW, model: 'gpt-5.6-sol', effort: 'high', tokens, costUsd: 0.06 },
      { id: 8, tsUtc: NOW + 90, model: 'gpt-5.6-sol', effort: 'high', tokens, costUsd: 0.0634 },
    ],
    warnings: ['pricing is stale'],
    ...overrides,
  };
}

function text(lines: readonly TabViewLine[]): string[] {
  return lines.map((line) => (typeof line === 'string' ? line : lineText(line as RichLine)));
}

describe('toPromptDetailViewModel', () => {
  test('keeps the body line by line, expands tabs and strips control sequences', () => {
    // Act
    const model = toPromptDetailViewModel(detail());

    // Assert
    expect(model.textLines).toHaveLength(3);
    expect(model.textLines[1]).toStartWith('    indented');
    expect(model.textLines.join('')).not.toContain(ESC);
    expect(model.isSidechain).toBe(true);
    expect(model.calls).toHaveLength(2);
    expect(model.warnings).toEqual(['pricing is stale']);
  });

  test('an unstored body becomes no lines rather than one empty line', () => {
    // Act
    const model = toPromptDetailViewModel(detail({ prompt: { ...detail().prompt, text: '' } }));

    // Assert
    expect(model.textLines).toEqual([]);
  });
});

describe('promptDetailLines', () => {
  test('lists every fact, the totals, the calls table and the wrapped body', () => {
    // Arrange
    const model = toPromptDetailViewModel(detail());

    // Act
    const lines = text(promptDetailLines(model, 80));
    const joined = lines.join('\n');

    // Assert
    expect(joined).toContain('agent     codex (openai)');
    expect(joined).toContain('model     gpt-5.6-sol · effort high');
    expect(joined).toContain('(1m 30s)');
    expect(joined).toContain('2 API calls · subagent prompt');
    expect(joined).toContain('input 1,200   output 300');
    expect(joined).toContain('cache read 9,000   cache write 50   reasoning 40');
    expect(joined).toContain('~$0.1234 quota cost');
    expect(joined).toContain('session   sess-9');
    expect(joined).toContain('cwd       /work/repo');
    expect(joined).toContain('calls (2)');
    expect(lines.filter((line) => line.includes('gpt-5.6-sol') && line.includes('~$0.0'))).toHaveLength(2);
    expect(joined).toContain('   first line');
    expect(joined).toContain('   third');
    expect(joined).toContain('! pricing is stale');
  });

  test('a long body line wraps to the width instead of being clipped', () => {
    // Arrange
    const body = Array.from({ length: 30 }, (_, index) => `word${index}`).join(' ');
    const model = toPromptDetailViewModel(detail({ prompt: { ...detail().prompt, text: body } }));

    // Act
    const lines = text(promptDetailLines(model, 40));
    const bodyLines = lines.filter((line) => line.startsWith('   word'));

    // Assert — every word survives, no line exceeds the width
    expect(bodyLines.length).toBeGreaterThan(1);
    expect(bodyLines.join(' ').replace(/\s+/gu, ' ').trim()).toBe(body);
    expect(bodyLines.every((line) => line.length <= 40)).toBe(true);
  });

  test('a body that was never stored says so', () => {
    // Arrange
    const model = toPromptDetailViewModel(detail({ prompt: { ...detail().prompt, text: '' } }));

    // Act
    const joined = text(promptDetailLines(model, 80)).join('\n');

    // Assert
    expect(joined).toContain('(no prompt text stored)');
  });
});

describe('renderPromptDetail', () => {
  test('scrolls through the lines and reports the window in the header', () => {
    // Arrange — a body far taller than the screen
    const body = Array.from({ length: 60 }, (_, index) => `line ${index}`).join('\n');
    const model = toPromptDetailViewModel(detail({ prompt: { ...detail().prompt, text: body } }));

    // Act
    const top = renderPromptDetail({ model, scroll: 0, width: 80, height: 12, backLabel: 'back' });
    const bottom = renderPromptDetail({ model, scroll: 10_000, width: 80, height: 12, backLabel: 'back' });

    // Assert — the offset is clamped and the header tells where we are
    expect(top.lines).toHaveLength(12);
    expect(text(top.lines)[0]).toContain('1-10 of');
    expect(bottom.scroll).toBe(bottom.totalLines - 10);
    expect(text(bottom.lines).join('\n')).toContain('line 59');
    expect(text(bottom.lines)[0]).toContain(`${bottom.totalLines} lines`);
  });

  test('a short page needs no scroll and shows no position', () => {
    // Arrange
    const model = toPromptDetailViewModel(detail({ prompt: { ...detail().prompt, text: 'hi' } }));

    // Act
    const rendered = renderPromptDetail({ model, scroll: 5, width: 100, height: 60, backLabel: 'back' });

    // Assert
    expect(rendered.scroll).toBe(0);
    expect(text(rendered.lines)[0]).not.toContain(' of ');
    expect(clampDetailScroll(5, 9, 10)).toBe(0);
  });

  test('the placeholder keeps the way back visible', () => {
    // Act
    const lines = text(promptDetailPlaceholder('loading prompt…', 60, 'back to results'));

    // Assert
    expect(lines[0]).toContain('back to results');
    expect(lines[2]).toContain('loading prompt…');
  });
});
