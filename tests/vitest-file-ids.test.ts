/**
 * The vitest plugin that decodes the ids Cortico's `file://` imports arrive as. These ids fail in a
 * checkout whose path has a space or a non-ASCII character, so the test makes one in a temporary
 * directory.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { decodedFileIds } from './vitest-file-ids.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function moduleUnderAStrangePath() {
  const root = mkdtempSync(join(tmpdir(), 'vitest-ids-'));
  roots.push(root);
  const dir = join(root, 'a dir 编程');
  mkdirSync(dir);
  const file = join(dir, 'index.ts');
  writeFileSync(file, 'export {};');
  return { file, url: pathToFileURL(file).href, schemeLess: encodeURI(file.replace(/\\/g, '/')) };
}

describe('decoded file ids', () => {
  it('resolves a percent-encoded file URL and the scheme-less id Vite receives', () => {
    const { file, url, schemeLess } = moduleUnderAStrangePath();
    expect(schemeLess).toContain('%20');
    expect(decodedFileIds.resolveId(url)).toBe(file);
    expect(decodedFileIds.resolveId(schemeLess)).toBe(file.replace(/\\/g, '/'));
  });

  it('leaves alone an id that is not an encoded path to an existing file', () => {
    expect(decodedFileIds.resolveId('/tmp/plain.ts')).toBeNull();
    expect(decodedFileIds.resolveId('cortico/core/x.ts')).toBeNull();
    expect(decodedFileIds.resolveId('/no/such%20path/index.ts')).toBeNull();
  });
});
