import type { StoredScanState } from '../../scan/types.ts';
import { isNonNegativeInteger } from '../shared.ts';
import { OPENCODE_CURSOR_VERSION } from './constants.ts';

export interface OpenCodeSourceIdentity {
  readonly device: number;
  readonly inode: number;
}

export interface OpenCodeCursorState {
  /** Inclusive time_updated watermark in epoch milliseconds. */
  readonly updatedMs: number;
  readonly resetReason: string | null;
}

/**
 * The watermark is compared inclusively (>=) so an assistant row that
 * completes within the same millisecond as the previous boundary is not
 * lost; the resulting boundary re-reads dedupe via natural_id. A cursor
 * bound to a different database file (replaced or restored source) must
 * reset — its timestamps say nothing about the new file's contents.
 */
export function resolveOpenCodeCursor(
  state: StoredScanState | null,
  fullRescan: boolean,
  identity: OpenCodeSourceIdentity,
): OpenCodeCursorState {
  if (fullRescan || state === null) {
    return { updatedMs: 0, resetReason: null };
  }
  const cursor = state.cursorJson;
  if (cursor.version !== OPENCODE_CURSOR_VERSION) {
    return { updatedMs: 0, resetReason: 'unsupported cursor version' };
  }
  if (!isNonNegativeInteger(cursor.updatedMs)) {
    return { updatedMs: 0, resetReason: 'stored watermark is not a non-negative integer' };
  }
  if (!isNonNegativeInteger(cursor.device) || !isNonNegativeInteger(cursor.inode)) {
    return { updatedMs: 0, resetReason: 'stored cursor has no source database identity' };
  }
  if (cursor.device !== identity.device || cursor.inode !== identity.inode) {
    return { updatedMs: 0, resetReason: 'source database identity (device/inode) changed' };
  }
  return { updatedMs: cursor.updatedMs, resetReason: null };
}
