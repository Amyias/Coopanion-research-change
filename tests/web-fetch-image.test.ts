/**
 * The image reader: which bytes count as which image, how a redirect and a size limit end, and the
 * hosts it refuses before a request. The server is a real local one; the hosts are checked for real.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ImageError, readImage, sniffImage } from '../core/web-fetch/image.ts';

const closing: Array<() => void> = [];
afterEach(() => {
  for (const close of closing.splice(0)) close();
  closing.splice(0);
});

const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0]);
const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const gif = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0]);
const webp = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 8, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);

/** Serves what the handler writes, recording the paths asked for. */
async function serve(handler: (path: string, res: ServerResponse) => void): Promise<{ origin: string; hits: string[] }> {
  const hits: string[] = [];
  const server: Server = createServer((req, res) => {
    hits.push(req.url ?? '');
    handler(req.url ?? '', res);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  closing.push(() => { server.closeAllConnections(); server.close(); });
  const { port } = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${port}`, hits };
}

const local = { timeoutMs: 5000, maxBytes: 1_000_000, allowLocal: true };

describe('sniffImage', () => {
  it('names the type the leading bytes prove', () => {
    expect(sniffImage(png)).toBe('image/png');
    expect(sniffImage(jpeg)).toBe('image/jpeg');
    expect(sniffImage(gif)).toBe('image/gif');
    expect(sniffImage(webp)).toBe('image/webp');
  });

  it('refuses bytes that are not one of those images', () => {
    expect(sniffImage(new TextEncoder().encode('<!doctype html>'))).toBeNull();
    expect(sniffImage(Uint8Array.from([0x89, 0x50]))).toBeNull();
    expect(sniffImage(new Uint8Array(0))).toBeNull();
  });
});

describe('readImage', () => {
  it('returns the bytes and the type the bytes prove', async () => {
    const { origin } = await serve((_path, res) => {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(Buffer.from(png));
    });
    const got = await readImage(`${origin}/a.png`, local);
    expect(got.mime).toBe('image/png');
    expect(got.size).toBe(png.length);
    expect([...got.bytes]).toEqual([...png]);
  });

  it('follows a redirect to the image', async () => {
    const { origin } = await serve((path, res) => {
      if (path === '/a.png') {
        res.writeHead(302, { Location: '/b.png' });
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'image/gif' });
      res.end(Buffer.from(gif));
    });
    const got = await readImage(`${origin}/a.png`, local);
    expect(got.mime).toBe('image/gif');
  });

  it('refuses an answer that is not an image before keeping its body', async () => {
    const { origin } = await serve((_path, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html></html>');
    });
    await expect(readImage(`${origin}/page.html`, local)).rejects.toMatchObject({ kind: 'not-image' });
  });

  it('refuses bytes that only claim to be an image', async () => {
    const { origin } = await serve((_path, res) => {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end('not really an image');
    });
    let error: unknown = null;
    try {
      await readImage(`${origin}/x.bin`, local);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ImageError);
    expect((error as ImageError).kind).toBe('not-image');
  });

  it('stops a declared size over the limit', async () => {
    const { origin } = await serve((_path, res) => {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': String(local.maxBytes + 1) });
      res.flushHeaders();
      res.write(Buffer.from(png));
    });
    await expect(readImage(`${origin}/big.png`, local)).rejects.toMatchObject({ kind: 'too-large' });
  });

  it('stops a body that grows past the limit without a declared size', async () => {
    const { origin } = await serve((_path, res) => {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      const block = Buffer.alloc(64 * 1024, 0x41);
      let sent = 0;
      const pump = () => {
        while (sent <= local.maxBytes + block.length) {
          sent += block.length;
          if (!res.write(block)) { res.once('drain', pump); return; }
        }
        res.end();
      };
      pump();
    });
    await expect(readImage(`${origin}/stream.png`, { ...local, maxBytes: 256 * 1024 })).rejects.toMatchObject({ kind: 'too-large' });
  });

  it('gives up when the answer never comes', async () => {
    const { origin } = await serve(() => { /* never answers */ });
    await expect(readImage(`${origin}/slow.png`, { ...local, timeoutMs: 60 })).rejects.toMatchObject({ kind: 'fetch' });
  });

  it('refuses this machine and the local network before any request', async () => {
    const { origin, hits } = await serve((_path, res) => {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(Buffer.from(png));
    });
    const refused = { ...local, allowLocal: false };
    for (const url of [`${origin}/a.png`, 'http://localhost/a.png', 'http://10.1.2.3/a.png', 'http://192.168.1.2/a.png']) {
      await expect(readImage(url, refused)).rejects.toMatchObject({ kind: 'blocked' });
    }
    expect(hits).toEqual([]);
  });

  it('refuses a URL that is not http or https, or carries credentials', async () => {
    for (const url of ['file:///etc/passwd', 'ftp://example.com/a.png', 'http://user:pass@example.com/a.png']) {
      await expect(readImage(url, local)).rejects.toMatchObject({ kind: 'blocked' });
    }
  });
});
