import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand } from '../scripts/run-command.ts';

/** A directory whose name carries a space, as a checkout path may. */
function dirWithSpace(): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'run-command-')), 'a dir');
  mkdirSync(dir);
  return dir;
}

describe('a command under a path with a space', () => {
  // a .cmd needs the shell on Windows, the one case the shell splits at the space
  it.skipIf(process.platform !== 'win32')('runs a .cmd whose own path has one', () => {
    const dir = dirWithSpace();
    try {
      writeFileSync(join(dir, 'write.cmd'), '@echo off\r\necho ran > "%~dp0out.txt"\r\n');
      expect(runCommand(join(dir, 'write.cmd'), [], tmpdir())).toBe(0);
      expect(readFileSync(join(dir, 'out.txt'), 'utf8').trim()).toBe('ran');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runs with a working directory that has one', () => {
    const dir = dirWithSpace();
    try {
      expect(runCommand(process.execPath, ['-e', "require('node:fs').writeFileSync('out.txt', process.cwd())"], dir)).toBe(0);
      expect(readFileSync(join(dir, 'out.txt'), 'utf8')).toBe(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports the exit status of a command that fails', () => {
    expect(runCommand(process.execPath, ['-e', 'process.exit(3)'], tmpdir())).toBe(3);
  });
});
