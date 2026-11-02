/**
 * The keyless fallback: the media addresses in one Bing image-search answer, how the picture search
 * hands over to it when Pixabay has no key or finds nothing, and the tool's receipt for a Bing hit.
 * Bing's page is served by a real local server.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extractBingImages } from '../core/web-fetch/bing-images.ts';
import { WEB_FETCH_DEFAULTS } from '../core/web-fetch/config.ts';
import { searchImages, type ImageSearchOptions } from '../core/web-fetch/image-search.ts';
import { searchImagesTool } from '../core/web-fetch/tools.ts';

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

/** A Bing answer as the page serializes it: the media address inside an escaped murl attribute. */
const bingPage = (urls: string[]): string => urls
  .map((url) => `<div data-svitminfp="{&quot;murl&quot;:&quot;${url}&quot;}"></div>`)
  .join('');

const options = (overrides: Partial<ImageSearchOptions> = {}): ImageSearchOptions => ({
  maxResults: 8,
  timeoutMs: 5000,
  pixabayKey: '',
  bingFallback: true,
  allowLocal: true,
  ...overrides,
});

const pixabay = (body: unknown, status = 200) => (_path: string, res: ServerResponse): void => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

const html = (body: string) => (_path: string, res: ServerResponse): void => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(body);
};

describe('extractBingImages', () => {
  it('reads the way murl is escaped and stops at the cap', () => {
    const page = [
      '<div data-svitminfp="{&quot;murl&quot;:&quot;https://a.example.com/1.jpg&quot;}"></div>',
      '<script>{"murl":"https://a.example.com/2.jpg"}</script>',
      '<script>{"murl":"https:\\/\\/a.example.com\\/3.jpg"}</script>',
    ].join('\n');
    expect(extractBingImages(page, 10).map((hit) => hit.url)).toEqual([
      'https://a.example.com/1.jpg',
      'https://a.example.com/2.jpg',
      'https://a.example.com/3.jpg',
    ]);
    expect(extractBingImages(page, 2).map((hit) => hit.url)).toEqual([
      'https://a.example.com/1.jpg',
      'https://a.example.com/2.jpg',
    ]);
  });

  it('skips duplicates and anything that is not a picture address', () => {
    const page = [
      '<div data-svitminfp="{&quot;murl&quot;:&quot;https://a.example.com/1.jpg&quot;}"></div>',
      '<div data-svitminfp="{&quot;murl&quot;:&quot;https://a.example.com/1.jpg&quot;}"></div>',
      '<div data-svitminfp="{&quot;murl&quot;:&quot;/relative.jpg&quot;}"></div>',
      '<p>{"murl":"javascript:void(0)"}</p>',
    ].join('\n');
    expect(extractBingImages(page, 10)).toEqual([
      { title: 'a picture', url: 'https://a.example.com/1.jpg', credit: '', provider: 'Bing' },
    ]);
  });
});

describe('the picture search falls back to Bing', () => {
  it('asks Bing when Pixabay has no key', async () => {
    const bing = await serve(html(bingPage(['https://cdn.example.com/a.jpg'])));
    const hits = await searchImages('corgi', options({ bingBase: bing.origin }));
    expect(hits).toEqual([{ title: 'a picture', url: 'https://cdn.example.com/a.jpg', credit: '', provider: 'Bing' }]);
    expect(bing.hits[0]).toContain('images/search?q=corgi');
  });

  it('asks Bing when Pixabay finds nothing, and keeps the cap', async () => {
    const pixabayServer = await serve(pixabay({ hits: [] }));
    const bing = await serve(html(bingPage(['https://cdn.example.com/a.jpg', 'https://cdn.example.com/b.jpg'])));
    const hits = await searchImages('corgi', options({ pixabayKey: 'k', pixabayBase: pixabayServer.origin, bingBase: bing.origin, maxResults: 1 }));
    expect(hits).toHaveLength(1);
    expect(hits[0].provider).toBe('Bing');
  });

  it('asks Bing when Pixabay refuses the key', async () => {
    const pixabayServer = await serve(pixabay({ status: 401 }, 401));
    const bing = await serve(html(bingPage(['https://cdn.example.com/a.jpg'])));
    const hits = await searchImages('corgi', options({ pixabayKey: 'bad', pixabayBase: pixabayServer.origin, bingBase: bing.origin }));
    expect(hits[0].provider).toBe('Bing');
  });

  it('says nothing was found when Bing has nothing either', async () => {
    const bing = await serve(html('<html>no results</html>'));
    await expect(searchImages('unicorn', options({ bingBase: bing.origin }))).rejects.toMatchObject({ kind: 'no-results' });
  });

  it('asks nothing when the fallback is off and there is no key', async () => {
    await expect(searchImages('corgi', options({ bingFallback: false }))).rejects.toMatchObject({
      kind: 'no-provider',
      message: 'image search needs a Pixabay key',
    });
  });

  it('reports a Bing hit in the tool receipt with the provider it came from', async () => {
    const bing = await serve(html(bingPage(['https://cdn.example.com/a.jpg'])));
    const tool = searchImagesTool({
      cfg: { ...WEB_FETCH_DEFAULTS, baseUrl: '', timeoutMs: 5000, bingFallback: true },
      secret: () => '',
      storeSecret: () => {},
      allowLocal: true,
      bingBase: bing.origin,
    });
    expect(await tool.handler({ query: 'corgi' }, {} as never))
      .toBe('web images: corgi\n1. a picture — https://cdn.example.com/a.jpg (Bing)');
  });
});
