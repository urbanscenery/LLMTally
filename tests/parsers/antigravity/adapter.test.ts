import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { join } from 'node:path';

import type { LedgerEntry } from '@llmtally/core/domain/types.ts';
import { AntigravityCliAdapter } from '@llmtally/core/parsers/antigravity/adapter.ts';
import { resolvePromptForGeneration } from '@llmtally/core/parsers/antigravity/prompts.ts';
import {
  decodeMessage,
  decodePackedVarints,
  firstVarint,
} from '@llmtally/core/parsers/antigravity/proto.ts';
import {
  ANTIGRAVITY_PARSER_VERSION,
  parseGenMetadataBlob,
  parseGenStepIndices,
  parseStepPayloadPrompt,
} from '@llmtally/core/parsers/antigravity/records.ts';
import type { ScanBatch, StoredScanState } from '@llmtally/core/scan/types.ts';
import { makeTempDir } from '../../helpers.ts';

// --- minimal protobuf writer for fixtures ---
function varint(value: number): number[] {
  const out: number[] = [];
  let remaining = value;
  do {
    let byte = remaining % 128;
    remaining = Math.floor(remaining / 128);
    if (remaining > 0) {
      byte |= 0x80;
    }
    out.push(byte);
  } while (remaining > 0);
  return out;
}
function field(fieldNumber: number, wireType: number): number[] {
  return varint(fieldNumber * 8 + wireType);
}
function varintField(fieldNumber: number, value: number): number[] {
  return [...field(fieldNumber, 0), ...varint(value)];
}
function bytesField(fieldNumber: number, payload: number[] | Uint8Array): number[] {
  const body = [...payload];
  return [...field(fieldNumber, 2), ...varint(body.length), ...body];
}
function stringField(fieldNumber: number, value: string): number[] {
  return bytesField(fieldNumber, [...new TextEncoder().encode(value)]);
}

interface UsageSpec {
  readonly fixedInput: number;
  readonly newInput: number;
  readonly cacheRead: number;
  readonly output: number;
  readonly reasoning: number;
  readonly total?: number;
  readonly responseId?: string | null;
  readonly model?: string;
  readonly tsUtc?: number;
  /** steps.idx values this generation covers (gen blob #2, packed). */
  readonly steps?: readonly number[];
}

function genBlob(spec: UsageSpec): Uint8Array {
  const usage = [
    ...varintField(1, spec.fixedInput),
    ...varintField(2, spec.newInput),
    ...varintField(3, spec.total ?? spec.output + spec.reasoning),
    ...varintField(5, spec.cacheRead),
    ...varintField(9, spec.output),
    ...varintField(10, spec.reasoning),
    ...(spec.responseId === null ? [] : stringField(11, spec.responseId ?? 'resp-1')),
  ];
  const timestamp = bytesField(9, bytesField(4, varintField(1, spec.tsUtc ?? 1_784_905_354)));
  const generation = [
    ...bytesField(4, usage),
    ...timestamp,
    ...stringField(19, spec.model ?? 'gemini-3.6-flash'),
  ];
  const covered =
    spec.steps === undefined ? [] : bytesField(2, spec.steps.flatMap((idx) => varint(idx)));
  return new Uint8Array([...bytesField(1, generation), ...covered]);
}

const USER_INPUT_STEP_TYPE = 14;

interface PromptStepSpec {
  readonly idx: number;
  readonly text: string;
  readonly tsUtc?: number | null;
  /** Encodes the text only in the #19.#3.#1 echo, not #19.#2. */
  readonly echoOnly?: boolean;
  /** Overrides the payload's own step-type field. */
  readonly payloadType?: number;
}

function promptStepBlob(spec: PromptStepSpec): Uint8Array {
  const stamp =
    spec.tsUtc === null
      ? []
      : bytesField(5, bytesField(1, [...varintField(1, spec.tsUtc ?? 1_784_905_000), ...varintField(2, 5)]));
  const input =
    spec.echoOnly === true
      ? bytesField(3, stringField(1, spec.text))
      : [...stringField(2, spec.text), ...bytesField(3, stringField(1, spec.text))];
  return new Uint8Array([
    ...varintField(1, spec.payloadType ?? USER_INPUT_STEP_TYPE),
    ...varintField(4, 3),
    ...stamp,
    ...bytesField(19, input),
  ]);
}

interface StepRow {
  readonly idx: number;
  readonly stepType: number;
  readonly payload: Uint8Array | null;
}

function promptStep(spec: PromptStepSpec): StepRow {
  return { idx: spec.idx, stepType: USER_INPUT_STEP_TYPE, payload: promptStepBlob(spec) };
}

interface ConversationDbOptions {
  readonly steps?: readonly StepRow[];
  /** Simulates an older database that has no steps table at all. */
  readonly withoutStepsTable?: boolean;
}

function createConversationDb(
  root: string,
  name: string,
  blobs: readonly Uint8Array[],
  options: ConversationDbOptions = {},
): string {
  const path = join(root, `${name}.db`);
  const db = new Database(path, { create: true, strict: true });
  db.exec(`CREATE TABLE trajectory_meta (trajectory_id TEXT, cascade_id TEXT, trajectory_type INTEGER, source INTEGER);
    CREATE TABLE gen_metadata (idx INTEGER, data BLOB, size INTEGER);`);
  if (options.withoutStepsTable !== true) {
    db.exec(
      'CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER NOT NULL DEFAULT 0, status INTEGER NOT NULL DEFAULT 0, step_payload BLOB);',
    );
  }
  db.run('INSERT INTO trajectory_meta VALUES (?, ?, 4, 17)', [`traj-${name}`, `casc-${name}`]);
  blobs.forEach((blob, index) => {
    db.run('INSERT INTO gen_metadata VALUES (?, ?, ?)', [index, blob, blob.byteLength]);
  });
  for (const step of options.steps ?? []) {
    db.run('INSERT INTO steps (idx, step_type, status, step_payload) VALUES (?, ?, 3, ?)', [
      step.idx,
      step.stepType,
      step.payload,
    ]);
  }
  db.close();
  return path;
}

function warningCodes(batches: readonly ScanBatch[]): readonly string[] {
  return batches.flatMap((batch) => batch.warnings.map((warning) => warning.code));
}

async function scanAll(
  root: string,
  state: StoredScanState | null = null,
): Promise<{ entries: LedgerEntry[]; batches: ScanBatch[] }> {
  const adapter = new AntigravityCliAdapter({ rootDirectory: root });
  const discovery = await adapter.discover({ homeDirectory: '/unused', agentFilter: null });
  const entries: LedgerEntry[] = [];
  const batches: ScanBatch[] = [];
  for (const target of discovery.targets) {
    for await (const batch of adapter.scan(target, state, { fullRescan: false, scanCeilingBytes: null })) {
      batches.push(batch);
      entries.push(...batch.entries);
    }
  }
  return { entries, batches };
}

describe('protobuf reader', () => {
  test('round-trips varints and rejects truncated messages', () => {
    // Act
    const decoded = decodeMessage(new Uint8Array(varintField(3, 1071)));

    // Assert
    expect(decoded !== null && firstVarint(decoded, 3)).toBe(1071);
    expect(decodeMessage(new Uint8Array([0x0a, 0xff]))).toBeNull();
  });
});

describe('parseGenMetadataBlob', () => {
  test('extracts the pinned field map', () => {
    // Act
    const parsed = parseGenMetadataBlob(
      genBlob({ fixedInput: 1071, newInput: 30402, cacheRead: 100, output: 518, reasoning: 49 }),
    );

    // Assert
    expect(parsed).toEqual({
      kind: 'usage',
      model: 'gemini-3.6-flash',
      tsUtc: 1_784_905_354,
      responseId: 'resp-1',
      inputTokens: 31_473,
      cacheRead: 100,
      outputTokens: 518,
      reasoningTokens: 49,
    });
  });

  test('fails closed when the output invariant breaks (schema drift guard)', () => {
    // Act
    const parsed = parseGenMetadataBlob(
      genBlob({ fixedInput: 1, newInput: 1, cacheRead: 0, output: 10, reasoning: 5, total: 99 }),
    );

    // Assert
    expect(parsed).toMatchObject({ kind: 'invalid' });
  });

  test('zero usage rows are skipped silently', () => {
    // Act & Assert
    expect(
      parseGenMetadataBlob(
        genBlob({ fixedInput: 0, newInput: 0, cacheRead: 0, output: 0, reasoning: 0 }),
      ),
    ).toEqual({ kind: 'skipped' });
  });
});

describe('packed varints and generation step indices', () => {
  test('decodes packed step indices and fails closed on a truncated element', () => {
    // Act
    const indices = parseGenStepIndices(
      genBlob({ fixedInput: 1, newInput: 1, cacheRead: 0, output: 1, reasoning: 0, steps: [10, 11, 300] }),
    );

    // Assert
    expect(indices).toEqual([10, 11, 300]);
    expect(decodePackedVarints(new Uint8Array([0x0a, 0xff]))).toBeNull();
    expect(decodePackedVarints(new Uint8Array([]))).toEqual([]);
  });

  test('a generation without the step-index field yields null, not an empty list', () => {
    // Act & Assert
    expect(
      parseGenStepIndices(genBlob({ fixedInput: 1, newInput: 1, cacheRead: 0, output: 1, reasoning: 0 })),
    ).toBeNull();
  });
});

describe('parseStepPayloadPrompt', () => {
  test('reads the prompt text and step timestamp from a user-input step', () => {
    // Act
    const parsed = parseStepPayloadPrompt(promptStepBlob({ idx: 0, text: '헬로모바일 이벤트 분석', tsUtc: 1_782_719_213 }));

    // Assert
    expect(parsed).toEqual({ kind: 'prompt', text: '헬로모바일 이벤트 분석', tsUtc: 1_782_719_213 });
  });

  test('falls back to the echoed copy when the primary text field is absent', () => {
    // Act
    const parsed = parseStepPayloadPrompt(promptStepBlob({ idx: 0, text: 'echo only', echoOnly: true }));

    // Assert
    expect(parsed).toMatchObject({ kind: 'prompt', text: 'echo only' });
  });

  test('a payload of another step type is skipped and a textless one is invalid', () => {
    // Arrange
    const otherType = promptStepBlob({ idx: 0, text: 'tool call', payloadType: 8 });
    const textless = new Uint8Array([...varintField(1, USER_INPUT_STEP_TYPE), ...bytesField(19, stringField(2, '   '))]);

    // Act & Assert
    expect(parseStepPayloadPrompt(otherType)).toEqual({ kind: 'skipped' });
    expect(parseStepPayloadPrompt(textless)).toMatchObject({ kind: 'invalid' });
    expect(parseStepPayloadPrompt(new Uint8Array([0xde, 0xad, 0xbe]))).toMatchObject({ kind: 'invalid' });
  });
});

describe('resolvePromptForGeneration', () => {
  const prompts = [
    { idx: 0, tsUtc: 100, text: 'first' },
    { idx: 20, tsUtc: 200, text: 'second' },
    { idx: 28, tsUtc: null, text: 'third (no stamp)' },
  ];

  test('picks the last user-input step before the smallest covered index', () => {
    // Act & Assert — mirrors the measured multi-prompt conversation
    expect(resolvePromptForGeneration(prompts, [3, 4], 999)).toEqual({ idx: 0, text: 'first' });
    expect(resolvePromptForGeneration(prompts, [23, 24], 999)).toEqual({ idx: 20, text: 'second' });
    expect(resolvePromptForGeneration(prompts, [35, 32], 999)).toEqual({ idx: 28, text: 'third (no stamp)' });
  });

  test('a generation covering steps before any prompt resolves to nothing', () => {
    // Act & Assert
    expect(resolvePromptForGeneration(prompts, [0], 999)).toBeNull();
    expect(resolvePromptForGeneration([], [5], 999)).toBeNull();
  });

  test('without step indices the latest stamped prompt at or before the generation wins', () => {
    // Act & Assert — the unstamped third prompt can never win this way
    expect(resolvePromptForGeneration(prompts, null, 150)).toEqual({ idx: 0, text: 'first' });
    expect(resolvePromptForGeneration(prompts, [], 200)).toEqual({ idx: 20, text: 'second' });
    expect(resolvePromptForGeneration(prompts, null, 50)).toBeNull();
  });
});

describe('AntigravityCliAdapter', () => {
  test('collects generations with separate reasoning tokens and response-id keys', async () => {
    // Arrange
    const root = makeTempDir();
    createConversationDb(root, 'conv1', [
      genBlob({ fixedInput: 1071, newInput: 30402, cacheRead: 0, output: 518, reasoning: 49, responseId: 'r1' }),
      genBlob({ fixedInput: 1071, newInput: 100, cacheRead: 28614, output: 16, reasoning: 52, responseId: 'r2' }),
    ]);

    // Act
    const { entries } = await scanAll(root);

    // Assert
    expect(entries.map((entry) => entry.naturalId)).toEqual([
      'traj-conv1:response:r1',
      'traj-conv1:response:r2',
    ]);
    expect(entries[0]).toMatchObject({
      agent: 'antigravity-cli',
      provider: 'google',
      model: 'gemini-3.6-flash',
      inputTokens: 31_473,
      outputTokens: 518,
      reasoningTokens: 49,
      cacheWrite: 0,
      costUsd: null,
      promptText: null,
      promptKey: null,
      sessionId: 'casc-conv1',
      tsUtc: 1_784_905_354,
      parserVersion: ANTIGRAVITY_PARSER_VERSION,
    });
  });

  test('an unchanged database is skipped via the wal-aware fingerprint', async () => {
    // Arrange
    const root = makeTempDir();
    const path = createConversationDb(root, 'conv1', [
      genBlob({ fixedInput: 1, newInput: 2, cacheRead: 0, output: 3, reasoning: 0, responseId: 'r1' }),
    ]);
    const first = await scanAll(root);
    const last = first.batches[first.batches.length - 1];
    const state: StoredScanState = {
      agent: 'antigravity-cli',
      path,
      mtime: last?.sourceMtime ?? 0,
      size: last?.sourceSize ?? 0,
      lastOffset: 0,
      cursorJson: last?.nextCursor ?? {},
    };

    // Act
    const second = await scanAll(root, state);

    // Assert
    expect(second.entries).toHaveLength(0);
    expect(second.batches[0]?.nextOffset).toBe(0);
  });

  test('undecodable blobs warn without stopping the healthy rows', async () => {
    // Arrange
    const root = makeTempDir();
    const good = genBlob({ fixedInput: 1, newInput: 5, cacheRead: 0, output: 2, reasoning: 1, responseId: 'ok' });
    createConversationDb(root, 'conv1', [new Uint8Array([0xde, 0xad, 0xbe]), good]);

    // Act
    const { entries, batches } = await scanAll(root);

    // Assert
    expect(entries).toHaveLength(1);
    expect(batches.flatMap((batch) => batch.warnings.map((warning) => warning.code))).toContain(
      'invalid_record',
    );
  });

  test('duplicate or missing response ids fall back to idx keys with a warning', async () => {
    // Arrange
    const root = makeTempDir();
    createConversationDb(root, 'conv1', [
      genBlob({ fixedInput: 1, newInput: 5, cacheRead: 0, output: 2, reasoning: 0, responseId: 'dup' }),
      genBlob({ fixedInput: 1, newInput: 6, cacheRead: 0, output: 3, reasoning: 0, responseId: 'dup' }),
      genBlob({ fixedInput: 1, newInput: 7, cacheRead: 0, output: 4, reasoning: 0, responseId: null }),
    ]);

    // Act
    const { entries, batches } = await scanAll(root);

    // Assert — the duplicate response is SKIPPED (double counting would
    // inflate usage); only the genuinely id-less row uses the idx fallback
    expect(entries.map((entry) => entry.naturalId)).toEqual([
      'traj-conv1:response:dup',
      'traj-conv1:idx:2',
    ]);
    expect(batches.flatMap((batch) => batch.warnings.map((warning) => warning.code))).toContain(
      'natural_id_collision',
    );
  });

  test('a usage field with an oversized varint fails closed instead of reading 0', async () => {
    // Arrange — field #2 (new input) encoded as a >2^53 varint
    const root = makeTempDir();
    const oversized = [
      ...bytesField(1, [
        ...bytesField(4, [
          ...varintField(1, 10),
          ...field(2, 0), 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f,
          ...varintField(9, 5),
          ...varintField(10, 0),
          ...stringField(11, 'r-big'),
        ]),
        ...bytesField(9, bytesField(4, varintField(1, 1_784_905_354))),
        ...stringField(19, 'gemini-3.6-flash'),
      ]),
    ];
    createConversationDb(root, 'conv1', [new Uint8Array(oversized)]);

    // Act
    const { entries, batches } = await scanAll(root);

    // Assert
    expect(entries).toHaveLength(0);
    expect(batches.flatMap((batch) => batch.warnings.map((warning) => warning.code))).toContain(
      'invalid_record',
    );
  });

  test('attributes every generation of a single-prompt conversation to that prompt', async () => {
    // Arrange
    const root = makeTempDir();
    createConversationDb(
      root,
      'conv1',
      [
        genBlob({ fixedInput: 1, newInput: 5, cacheRead: 0, output: 2, reasoning: 0, responseId: 'r1', steps: [3, 4] }),
        genBlob({ fixedInput: 1, newInput: 6, cacheRead: 0, output: 3, reasoning: 0, responseId: 'r2', steps: [7] }),
      ],
      { steps: [promptStep({ idx: 0, text: '# 작업: 이벤트 17종 전수 분석' })] },
    );

    // Act
    const { entries, batches } = await scanAll(root);

    // Assert
    expect(entries.map((entry) => [entry.promptText, entry.promptKey])).toEqual([
      ['# 작업: 이벤트 17종 전수 분석', 'traj-conv1:step:0'],
      ['# 작업: 이벤트 17종 전수 분석', 'traj-conv1:step:0'],
    ]);
    expect(warningCodes(batches)).not.toContain('prompt_unresolved');
  });

  test('a multi-prompt conversation attributes generations by covered step index', async () => {
    // Arrange — prompts at 0 and 20; generations straddle them
    const root = makeTempDir();
    createConversationDb(
      root,
      'conv1',
      [
        genBlob({ fixedInput: 1, newInput: 5, cacheRead: 0, output: 2, reasoning: 0, responseId: 'r1', steps: [3, 4] }),
        genBlob({ fixedInput: 1, newInput: 6, cacheRead: 0, output: 3, reasoning: 0, responseId: 'r2', steps: [19] }),
        genBlob({ fixedInput: 1, newInput: 7, cacheRead: 0, output: 4, reasoning: 0, responseId: 'r3', steps: [23, 24] }),
      ],
      {
        steps: [
          promptStep({ idx: 0, text: 'first prompt' }),
          { idx: 3, stepType: 8, payload: promptStepBlob({ idx: 3, text: 'tool step', payloadType: 8 }) },
          promptStep({ idx: 20, text: 'second prompt' }),
        ],
      },
    );

    // Act
    const { entries } = await scanAll(root);

    // Assert
    expect(entries.map((entry) => entry.promptText)).toEqual(['first prompt', 'first prompt', 'second prompt']);
    expect(entries.map((entry) => entry.promptKey)).toEqual([
      'traj-conv1:step:0',
      'traj-conv1:step:0',
      'traj-conv1:step:20',
    ]);
  });

  test('generations without step indices fall back to prompt timestamps', async () => {
    // Arrange — no #2 field on the generations, prompts stamped around them
    const root = makeTempDir();
    createConversationDb(
      root,
      'conv1',
      [
        genBlob({ fixedInput: 1, newInput: 5, cacheRead: 0, output: 2, reasoning: 0, responseId: 'r1', tsUtc: 1_784_905_100 }),
        genBlob({ fixedInput: 1, newInput: 6, cacheRead: 0, output: 3, reasoning: 0, responseId: 'r2', tsUtc: 1_784_905_300 }),
      ],
      {
        steps: [
          promptStep({ idx: 0, text: 'early', tsUtc: 1_784_905_000 }),
          promptStep({ idx: 9, text: 'late', tsUtc: 1_784_905_200 }),
        ],
      },
    );

    // Act
    const { entries } = await scanAll(root);

    // Assert
    expect(entries.map((entry) => entry.promptText)).toEqual(['early', 'late']);
  });

  test('unreadable or missing prompt steps leave prompts empty and warn once', async () => {
    // Arrange — one broken user-input step, one generation nobody claims
    const root = makeTempDir();
    createConversationDb(
      root,
      'conv1',
      [
        genBlob({ fixedInput: 1, newInput: 5, cacheRead: 0, output: 2, reasoning: 0, responseId: 'r1', steps: [3] }),
        genBlob({ fixedInput: 1, newInput: 6, cacheRead: 0, output: 3, reasoning: 0, responseId: 'r2', steps: [9] }),
      ],
      {
        steps: [
          { idx: 0, stepType: USER_INPUT_STEP_TYPE, payload: new Uint8Array([0xde, 0xad, 0xbe]) },
          promptStep({ idx: 5, text: 'later prompt' }),
        ],
      },
    );

    // Act
    const { entries, batches } = await scanAll(root);

    // Assert — usage rows survive; the first has no prompt, the second does
    expect(entries.map((entry) => [entry.promptText, entry.promptKey])).toEqual([
      [null, null],
      ['later prompt', 'traj-conv1:step:5'],
    ]);
    const messages = batches.flatMap((batch) => batch.warnings.map((warning) => `${warning.code}: ${warning.message}`));
    expect(messages).toContainEqual(expect.stringMatching(/^invalid_record: 1 user-input steps failed/u));
    expect(messages).toContainEqual(expect.stringMatching(/^prompt_unresolved: 1 generations/u));
  });

  test('a database without a steps table still yields usage rows with empty prompts', async () => {
    // Arrange
    const root = makeTempDir();
    createConversationDb(
      root,
      'conv1',
      [genBlob({ fixedInput: 1, newInput: 5, cacheRead: 0, output: 2, reasoning: 0, responseId: 'r1', steps: [3] })],
      { withoutStepsTable: true },
    );

    // Act
    const { entries, batches } = await scanAll(root);

    // Assert
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ promptText: null, promptKey: null });
    expect(
      batches.flatMap((batch) => batch.warnings.map((warning) => warning.message)),
    ).toContainEqual(expect.stringMatching(/user-input steps unreadable/u));
  });

  test('a missing conversations root is a recoverable discovery warning', async () => {
    // Act
    const adapter = new AntigravityCliAdapter({ rootDirectory: join(makeTempDir(), 'none') });
    const discovery = await adapter.discover({ homeDirectory: '/unused', agentFilter: null });

    // Assert
    expect(discovery.targets).toHaveLength(0);
    expect(discovery.warnings[0]?.code).toBe('source_missing');
  });
});
