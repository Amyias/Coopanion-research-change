/**
 * The ids Vitest hands Vite for Cortico's `file://` imports. The provider registry discovers its
 * modules with `import(pathToFileURL(entry).href)`; the scheme is gone by the time Vite resolves the
 * id and the path is still percent-encoded, so a checkout under a path with a space or a non-ASCII
 * character cannot load it. The decoded path is returned only when it exists.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const decodedFileIds = {
  name: 'decoded-file-ids',
  enforce: 'pre' as const,
  resolveId(id: string) {
    if (!id.startsWith('file:') && !/%[0-9A-Fa-f]{2}/.test(id)) return null;
    let path: string;
    try {
      path = id.startsWith('file:') ? fileURLToPath(id) : decodeURIComponent(id);
    } catch {
      return null;
    }
    return existsSync(path) ? path : null;
  },
};
