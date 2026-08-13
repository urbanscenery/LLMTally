import type { FileFingerprint } from '../../scan/types.ts';
import type { ClaudeUsageRecord } from './records.ts';

export interface NaturalIdContext {
  readonly fingerprint: FileFingerprint | null;
  readonly path: string;
  readonly lineStartOffset: number;
}

/**
 * The API message id is the natural key: Claude Code writes one JSONL line
 * per content block of the same assistant message, each with a distinct
 * line uuid but the same message.id and a copy of the usage block. Keying
 * on message.id collapses those copies into one ledger entry (the line
 * uuid would count every block as a separate API call). The uuid fallback
 * covers records without a message id; the requestId fallback is
 * namespaced because requestIds can repeat across sessions, using only
 * values that stay stable across rescans of an append-only file (session
 * id, device/inode, byte offset) so idempotency is preserved.
 */
export function buildNaturalId(
  record: ClaudeUsageRecord,
  context: NaturalIdContext,
): string | null {
  if (record.messageId !== null && record.messageId.length > 0) {
    return `msg:${record.messageId}`;
  }
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
