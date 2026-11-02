/**
 * The picture search: what a hit carries, what the query asks Pixabay for, and how an empty or
 * refusing provider ends. Pixabay is a real local server here.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ImageSearchError, searchImages, type ImageSearchOptions } from '../core/web-fetch/image-search.ts';

const closing: Array<() => void> = [];
afterEach(() => {
  for (const close of closing.splice(0)) close();
});

/** Serves what the handler writes to a GET, recording the paths asked for. */
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

const json = (res: ServerResponse, body: unknown, status = 200): void => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

function options(overrides: Partial<ImageSearchOptions> = {}): ImageSearchOptions {
  return { maxResults: 8, timeoutMs: 5000, pixabayKey: '', ...overrides };
}

const pixabayHit = (url: string, tags = 'corgi puppy') => ({ tags, user: 'Bob', largeImageURL: url });

describe('searchImages', () => {
  it('maps a Pixabay answer to a hit with its credit and provider', async () => {
    const pixabay = await serve((_path, res) => json(res, { hits: [pixabayHit('https://cdn.pixabay.com/a.jpg')] }));
    const hits = await searchImages('corgi', options({ pixabayKey: 'k', pixabayBase: pixabay.origin }));
    expect(hits).toEqual([{ title: 'corgi puppy', url: 'https://cdn.pixabay.com/a.jpg', credit: 'Bob', provider: 'Pixabay' }]);
  });

  it('asks Pixabay for Chinese tags and always for safe results', async () => {
    const pixabay = await serve((_path, res) => json(res, { hits: [pixabayHit('https://cdn.pixabay.com/a.jpg')] }));
    await searchImages('柯基', options({ pixabayKey: 'k', pixabayBase: pixabay.origin }));
    expect(pixabay.hits[0]).toContain('safesearch=true');
    expect(pixabay.hits[0]).toContain('lang=zh');

    await searchImages('corgi', options({ pixabayKey: 'k', pixabayBase: pixabay.origin }));
    expect(pixabay.hits[1]).not.toContain('lang=');
  });

  it('caps the list at the configured count', async () => {
    const pixabay = await serve((_path, res) => json(res, {
      hits: [1, 2, 3, 4].map((n) => pixabayHit(`https://cdn.pixabay.com/${n}.jpg`)),
    }));
    const hits = await searchImages('corgi', options({ pixabayKey: 'k', pixabayBase: pixabay.origin, maxResults: 2 }));
    expect(hits).toHaveLength(2);
  });

  it('skips entries without a direct picture address', async () => {
    const pixabay = await serve((_path, res) => json(res, { hits: [{ tags: 'x', largeImageURL: 'ftp://nope' }, pixabayHit('https://cdn.pixabay.com/a.jpg')] }));
    const hits = await searchImages('corgi', options({ pixabayKey: 'k', pixabayBase: pixabay.origin }));
    expect(hits.map((hit) => hit.url)).toEqual(['https://cdn.pixabay.com/a.jpg']);
  });

  it('says nothing was found when Pixabay answers with nothing', async () => {
    const pixabay = await serve((_path, res) => json(res, { hits: [] }));
    await expect(searchImages('unicorn', options({ pixabayKey: 'k', pixabayBase: pixabay.origin })))
      .rejects.toMatchObject({ kind: 'no-results', message: 'nothing found for "unicorn"' });
  });

  it('reports a refusal as the provider failure it was', async () => {
    const refusing = await serve((_path, res) => json(res, {}, 500));
    const error = await searchImages('corgi', options({ pixabayKey: 'k', pixabayBase: refusing.origin }))
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ImageSearchError);
    expect((error as ImageSearchError).kind).toBe('fetch');
    expect((error as ImageSearchError).message).toBe('HTTP 500');
  });

  it('says which key it needs when none is set', async () => {
    await expect(searchImages('corgi', options())).rejects.toMatchObject({
      kind: 'no-provider',
      message: 'image search needs a Pixabay key',
    });
  });
});
