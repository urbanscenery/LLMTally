import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import initialSql from '@llmtally/core/db/migrations/001_initial.sql' with { type: 'text' };
import accountsSql from '@llmtally/core/db/migrations/002_accounts.sql' with { type: 'text' };
import fetchStateSql from '@llmtally/core/db/migrations/003_quota_fetch_state.sql' with { type: 'text' };
import { LATEST_SCHEMA_VERSION } from '@llmtally/core/db/migrate.ts';
import { openReadOnlyDatabase } from '@llmtally/core/db/connection.ts';
import { makeTempDir } from '../helpers.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..');
const CONNECTION = join(REPO_ROOT, 'packages', 'core', 'src', 'db', 'connection.ts');
const MIGRATE = join(REPO_ROOT, 'packages', 'core', 'src', 'db', 'migrate.ts');

/** A standalone process that opens the shared db and migrates it once. */
const WORKER = `
import { openDatabase } from ${JSON.stringify(CONNECTION)};
import { migrate } from ${JSON.stringify(MIGRATE)};
const db = openDatabase(process.argv[2]);
migrate(db);
db.close();
`;

/** Builds a real on-disk ledger frozen at schema version 3. */
function seedV3(dbPath: string): void {
  const db = new Database(dbPath, { create: true, strict: true });
  // Left in rollback-journal mode on purpose: the workers then race the
  // `PRAGMA journal_mode = WAL` transition (connection.ts) as well as the
  // migrations, so the busy_timeout that guards that transition is under
  // test too — not only the in-lock version recheck.
  db.exec(initialSql);
  db.exec(accountsSql);
  db.exec(fetchStateSql);
  db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '3')", []);
  db.close();
}

describe('concurrent migration', () => {
  test(
    'many processes migrating the same db all converge on one consistent schema',
    async () => {
      // Arrange — a v3 ledger and a worker that races every peer straight
      // into migration 004's ADD COLUMN, the split-schema trigger
      const dir = makeTempDir('llmtally-migrate-race-');
      const workerPath = join(dir, 'worker.ts');
      writeFileSync(workerPath, WORKER);

      for (let iteration = 0; iteration < 3; iteration += 1) {
        const dbPath = join(dir, `race-${iteration}.db`);
        seedV3(dbPath);

        // Act — six processes open and migrate the same file at once
        const workers = Array.from({ length: 6 }, () =>
          Bun.spawn([process.execPath, 'run', workerPath, dbPath], {
            cwd: REPO_ROOT,
            stdout: 'pipe',
            stderr: 'pipe',
          }),
        );
        const exits = await Promise.all(
          workers.map(async (proc) => {
            const code = await proc.exited;
            return { code, stderr: await new Response(proc.stderr).text() };
          }),
        );

        // Assert — no worker saw duplicate-column or a split meta version
        for (const exit of exits) {
          expect(exit.stderr).not.toContain('duplicate column');
          expect(exit.code).toBe(0);
        }
        const db = new Database(dbPath, { strict: true });
        const version = db
          .query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'schema_version'")
          .get();
        const integrity = db
          .query<{ integrity_check: string }, []>('PRAGMA integrity_check')
          .get();
        const journal = db
          .query<{ journal_mode: string }, []>('PRAGMA journal_mode')
          .get();
        db.close();
        expect(version?.value).toBe(String(LATEST_SCHEMA_VERSION));
        expect(integrity?.integrity_check).toBe('ok');
        // the WAL transition must have actually taken, not silently no-op'd
        expect(journal?.journal_mode.toLowerCase()).toBe('wal');

        // the read-only report path only opens a ledger at the exact
        // expected version — a split schema would strand it here
        const readOnly = openReadOnlyDatabase(dbPath, LATEST_SCHEMA_VERSION);
        readOnly.close();
      }
    },
    30_000,
  );
});
