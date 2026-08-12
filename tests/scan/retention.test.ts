import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { DEFAULT_PROMPT_RETENTION_DAYS, loadPrivacyConfig } from '@llmtally/core/config/privacy.ts';
import { openDatabase } from '@llmtally/core/db/connection.ts';
import { SqliteLedgerRepository } from '@llmtally/core/db/repository.ts';
import { ClaudeCodeAdapter } from '@llmtally/core/parsers/claude-code/adapter.ts';
import { DefaultScanCoordinator } from '@llmtally/core/scan/coordinator.ts';
import { fixturePath, makeTempDir } from '../helpers.ts';

const NOW = Math.floor(Date.now() / 1000);

describe('loadPrivacyConfig', () => {
  function configWith(content: string | null): string {
    const path = join(makeTempDir(), 'config.json');
    if (content !== null) {
      writeFileSync(path, content);
    }
    return path;
  }

  test('defaults to one year when the file or section is absent or malformed', () => {
    // Assert — decided 2026-08-13: text ages out by default, numbers stay
    expect(loadPrivacyConfig(configWith(null)).promptRetentionDays).toBe(
      DEFAULT_PROMPT_RETENTION_DAYS,
    );
    expect(loadPrivacyConfig(configWith('{}')).promptRetentionDays).toBe(
      DEFAULT_PROMPT_RETENTION_DAYS,
    );
    expect(loadPrivacyConfig(configWith('not json')).promptRetentionDays).toBe(
      DEFAULT_PROMPT_RETENTION_DAYS,
    );
    for (const invalid of ['"90"', '-5', 'null', 'NaN']) {
      expect(
        loadPrivacyConfig(
          configWith(`{"privacy":{"promptRetentionDays":${invalid}}}`),
        ).promptRetentionDays,
      ).toBe(DEFAULT_PROMPT_RETENTION_DAYS);
    }
  });

  test('zero opts out and a positive value is honored', () => {
    expect(
      loadPrivacyConfig(configWith('{"privacy":{"promptRetentionDays":0}}')).promptRetentionDays,
    ).toBe(0);
    expect(
      loadPrivacyConfig(configWith('{"privacy":{"promptRetentionDays":30.9}}')).promptRetentionDays,
    ).toBe(30);
  });
});

describe('SqliteLedgerRepository.agePrompts', () => {
  function seededRepository(): { repository: SqliteLedgerRepository; db: Database } {
    const db = openDatabase(':memory:');
    const repository = new SqliteLedgerRepository(db);
    repository.migrate();
    const insert = db.prepare(
      `INSERT INTO usage_ledger
        (ts_utc, agent, model, prompt_text, input_tokens, output_tokens, natural_id, parser_version)
       VALUES (?, 'claude-code', 'fable', ?, 100, 20, ?, 1)`,
    );
    insert.run(NOW - 40 * 86_400, 'old secret prompt', 'nat-old');
    insert.run(NOW - 3_600, 'fresh prompt', 'nat-new');
    return { repository, db };
  }

  test('ages only the text: numbers, search, and newer rows survive intact', () => {
    // Arrange
    const { repository, db } = seededRepository();

    // Act
    const aged = repository.agePrompts(NOW - 30 * 86_400);

    // Assert — the words go, everything countable stays
    expect(aged).toBe(1);
    const rows = db
      .query<{ natural_id: string; prompt_text: string | null; input_tokens: number }, []>(
        'SELECT natural_id, prompt_text, input_tokens FROM usage_ledger ORDER BY ts_utc',
      )
      .all();
    expect(rows[0]?.prompt_text).toBeNull();
    expect(rows[0]?.input_tokens).toBe(100);
    expect(rows[1]?.prompt_text).toBe('fresh prompt');
    // the FTS triggers must follow the UPDATE, or search would keep
    // serving text the ledger claims to have forgotten
    const hits = (query: string): number =>
      db
        .query<{ n: number }, [string]>(
          'SELECT COUNT(*) AS n FROM prompt_fts WHERE prompt_fts MATCH ?',
        )
        .get(query)?.n ?? 0;
    expect(hits('secret')).toBe(0);
    expect(hits('fresh')).toBe(1);
    // second pass is a no-op, not a re-count
    expect(repository.agePrompts(NOW - 30 * 86_400)).toBe(0);
    repository.close();
  });
});

describe('scan-time retention wiring', () => {
  function coordinatorWith(configJson: string): {
    coordinator: DefaultScanCoordinator;
    databasePath: string;
  } {
    const dir = makeTempDir();
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, configJson);
    return {
      coordinator: new DefaultScanCoordinator({
        adapters: [new ClaudeCodeAdapter({ rootDirectory: fixturePath('claude-code') })],
        homeDirectory: '/unused',
        privacyConfigPath: configPath,
      }),
      databasePath: join(dir, 'ledger.db'),
    };
  }

  function promptStates(databasePath: string): (string | null)[] {
    const db = new Database(databasePath, { readonly: true });
    const rows = db
      .query<{ prompt_text: string | null }, []>('SELECT prompt_text FROM usage_ledger')
      .all();
    db.close();
    return rows.map((row) => row.prompt_text);
  }

  test('a scan ages fixture prompts past the configured shelf life', async () => {
    // Arrange — fixtures are pinned to 2026-08-03, well past 5 days
    const { coordinator, databasePath } = coordinatorWith(
      '{"privacy":{"promptRetentionDays":5}}',
    );

    // Act
    await coordinator.run({ agent: 'claude-code', fullRescan: false, databasePath });

    // Assert — rows exist, words do not
    const prompts = promptStates(databasePath);
    expect(prompts.length).toBeGreaterThan(0);
    expect(prompts.every((prompt) => prompt === null)).toBe(true);
  });

  test('promptRetentionDays: 0 keeps every word (the archive stance)', async () => {
    // Arrange
    const { coordinator, databasePath } = coordinatorWith(
      '{"privacy":{"promptRetentionDays":0}}',
    );

    // Act
    await coordinator.run({ agent: 'claude-code', fullRescan: false, databasePath });

    // Assert
    expect(promptStates(databasePath).some((prompt) => prompt !== null)).toBe(true);
  });
});
