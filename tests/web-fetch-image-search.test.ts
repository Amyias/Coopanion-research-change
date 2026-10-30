/**
 * The search itself: which provider answers for a query, what a hit carries, and how a provider that is
 * empty, slow or refusing hands over to the next one. Both providers are real local servers here.
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
  return { maxResults: 8, timeoutMs: 5000, pexelsKey: '', pixabayKey: '', ...overrides };
}

const pexelsPhoto = (url: string, alt = 'a corgi') => ({ alt, photographer: 'Ann', src: { large: url } });
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

  it('asks Pexels first when both keys are set', async () => {
    const pexels = await serve((_path, res) => json(res, { photos: [pexelsPhoto('https://images.pexels.com/a.jpg')] }));
    const pixabay = await serve((_path, res) => json(res, { hits: [pixabayHit('https://cdn.pixabay.com/a.jpg')] }));
    const hits = await searchImages('corgi', options({ pexelsKey: 'p', pixabayKey: 'q', pexelsBase: pexels.origin, pixabayBase: pixabay.origin }));
    expect(hits[0].provider).toBe('Pexels');
    expect(pixabay.hits).toEqual([]);
  });

  it('falls back to Pixabay when Pexels refuses the key', async () => {
    const pexels = await serve((_path, res) => json(res, { status: 401 }, 401));
    const pixabay = await serve((_path, res) => json(res, { hits: [pixabayHit('https://cdn.pixabay.com/a.jpg')] }));
    const hits = await searchImages('corgi', options({ pexelsKey: 'bad', pixabayKey: 'q', pexelsBase: pexels.origin, pixabayBase: pixabay.origin }));
    expect(hits).toHaveLength(1);
    expect(hits[0].provider).toBe('Pixabay');
  });

  it('falls back to Pixabay when Pexels finds nothing', async () => {
    const pexels = await serve((_path, res) => json(res, { photos: [] }));
    const pixabay = await serve((_path, res) => json(res, { hits: [pixabayHit('https://cdn.pixabay.com/a.jpg')] }));
    const hits = await searchImages('corgi', options({ pexelsKey: 'p', pixabayKey: 'q', pexelsBase: pexels.origin, pixabayBase: pixabay.origin }));
    expect(hits[0].provider).toBe('Pixabay');
  });

  it('caps the list at the configured count', async () => {
    const pixabay = await serve((_path, res) => json(res, {
      hits: [1, 2, 3, 4].map((n) => pixabayHit(`https://cdn.pixabay.com/${n}.jpg`)),
    }));
    const hits = await searchImages('corgi', options({ pixabayKey: 'k', pixabayBase: pixabay.origin, maxResults: 2 }));
    expect(hits).toHaveLength(2);
  });

  it('says nothing was found when the providers answer with nothing', async () => {
    const pixabay = await serve((_path, res) => json(res, { hits: [] }));
    await expect(searchImages('unicorn', options({ pixabayKey: 'k', pixabayBase: pixabay.origin })))
      .rejects.toMatchObject({ kind: 'no-results', message: 'nothing found for "unicorn"' });
  });

  it('reports the last provider failure when every provider fails', async () => {
    const viaServe = await serve((_path, res) => json(res, {}, 500));
    const error = await searchImages('corgi', options({ pexelsKey: 'p', pixabayKey: 'q', pexelsBase: viaServe.origin, pixabayBase: viaServe.origin }))
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ImageSearchError);
    expect((error as ImageSearchError).kind).toBe('fetch');
    expect((error as ImageSearchError).message).toBe('HTTP 500');
  });

  it('says which keys it needs when none is set', async () => {
    await expect(searchImages('corgi', options())).rejects.toMatchObject({
      kind: 'no-provider',
      message: 'image search needs a Pexels or Pixabay key',
    });
  });
});
