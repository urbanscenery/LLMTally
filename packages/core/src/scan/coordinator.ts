import { realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

import { loadPrivacyConfig } from '../config/privacy.ts';
import { openDatabase } from '../db/connection.ts';
import { SqliteLedgerRepository } from '../db/repository.ts';
import { AntigravityCliAdapter } from '../parsers/antigravity/adapter.ts';
import { ClaudeCodeAdapter } from '../parsers/claude-code/adapter.ts';
import { ClineAdapter } from '../parsers/cline/adapter.ts';
import { CodexAdapter } from '../parsers/codex/adapter.ts';
import { GrokAdapter } from '../parsers/grok/adapter.ts';
import { OpenCodeAdapter } from '../parsers/opencode/adapter.ts';
import type { SourceAdapter } from '../parsers/types.ts';
import { acquireScanLock } from './lock.ts';
import type {
  LedgerRepository,
  ScanCoordinator,
  ScanRequest,
  ScanSummary,
  ScanWarning,
  SourceTarget,
} from './types.ts';

const MILLISECONDS_PER_SECOND = 1000;

export class UnknownAgentError extends Error {
  override readonly name = 'UnknownAgentError';

  constructor(agent: string, known: readonly string[]) {
    super(`unknown agent "${agent}"; registered agents: ${known.join(', ')}`);
  }
}

/**
 * Opening the ledger chmods the file, creates -wal/-shm sidecars, and
 * runs migrations — pointing --db at a source (e.g. the live OpenCode
 * database) would therefore WRITE to a canonical source. Discovery runs
 * before the lock/repository so this is caught first.
 */
export class LedgerPathConflictError extends Error {
  override readonly name = 'LedgerPathConflictError';

  constructor(databasePath: string, sourcePath: string) {
    super(
      `ledger path ${databasePath} is a scanned source (${sourcePath}); pick a ledger path outside every source location`,
    );
  }
}

/**
 * Marks repository/database failures so the per-target error handling
 * cannot downgrade them to recoverable warnings: a scan that could not
 * persist rows must fail loudly instead of exiting 0 with silent gaps.
 */
class FatalScanError extends Error {
  override readonly name = 'FatalScanError';

  constructor(readonly causeError: unknown) {
    super(causeError instanceof Error ? causeError.message : String(causeError));
  }
}

export interface CoordinatorOptions {
  readonly adapters: readonly SourceAdapter[];
  readonly homeDirectory?: string;
  readonly openRepository?: (databasePath: string) => LedgerRepository;
  /** Test seam: where `privacy.promptRetentionDays` is read from. */
  readonly privacyConfigPath?: string;
}

export function createDefaultCoordinator(): DefaultScanCoordinator {
  return new DefaultScanCoordinator({
    adapters: [
      new ClaudeCodeAdapter(),
      new CodexAdapter(),
      new OpenCodeAdapter(),
      new ClineAdapter(),
      new AntigravityCliAdapter(),
      new GrokAdapter(),
    ],
  });
}

export class DefaultScanCoordinator implements ScanCoordinator {
  readonly #adapters: readonly SourceAdapter[];
  readonly #homeDirectory: string;
  readonly #openRepository: (databasePath: string) => LedgerRepository;
  readonly #privacyConfigPath: string | undefined;

  constructor(options: CoordinatorOptions) {
    this.#adapters = options.adapters;
    this.#homeDirectory = options.homeDirectory ?? homedir();
    this.#openRepository =
      options.openRepository ??
      ((databasePath: string) => new SqliteLedgerRepository(openDatabase(databasePath)));
    this.#privacyConfigPath = options.privacyConfigPath;
  }

  async run(request: ScanRequest): Promise<ScanSummary> {
    const startedAtUtc = nowUtcSeconds();
    const adapters = this.#selectAdapters(request.agent);

    // discover BEFORE the lock and repository are created: the guard has
    // to run before any lock file or WAL sidecar appears near a source
    const discoveries: { adapter: SourceAdapter; targets: readonly SourceTarget[]; warnings: readonly ScanWarning[] }[] = [];
    for (const adapter of adapters) {
      const discovery = await adapter.discover({
        homeDirectory: this.#homeDirectory,
        agentFilter: request.agent,
      });
      discoveries.push({ adapter, targets: discovery.targets, warnings: discovery.warnings });
    }
    assertLedgerIsNotASource(request.databasePath, discoveries);

    const lock = acquireScanLock(`${request.databasePath}.lock`);
    try {
      const repository = this.#openRepository(request.databasePath);
      try {
        repository.migrate();
        const tally = new SummaryTally();
        for (const { adapter, targets, warnings } of discoveries) {
          tally.addWarnings(warnings);
          tally.discoveredFiles += targets.length;
          for (const target of targets) {
            try {
              await this.#scanTarget(adapter, repository, request, target, tally);
            } catch (error) {
              if (error instanceof FatalScanError) {
                throw error.causeError;
              }
              tally.addWarnings([runtimeWarning(adapter.agent, target.path, error)]);
            }
          }
        }
        this.#applyPromptRetention(repository, tally);
        return tally.toSummary(request, startedAtUtc, nowUtcSeconds());
      } finally {
        repository.close();
      }
    } finally {
      lock.release();
    }
  }

  /**
   * Prompt-text retention (D-06): after every scan, text older than the
   * configured shelf life is aged out — the words go, the numbers stay.
   * Best-effort: a failed aging pass must never fail the scan that just
   * collected fresh data, so it degrades to a warning.
   */
  #applyPromptRetention(repository: LedgerRepository, tally: SummaryTally): void {
    if (repository.agePrompts === undefined) {
      return;
    }
    const { promptRetentionDays } = loadPrivacyConfig(this.#privacyConfigPath);
    if (promptRetentionDays <= 0) {
      return;
    }
    try {
      repository.agePrompts(nowUtcSeconds() - promptRetentionDays * 86_400);
    } catch (error) {
      tally.addWarnings([
        {
          code: 'runtime',
          agent: 'ledger',
          path: null,
          offset: null,
          message: `prompt retention pass failed: ${error instanceof Error ? error.message : String(error)}`,
          recoverable: true,
        },
      ]);
    }
  }

  #selectAdapters(agent: string | null): readonly SourceAdapter[] {
    if (agent === null) {
      return this.#adapters;
    }
    const selected = this.#adapters.filter((adapter) => adapter.agent === agent);
    if (selected.length === 0) {
      throw new UnknownAgentError(
        agent,
        this.#adapters.map((adapter) => adapter.agent),
      );
    }
    return selected;
  }

  async #scanTarget(
    adapter: SourceAdapter,
    repository: LedgerRepository,
    request: ScanRequest,
    target: SourceTarget,
    tally: SummaryTally,
  ): Promise<void> {
    const state = request.fullRescan
      ? null
      : guardRepository(() => repository.getScanState(adapter.agent, target.path));
    let sourceMissing = false;
    for await (const batch of adapter.scan(target, state, {
      fullRescan: request.fullRescan,
      scanCeilingBytes: null,
    })) {
      const result = guardRepository(() => repository.commitBatch({ target, batch }));
      tally.insertedRows += result.insertedRows;
      tally.ignoredRows += result.ignoredRows;
      tally.addWarnings(batch.warnings);
      if (batch.tailPending) {
        tally.pendingTails += 1;
      }
      if (batch.warnings.some((warning) => warning.code === 'source_missing')) {
        sourceMissing = true;
      }
    }
    if (sourceMissing) {
      tally.missingFiles += 1;
    } else {
      tally.scannedFiles += 1;
    }
  }
}

const MAX_WARNING_SAMPLES = 200;

class SummaryTally {
  discoveredFiles = 0;
  scannedFiles = 0;
  missingFiles = 0;
  insertedRows = 0;
  ignoredRows = 0;
  pendingTails = 0;
  #warningTotal = 0;
  readonly #warningCounts: Record<string, number> = {};
  readonly #warningSamples: ScanWarning[] = [];

  /**
   * Real scans can emit tens of thousands of recoverable warnings, so the
   * tally keeps per-code counts plus a bounded sample list instead of
   * holding every warning object in memory for the whole scan.
   */
  addWarnings(warnings: readonly ScanWarning[]): void {
    for (const warning of warnings) {
      this.#warningTotal += 1;
      this.#warningCounts[warning.code] = (this.#warningCounts[warning.code] ?? 0) + 1;
      if (this.#warningSamples.length < MAX_WARNING_SAMPLES) {
        this.#warningSamples.push(warning);
      }
    }
  }

  toSummary(request: ScanRequest, startedAtUtc: number, finishedAtUtc: number): ScanSummary {
    return {
      agent: request.agent,
      databasePath: request.databasePath,
      discoveredFiles: this.discoveredFiles,
      scannedFiles: this.scannedFiles,
      missingFiles: this.missingFiles,
      insertedRows: this.insertedRows,
      ignoredRows: this.ignoredRows,
      malformedLines: this.#warningCounts['malformed_json'] ?? 0,
      pendingTails: this.pendingTails,
      warnings: this.#warningSamples,
      warningCounts: { ...this.#warningCounts },
      warningTotal: this.#warningTotal,
      startedAtUtc,
      finishedAtUtc,
    };
  }
}

function guardRepository<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    throw new FatalScanError(error);
  }
}

interface PathIdentity {
  readonly resolvedPath: string;
  readonly device: number | null;
  readonly inode: number | null;
}

function pathIdentity(path: string): PathIdentity {
  try {
    const resolvedPath = realpathSync(path);
    const stats = statSync(resolvedPath);
    return { resolvedPath, device: stats.dev, inode: stats.ino };
  } catch {
    return { resolvedPath: resolve(path), device: null, inode: null };
  }
}

function assertLedgerIsNotASource(
  databasePath: string,
  discoveries: readonly { targets: readonly SourceTarget[] }[],
): void {
  const ledger = pathIdentity(databasePath);
  for (const discovery of discoveries) {
    for (const target of discovery.targets) {
      const source = pathIdentity(target.path);
      const samePath = ledger.resolvedPath === source.resolvedPath;
      const sameFile =
        ledger.device !== null &&
        ledger.device === source.device &&
        ledger.inode === source.inode;
      if (samePath || sameFile) {
        throw new LedgerPathConflictError(databasePath, target.path);
      }
    }
  }
}

function runtimeWarning(agent: string, path: string, error: unknown): ScanWarning {
  return {
    code: 'runtime',
    agent,
    path,
    offset: null,
    message: `scan failed for this source: ${error instanceof Error ? error.message : String(error)}`,
    recoverable: true,
  };
}

function nowUtcSeconds(): number {
  return Math.floor(Date.now() / MILLISECONDS_PER_SECOND);
}
