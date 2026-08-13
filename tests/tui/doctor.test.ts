import { describe, expect, test } from 'bun:test';

import { lineText } from '@llmtally/tui/rich-text.ts';
import { createInitialState, withTabResource } from '@llmtally/tui/state.ts';
import type { TuiState } from '@llmtally/tui/state.ts';
import { doctorTabView } from '@llmtally/tui/views/doctor.ts';
import type { DoctorTabViewModel } from '@llmtally/tui/view-model/doctor.ts';

function stateWithChecks(checks: DoctorTabViewModel['checks']): TuiState {
  const counts = { pass: 0, warn: 0, fail: 0, skip: 0 };
  for (const check of checks) {
    counts[check.status] += 1;
  }
  return withTabResource(createInitialState(), 'doctor', {
    phase: 'ready',
    data: { checks, counts },
    error: null,
    updatedAtUtc: 0,
    invalidated: false,
  });
}

function renderedText(state: TuiState, width: number): string {
  return doctorTabView(state, width, 24, 0)
    .map((line) => (typeof line === 'string' ? line : lineText(line)))
    .join('\n');
}

describe('doctor view message wrapping', () => {
  test('a long check message wraps instead of truncating', () => {
    // Arrange — a warn message far wider than the 80-column terminal
    const message =
      'Claude Code deletes its session logs after 30 days by default (cleanupPeriodDays is unset) — history older than that is already gone and cannot be recollected';
    const state = stateWithChecks([
      { id: 'claude-retention', status: 'warn', message, remediation: null },
    ]);

    // Act
    const text = renderedText(state, 80);

    // Assert — the tail survives, nothing is elided
    expect(text.replace(/\s+/g, ' ')).toContain('cannot be recollected');
    expect(text).not.toContain('…');
  });

  test('remediation guidance wraps instead of truncating', () => {
    // Arrange — recovery instructions are exactly what must stay whole
    const remediation =
      'set cleanupPeriodDays in ~/.claude/settings.json to a large value and run a full scan afterwards so the ledger captures the sessions before they expire';
    const state = stateWithChecks([
      { id: 'claude-retention', status: 'fail', message: 'logs expiring', remediation },
    ]);

    // Act
    const text = renderedText(state, 80);

    // Assert
    expect(text.replace(/\s+/g, ' ')).toContain('before they expire');
    expect(text).not.toContain('…');
  });
});
