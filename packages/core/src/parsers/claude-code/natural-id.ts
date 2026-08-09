import type { FileFingerprint } from '../../scan/types.ts';
import type { ClaudeUsageRecord } from './records.ts';

export interface NaturalIdContext {
  readonly fingerprint: FileFingerprint | null;
  readonly path: string;
  readonly lineStartOffset: number;
}

/**
 * Message uuid is the natural key. The requestId fallback is namespaced
 * because requestIds can repeat across sessions; the namespace only uses
 * values that stay stable across rescans of an append-only file (session
 * id, device/inode, byte offset) so idempotency is preserved.
 */
export function buildNaturalId(
  record: ClaudeUsageRecord,
  context: NaturalIdContext,
): string | null {
  if (record.uuid !== null && record.uuid.length > 0) {
    return record.uuid;
  }
  if (record.requestId === null || record.requestId.length === 0) {
    return null;
  }
  if (record.sessionId !== null && record.sessionId.length > 0) {
    return `request:${record.requestId}:session:${record.sessionId}:offset:${context.lineStartOffset}`;
  }
  return `request:${record.requestId}:file:${fileIdentity(context)}:offset:${context.lineStartOffset}`;
}

function fileIdentity(context: NaturalIdContext): string {
  const fingerprint = context.fingerprint;
  if (fingerprint !== null && fingerprint.device !== null && fingerprint.inode !== null) {
    return `${fingerprint.device}:${fingerprint.inode}`;
  }
  return context.path;
}
