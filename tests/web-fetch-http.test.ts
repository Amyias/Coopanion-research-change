/**
 * The shared HTTP read: how many redirects it follows, which answer sizes and types it drops, and
 * when it refuses a host before making the request. The server is a real local one.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { OpenError, openUrl } from '../core/web-fetch/http.ts';

const closing: Array<() => void> = [];
afterEach(() => {
  for (const close of closing.splice(0)) close();
  closing.splice(0);
});

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

const text = (res: ServerResponse, body: string, type = 'text/html; charset=utf-8', status = 200): void => {
  res.writeHead(status, { 'Content-Type': type });
  res.end(body);
};

describe('openUrl', () => {
  it('answers with the bytes, the declared type and the address that answered', async () => {
    const { origin } = await serve((_path, res) => text(res, '<p>hi</p>'));
    const opened = await openUrl(`${origin}/page`, local);
    expect(opened.type).toBe('text/html');
    expect(opened.url).toBe(`${origin}/page`);
    expect(new TextDecoder().decode(opened.bytes)).toBe('<p>hi</p>');
  });

  it('follows a redirect and reports where it landed', async () => {
    const { origin } = await serve((path, res) => {
      if (path === '/old') { res.writeHead(302, { Location: '/new' }); res.end(); return; }
      text(res, 'moved');
    });
    const opened = await openUrl(`${origin}/old`, local);
    expect(opened.url).toBe(`${origin}/new`);
    expect(new TextDecoder().decode(opened.bytes)).toBe('moved');
  });

  it('stops after five redirects', async () => {
    const { origin } = await serve((path, res) => {
      const next = Number(path.slice(1)) + 1;
      res.writeHead(302, { Location: `/${next}` });
      res.end();
    });
    const error = await openUrl(`${origin}/0`, local).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OpenError);
    expect((error as OpenError).kind).toBe('fetch');
    expect((error as OpenError).message).toBe('more than 5 redirects');
  });

  it('refuses a type the caller did not ask for', async () => {
    const { origin } = await serve((_path, res) => text(res, '{}', 'application/json'));
    const error = await openUrl(`${origin}/x`, { ...local, typePrefix: 'text/html' }).catch((caught: unknown) => caught);
    expect((error as OpenError).kind).toBe('type');
    expect((error as OpenError).message).toBe('the answer is application/json');
  });

  it('drops a body whose declared length is over the limit, and one that grows past it', async () => {
    const { origin } = await serve((path, res) => {
      if (path === '/declared') {
        res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Length': '2048' });
        res.end('x'.repeat(2048));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.write('y'.repeat(1024));
      res.end('y'.repeat(1024));
    });
    const declared = await openUrl(`${origin}/declared`, { ...local, maxBytes: 1024 }).catch((caught: unknown) => caught);
    expect((declared as OpenError).kind).toBe('too-large');
    const streamed = await openUrl(`${origin}/streamed`, { ...local, maxBytes: 1024 }).catch((caught: unknown) => caught);
    expect((streamed as OpenError).kind).toBe('too-large');
  });

  it('reports a non-200 answer with its status', async () => {
    const { origin } = await serve((_path, res) => text(res, 'gone', 'text/html', 404));
    const error = await openUrl(`${origin}/gone`, local).catch((caught: unknown) => caught);
    expect((error as OpenError).kind).toBe('fetch');
    expect((error as OpenError).message).toBe('HTTP 404');
  });

  it("won't touch the local network unless a test says so, and then makes no request", async () => {
    const { origin, hits } = await serve((_path, res) => text(res, 'local'));
    const error = await openUrl(`${origin}/x`, { ...local, allowLocal: false }).catch((caught: unknown) => caught);
    expect((error as OpenError).kind).toBe('blocked');
    expect(hits).toEqual([]);
  });

  it('refuses a URL with credentials and a protocol it does not read', async () => {
    const credentials = await openUrl('http://user:pass@example.com/x', local).catch((caught: unknown) => caught);
    expect((credentials as OpenError).kind).toBe('blocked');
    const file = await openUrl('file:///etc/passwd', local).catch((caught: unknown) => caught);
    expect((file as OpenError).kind).toBe('blocked');
  });

  it('gives up at the timeout', async () => {
    const { origin } = await serve((_path) => { /* never answers */ });
    const error = await openUrl(`${origin}/slow`, { ...local, timeoutMs: 150 }).catch((caught: unknown) => caught);
    expect((error as OpenError).kind).toBe('fetch');
    expect((error as OpenError).message).toContain('no answer within 150 ms');
  });
});
