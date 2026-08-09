import { describe, expect, test } from 'bun:test';

import { resolveOpenCodeCursor } from '@llmtally/core/parsers/opencode/cursor.ts';
import type { StoredScanState } from '@llmtally/core/scan/types.ts';

const identity = { device: 10, inode: 42 };

function state(cursorJson: StoredScanState['cursorJson']): StoredScanState {
  return {
    agent: 'opencode',
    path: '/tmp/opencode.db',
    mtime: 0,
    size: 0,
    lastOffset: 0,
    cursorJson,
  };
}

describe('resolveOpenCodeCursor', () => {
  test('resumes from a valid stored watermark bound to the same database file', () => {
    // Act & Assert
    expect(
      resolveOpenCodeCursor(state({ version: 1, updatedMs: 1000, device: 10, inode: 42 }), false, identity),
    ).toEqual({ updatedMs: 1000, resetReason: null });
  });

  test('resets on an unsupported cursor version', () => {
    // Act
    const cursor = resolveOpenCodeCursor(
      state({ version: 2, updatedMs: 1000, device: 10, inode: 42 }),
      false,
      identity,
    );

    // Assert
    expect(cursor.updatedMs).toBe(0);
    expect(cursor.resetReason).toContain('unsupported cursor version');
  });

  test('resets on a corrupt watermark value', () => {
    // Act
    const cursor = resolveOpenCodeCursor(
      state({ version: 1, updatedMs: -5, device: 10, inode: 42 }),
      false,
      identity,
    );

    // Assert
    expect(cursor.updatedMs).toBe(0);
    expect(cursor.resetReason).not.toBeNull();
  });

  test('resets when the source database identity changed', () => {
    // Act
    const cursor = resolveOpenCodeCursor(
      state({ version: 1, updatedMs: 1000, device: 10, inode: 43 }),
      false,
      identity,
    );

    // Assert
    expect(cursor.updatedMs).toBe(0);
    expect(cursor.resetReason).toContain('identity');
  });

  test('resets when the stored cursor lacks a database identity', () => {
    // Act
    const cursor = resolveOpenCodeCursor(state({ version: 1, updatedMs: 1000 }), false, identity);

    // Assert
    expect(cursor.updatedMs).toBe(0);
    expect(cursor.resetReason).toContain('identity');
  });

  test('a full rescan ignores the stored cursor without a reset warning', () => {
    // Act & Assert
    expect(
      resolveOpenCodeCursor(state({ version: 1, updatedMs: 1000, device: 10, inode: 42 }), true, identity),
    ).toEqual({ updatedMs: 0, resetReason: null });
  });

  test('a missing state starts from zero', () => {
    // Act & Assert
    expect(resolveOpenCodeCursor(null, false, identity)).toEqual({
      updatedMs: 0,
      resetReason: null,
    });
  });
});
