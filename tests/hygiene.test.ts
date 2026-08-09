import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

describe('source tree hygiene (review regression)', () => {
  test('no source file contains stray control bytes', () => {
    // A literal NUL once slipped into accounts/discovery.ts and made
    // git treat the file as binary; only \n and \t are legitimate.
    const roots = [join(import.meta.dir, '..', 'packages')];
    const offenders: string[] = [];
    while (roots.length > 0) {
      const dir = roots.pop()!;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          roots.push(path);
          continue;
        }
        if (!/\.(ts|sql|md|json)$/.test(entry.name)) {
          continue;
        }
        const content = readFileSync(path, 'utf8');
        for (let index = 0; index < content.length; index += 1) {
          const code = content.charCodeAt(index);
          const isControl = (code < 32 && code !== 10 && code !== 9) || code === 127;
          if (isControl) {
            offenders.push(`${path} @${index} (0x${code.toString(16)})`);
            break;
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
