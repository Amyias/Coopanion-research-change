/**
 * The picture addresses a page carries: which tags and attributes they come from, how a relative
 * address resolves, what is skipped, and how web_fetch appends the list to a page receipt. Pages are
 * served by a real local server; the Fetch API's answer is scripted.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WEB_FETCH_DEFAULTS, WEB_FETCH_PIXABAY_SECRET, WEB_FETCH_SECRET } from '../core/web-fetch/config.ts';
import { extractPageImages, readPageImages } from '../core/web-fetch/page-images.ts';
import { webFetchTool } from '../core/web-fetch/tools.ts';

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

const page = (body: string, type = 'text/html; charset=utf-8') => (_path: string, res: ServerResponse): void => {
  res.writeHead(200, { 'Content-Type': type });
  res.end(body);
};

const options = (timeoutMs = 5000, maxImages = 12) => ({ timeoutMs, maxBytes: 1024 * 1024, maxImages, allowLocal: true });

describe('extractPageImages', () => {
  it('takes og:image, twitter:image, img sources and srcset entries, in document order', () => {
    const html = `<html><head>
      <meta property="og:image" content="/og.jpg">
      <meta name="twitter:image" content="https://cdn.example.com/tw.png">
      </head><body>
      <img src="a.jpg" alt="first">
      <img data-src="/lazy.jpg" alt="lazy one">
      <img srcset="small.jpg 1x, big.jpg 2x" alt="scaled">
      <picture><source srcset="source.webp 1x"></picture>
      </body></html>`;
    expect(extractPageImages(html, 'https://example.com/post/1', 12)).toEqual([
      { url: 'https://example.com/og.jpg', alt: '' },
      { url: 'https://cdn.example.com/tw.png', alt: '' },
      { url: 'https://example.com/post/a.jpg', alt: 'first' },
      { url: 'https://example.com/lazy.jpg', alt: 'lazy one' },
      { url: 'https://example.com/post/small.jpg', alt: 'scaled' },
      { url: 'https://example.com/post/source.webp', alt: '' },
    ]);
  });

  it('skips data URIs, svg icons and duplicates, and stops at the cap', () => {
    const html = `<img src="data:image/png;base64,xx">
      <img src="/logo.svg">
      <img src="/a.jpg"><img src="/a.jpg">
      <img src="/b.jpg"><img src="/c.jpg"><img src="/d.jpg">`;
    expect(extractPageImages(html, 'https://example.com/', 2)).toEqual([
      { url: 'https://example.com/a.jpg', alt: '' },
      { url: 'https://example.com/b.jpg', alt: '' },
    ]);
    expect(extractPageImages(html, 'https://example.com/', 10)).toHaveLength(4);
  });

  it('decodes entities in addresses and alt text', () => {
    const html = '<img src="/a.jpg?w=1&amp;h=2" alt="corgi &amp; friend">';
    expect(extractPageImages(html, 'https://example.com/', 5)).toEqual([
      { url: 'https://example.com/a.jpg?w=1&h=2', alt: 'corgi & friend' },
    ]);
  });
});

describe('readPageImages', () => {
  it('reads a page served by a real server', async () => {
    const { origin } = await serve(page('<img src="/x.png" alt="x">'));
    const images = await readPageImages(`${origin}/post`, options());
    expect(images).toEqual([{ url: `${origin}/x.png`, alt: 'x' }]);
  });

  it('answers with none for a page that is not HTML and for a page it cannot reach', async () => {
    const broken = await serve(page('{}', 'application/json'));
    expect(await readPageImages(`${broken.origin}/data`, options())).toEqual([]);
    expect(await readPageImages('http://127.0.0.1:1/nothing', options(300))).toEqual([]);
  });

  it('reads a page whose charset it does not know as utf-8', async () => {
    const { origin } = await serve(page('<img src="/a.jpg" alt="柯基">', 'text/html; charset=not-a-charset'));
    expect(await readPageImages(`${origin}/`, options())).toEqual([{ url: `${origin}/a.jpg`, alt: '柯基' }]);
  });
});

describe('web_fetch with pictures', () => {
  async function fetchTool(pageOrigin: string, overrides: { maxImageLinks?: number } = {}) {
    const api = await serve((path, res) => {
      if (path !== '/v1/tools/fetch') { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ title: 'A post', content: 'body text' }));
    });
    const tool = webFetchTool({
      cfg: {
        ...WEB_FETCH_DEFAULTS,
        baseUrl: api.origin,
        timeoutMs: 5000,
        ...(overrides.maxImageLinks !== undefined ? { maxImageLinks: overrides.maxImageLinks } : {}),
      },
      secret: (name: string) => (name === WEB_FETCH_SECRET ? 'k' : name === WEB_FETCH_PIXABAY_SECRET ? '' : ''),
      storeSecret: () => {},
      allowLocal: true,
    });
    return tool;
  }

  it('appends the picture addresses a page carries', async () => {
    const { origin } = await serve(page('<img src="/one.jpg" alt="one"><img src="/two.jpg" alt="two">'));
    const out = await (await fetchTool(origin)).handler({ url: `${origin}/post` }, {} as never) as string;
    expect(out).toBe([
      `web_fetch: ${origin}/post`,
      'A post',
      '',
      'body text',
      '',
      'Pictures on this page (2):',
      `1. one — ${origin}/one.jpg`,
      `2. two — ${origin}/two.jpg`,
    ].join('\n'));
  });

  it('leaves the receipt as it was when the page carries none', async () => {
    const { origin } = await serve(page('<p>no pictures</p>'));
    const out = await (await fetchTool(origin)).handler({ url: `${origin}/post` }, {} as never) as string;
    expect(out).toBe(`web_fetch: ${origin}/post\nA post\n\nbody text`);
  });

  it('lists no more addresses than the configured count', async () => {
    const { origin } = await serve(page('<img src="/1.jpg"><img src="/2.jpg"><img src="/3.jpg">'));
    const out = await (await fetchTool(origin, { maxImageLinks: 2 })).handler({ url: `${origin}/post` }, {} as never) as string;
    expect(out).toContain('Pictures on this page (2):');
    expect(out).not.toContain('/3.jpg');
  });
});
