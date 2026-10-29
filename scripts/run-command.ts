/**
 * Runs one command with its arguments in a directory, inheriting stdio, and returns the exit status.
 *
 * Windows needs a shell for `npm.cmd` and `electron-builder.cmd`, and the shell splits every token at
 * a space: a checkout under a path with one would otherwise fail at "D:\... is not recognized".
 */
import { spawnSync } from 'node:child_process';

/** The status `spawnSync` reports, or 1 when the command could not be started at all. */
export function runCommand(cmd: string, args: string[], cwd: string): number {
  const windows = process.platform === 'win32';
  const quoted = (token: string) => (windows && /\s/.test(token) ? `"${token}"` : token);
  const result = spawnSync(quoted(cmd), args.map(quoted), { cwd, stdio: 'inherit', shell: windows });
  return result.status ?? 1;
}
