import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

import { AccountVault, defaultVaultDir, vaultPaths } from '../accounts/vault.ts';

import { LedgerUnavailableError, openReadOnlyDatabase } from '../db/connection.ts';
import { ledgerSpaceReport } from '../db/maintenance.ts';
import { LATEST_SCHEMA_VERSION } from '../db/migrate.ts';
import { defaultAntigravityStoreDir, listAntigravityAccounts } from '../quota/antigravity.ts';
import { defaultGrokCredentials, isGrokTokenExpired } from '../quota/grok.ts';

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'skip';

export interface DoctorCheck {
  readonly id: string;
  readonly status: CheckStatus;
  readonly message: string;
  readonly remediation?: string;
}

export interface DoctorOptions {
  readonly databasePath: string;
  readonly homeDirectory?: string;
}

const STALE_PRICING_SECONDS = 30 * 24 * 3600;

/**
 * Diagnostics are strictly read-only and offline: no network calls, no
 * Keychain access, no file modification. Output never contains prompt
 * text, tokens, emails, or account ids.
 */
export function runDoctorChecks(options: DoctorOptions): readonly DoctorCheck[] {
  const home = options.homeDirectory ?? homedir();
  const checks: DoctorCheck[] = [];

  checks.push({
    id: 'runtime.bun',
    status: 'pass',
    message: `Bun ${Bun.version}`,
  });

  checks.push(...ledgerChecks(options.databasePath));
  checks.push(ledgerSpaceCheck(options.databasePath));
  checks.push(...permissionChecks(options.databasePath));
  checks.push(lockCheck(options.databasePath));
  checks.push(...claudeChecks(home));
  checks.push(directoryCheck('source.codex', join(home, '.codex', 'sessions'), 'Codex CLI'));
  checks.push(
    fileCheck('source.opencode', join(home, '.local', 'share', 'opencode', 'opencode.db'), 'OpenCode'),
  );
  checks.push(directoryCheck('source.cline', join(home, '.cline', 'data', 'sessions'), 'Cline'));
  checks.push(
    directoryCheck(
      'source.antigravity-cli',
      join(home, '.gemini', 'antigravity-cli', 'conversations'),
      'Antigravity CLI',
    ),
  );
  checks.push(directoryCheck('source.grok', join(home, '.grok', 'sessions'), 'Grok Build'));
  checks.push(...pricingChecks(home));
  checks.push(quotaAntigravityCheck(home));
  checks.push(quotaGrokCheck(home));
  checks.push(...vaultChecks(home));
  checks.push(daemonCheck(home));
  return checks;
}

/** Space thresholds for suggesting a compact (both must be exceeded). */
const RECLAIMABLE_WARN_BYTES = 50 * 1024 * 1024;
const RECLAIMABLE_WARN_RATIO = 0.2;

function formatMb(bytes: number): string {
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

/**
 * How big the ledger is and how much of it a compact would give back.
 * Deletes and the prompt-retention pass free pages that SQLite reuses
 * but never returns to the filesystem (D-07); past a threshold the user
 * is pointed at the V action instead of us vacuuming behind their back.
 */
function ledgerSpaceCheck(databasePath: string): DoctorCheck {
  let report: ReturnType<typeof ledgerSpaceReport>;
  try {
    report = ledgerSpaceReport(databasePath);
  } catch {
    return { id: 'ledger.space', status: 'skip', message: 'ledger space is unreadable' };
  }
  if (report === null) {
    return { id: 'ledger.space', status: 'skip', message: 'no ledger yet' };
  }
  const detail = `ledger ${formatMb(report.fileBytes)} (reclaimable ${formatMb(report.reclaimableBytes)}, wal ${formatMb(report.walBytes)})`;
  const shouldCompact =
    report.reclaimableBytes > RECLAIMABLE_WARN_BYTES &&
    report.reclaimableBytes > report.fileBytes * RECLAIMABLE_WARN_RATIO;
  if (shouldCompact) {
    return {
      id: 'ledger.space',
      status: 'warn',
      message: detail,
      remediation: 'press V to compact the ledger and return the space',
    };
  }
  return { id: 'ledger.space', status: 'pass', message: detail };
}

/**
 * The switchable-account vault. Credentials live here, so the mode of
 * every directory and file it owns is worth checking; output never
 * names an account.
 */
function vaultChecks(home: string): DoctorCheck[] {
  const dir = defaultVaultDir(home);
  const vault = new AccountVault({ dir });
  let entries: readonly { readonly backend: string }[];
  try {
    entries = vault.list();
  } catch {
    return [{ id: 'vault.registry', status: 'warn', message: 'account vault registry is unreadable' }];
  }
  if (entries.length === 0) {
    return [
      {
        id: 'vault.registry',
        status: 'skip',
        message: 'no stored accounts',
        remediation: 'open the Accounts tab and press n while logged in to store an account, then s to switch',
      },
    ];
  }
  const keychainBacked = entries.filter((entry) => entry.backend === 'keychain').length;
  const checks: DoctorCheck[] = [
    {
      id: 'vault.registry',
      status: 'pass',
      message: `${entries.length} stored account(s), ${keychainBacked} in the keychain`,
    },
  ];
  for (const path of vaultPaths(dir)) {
    checks.push(...modeCheck(`vault.mode.${basename(path)}`, path, 0o700));
  }
  return checks;
}

function modeCheck(id: string, path: string, expected: number): DoctorCheck[] {
  try {
    const mode = statSync(path).mode & 0o777;
    return [
      mode === expected
        ? { id, status: 'pass', message: `${path} is ${expected.toString(8)}` }
        : {
            id,
            status: 'warn',
            message: `${path} is ${mode.toString(8)}, expected ${expected.toString(8)}`,
            remediation: `chmod ${expected.toString(8)} ${path}`,
          },
    ];
  } catch {
    return [];
  }
}

/** Quota-source stores; messages stay free of emails and account ids. */
function quotaAntigravityCheck(home: string): DoctorCheck {
  const storeDir = defaultAntigravityStoreDir(home);
  const accounts = listAntigravityAccounts(storeDir);
  if (accounts.length === 0) {
    return {
      id: 'quota.antigravity',
      status: 'skip',
      message: 'no antigravity-usage store',
      remediation: 'install the antigravity-usage CLI and run "antigravity-usage login" for quota',
    };
  }
  let validTokens = 0;
  for (const account of accounts) {
    const raw = readFileSafe(join(account.dir, 'tokens.json'));
    if (raw === null) {
      continue;
    }
    try {
      const parsed = JSON.parse(raw) as { expiresAt?: unknown };
      if (typeof parsed.expiresAt === 'number' && parsed.expiresAt > Date.now()) {
        validTokens += 1;
      }
    } catch {
      // unreadable tokens count as expired
    }
  }
  if (validTokens === 0) {
    return {
      id: 'quota.antigravity',
      status: 'warn',
      message: `${accounts.length} account(s) but no valid access token — quota shows cached values only`,
      remediation: 'run "antigravity-usage refresh" (or login) for live quota',
    };
  }
  return {
    id: 'quota.antigravity',
    status: 'pass',
    message: `${accounts.length} account(s), ${validTokens} with a valid token`,
  };
}

/**
 * The Grok session token lives ~6 hours and the CLI renews it lazily,
 * so a machine that has not run `grok` for a while simply holds an
 * expired one. That is the ordinary reason the gauge stops updating,
 * and the fix is to run `grok` — not to sign in again.
 */
function quotaGrokCheck(home: string): DoctorCheck {
  const credentials = defaultGrokCredentials(home);
  if (credentials.length === 0) {
    return {
      id: 'quota.grok',
      status: 'skip',
      message: 'no Grok login',
      remediation: 'run "grok login" to read subscription quota',
    };
  }
  const now = Math.floor(Date.now() / 1000);
  const live = credentials.filter((credential) => !isGrokTokenExpired(credential, now)).length;
  if (live === 0) {
    return {
      id: 'quota.grok',
      status: 'warn',
      message: `${credentials.length} login(s), every session token expired — quota shows stored values only`,
      remediation: 'run "grok" once; the CLI renews its own token (no re-login needed)',
    };
  }
  return {
    id: 'quota.grok',
    status: 'pass',
    message: `${credentials.length} login(s), ${live} with a live session token`,
  };
}

function ledgerChecks(databasePath: string): DoctorCheck[] {
  try {
    const db = openReadOnlyDatabase(databasePath, LATEST_SCHEMA_VERSION);
    try {
      const rows = db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM usage_ledger').get();
      let fts: { n: number } | null = null;
      try {
        fts = db
          .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM prompt_fts WHERE prompt_fts MATCH 'llmtallyselftest'")
          .get();
      } catch {
        fts = null;
      }
      return [
        {
          id: 'ledger.schema',
          status: 'pass',
          message: `ledger v${LATEST_SCHEMA_VERSION} with ${rows?.n ?? 0} rows`,
        },
        {
          id: 'ledger.fts',
          status: fts === null ? 'fail' : 'pass',
          message: fts === null ? 'prompt_fts is not queryable' : 'prompt_fts responds to MATCH',
        },
      ];
    } finally {
      db.close();
    }
  } catch (error) {
    const message = error instanceof LedgerUnavailableError ? error.message : String(error);
    return [
      {
        id: 'ledger.schema',
        status: 'fail',
        message,
        remediation: 'restart llmtally to collect and migrate the ledger',
      },
    ];
  }
}

function permissionChecks(databasePath: string): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const targets: [string, string, number][] = [
    ['privacy.dir', join(databasePath, '..'), 0o700],
    ['privacy.db', databasePath, 0o600],
    ['privacy.wal', `${databasePath}-wal`, 0o600],
    ['privacy.shm', `${databasePath}-shm`, 0o600],
  ];
  for (const [id, path, expected] of targets) {
    try {
      const mode = statSync(path).mode & 0o777;
      checks.push(
        mode === expected
          ? { id, status: 'pass', message: `${path} is ${expected.toString(8)}` }
          : {
              id,
              status: 'warn',
              message: `${path} mode is ${mode.toString(8)} (expected ${expected.toString(8)})`,
              remediation: `chmod ${expected.toString(8)} "${path}"`,
            },
      );
    } catch {
      checks.push({ id, status: 'skip', message: `${path} does not exist` });
    }
  }
  return checks;
}

function lockCheck(databasePath: string): DoctorCheck {
  const lockPath = `${databasePath}.lock`;
  if (!existsSync(lockPath)) {
    return { id: 'scan.lock', status: 'pass', message: 'no scan lock held' };
  }
  const pid = Number.parseInt(readFileSafe(lockPath) ?? '', 10);
  const alive = Number.isInteger(pid) && isPidAlive(pid);
  return alive
    ? { id: 'scan.lock', status: 'pass', message: `scan running (pid ${pid})` }
    : {
        id: 'scan.lock',
        status: 'warn',
        message: 'stale scan lock found (holder is gone); next scan will take it over',
      };
}

function claudeChecks(home: string): DoctorCheck[] {
  const checks: DoctorCheck[] = [
    directoryCheck('source.claude', join(home, '.claude', 'projects'), 'Claude Code'),
  ];
  const settings = readFileSafe(join(home, '.claude', 'settings.json'));
  let retention: number | null = null;
  if (settings !== null) {
    try {
      const parsed = JSON.parse(settings) as { cleanupPeriodDays?: unknown };
      retention = typeof parsed.cleanupPeriodDays === 'number' ? parsed.cleanupPeriodDays : null;
    } catch {
      retention = null;
    }
  }
  if (retention === null) {
    checks.push({
      id: 'claude.retention',
      status: 'warn',
      message: 'cleanupPeriodDays is not set — Claude Code deletes logs after 30 days',
      remediation: 'set "cleanupPeriodDays": 99999 in ~/.claude/settings.json or scan at least daily',
    });
  } else {
    checks.push({
      id: 'claude.retention',
      status: retention >= 60 ? 'pass' : 'warn',
      message: `cleanupPeriodDays = ${retention}`,
    });
  }
  return checks;
}

function pricingChecks(home: string): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  for (const source of ['litellm', 'openrouter'] as const) {
    const path = join(home, '.llmtally', 'cache', `pricing-${source}.json`);
    const raw = readFileSafe(path);
    if (raw === null) {
      checks.push({ id: `pricing.${source}`, status: 'skip', message: 'no cache yet' });
      continue;
    }
    try {
      const envelope = JSON.parse(raw) as { validatedAtUtc?: number };
      const age = Math.floor(Date.now() / 1000) - (envelope.validatedAtUtc ?? 0);
      checks.push({
        id: `pricing.${source}`,
        status: age > STALE_PRICING_SECONDS ? 'warn' : 'pass',
        message: `cache validated ${Math.floor(age / 3600)}h ago`,
      });
    } catch {
      checks.push({ id: `pricing.${source}`, status: 'warn', message: 'cache is not valid JSON' });
    }
  }
  return checks;
}

/**
 * Read-only: file presence per platform backend, never a launchctl or
 * systemctl spawn. The remediation names the TUI action — there is no
 * CLI subcommand to run (that reference outlived the CLI's removal).
 */
function daemonCheck(home: string): DoctorCheck {
  if (process.platform === 'darwin') {
    const plist = join(home, 'Library', 'LaunchAgents', 'com.llmtally.scan.plist');
    return existsSync(plist)
      ? { id: 'daemon.plist', status: 'pass', message: `installed at ${plist}` }
      : {
          id: 'daemon.plist',
          status: 'skip',
          message: 'background collection agent is not installed',
          remediation: 'press D on this tab to install it (optional)',
        };
  }
  if (process.platform === 'linux') {
    const timer = join(home, '.config', 'systemd', 'user', 'llmtally-scan.timer');
    return existsSync(timer)
      ? { id: 'daemon.systemd', status: 'pass', message: `installed at ${timer}` }
      : {
          id: 'daemon.systemd',
          status: 'skip',
          message: 'background collection timer is not installed',
          remediation: 'press D on this tab to install it (optional)',
        };
  }
  return {
    id: 'daemon.unsupported',
    status: 'skip',
    message: 'background collection has no backend on this platform (macOS launchd, Linux systemd only)',
  };
}

function directoryCheck(id: string, path: string, label: string): DoctorCheck {
  try {
    const stats = statSync(path);
    return stats.isDirectory()
      ? { id, status: 'pass', message: `${label} detected at ${path}` }
      : { id, status: 'fail', message: `${path} is not a directory` };
  } catch {
    return { id, status: 'skip', message: `${label} not detected` };
  }
}

function fileCheck(id: string, path: string, label: string): DoctorCheck {
  try {
    const stats = statSync(path);
    return stats.isFile()
      ? { id, status: 'pass', message: `${label} detected at ${path}` }
      : { id, status: 'fail', message: `${path} is not a regular file` };
  } catch {
    return { id, status: 'skip', message: `${label} not detected` };
  }
}

function readFileSafe(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
