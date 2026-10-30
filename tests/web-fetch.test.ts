/**
 * The web-fetch World: what its tool sends and returns, how it reports a refusal from the API, and
 * the contract its definition offers. The server is a real local one; only the API's answers are
 * scripted.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  WEB_FETCH_DEFAULTS,
  WEB_FETCH_PEXELS_SECRET,
  WEB_FETCH_PIXABAY_SECRET,
  WEB_FETCH_SECRET,
} from '../core/web-fetch/config.ts';
import { WEB_FETCH } from '../core/web-fetch/definition.ts';
import { imageFetchTool, searchImagesTool, webFetchTool } from '../core/web-fetch/tools.ts';

const closing: Array<() => void> = [];
afterEach(() => { for (const close of closing.splice(0)) close(); });

/** Serves one `POST /v1/tools/fetch`, recording the URLs asked for. */
async function api(handler: (url: string) => { status?: number; body: unknown }): Promise<{ baseUrl: string; calls: string[] }> {
  const calls: string[] = [];
  const server: Server = createServer((req, res) => {
    let text = '';
    req.on('data', (chunk) => { text += chunk; });
    req.on('end', () => {
      const url = (JSON.parse(text) as { url?: string }).url ?? '';
      calls.push(url);
      const { status = 200, body } = handler(url);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  closing.push(() => server.close());
  return { baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, calls };
}

/** Serves what the handler writes to a GET, recording the paths asked for. */
async function serveGet(handler: (path: string, res: ServerResponse) => void): Promise<{ origin: string; hits: string[] }> {
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

const options = (overrides: {
  baseUrl?: string;
  maxChars?: number;
  imageMaxBytes?: number;
  maxImageResults?: number;
  secret?: string;
  allowLocal?: boolean;
  pexelsKey?: string;
  pixabayKey?: string;
  pexelsBase?: string;
  pixabayBase?: string;
} = {}) => ({
  cfg: {
    ...WEB_FETCH_DEFAULTS,
    baseUrl: overrides.baseUrl ?? '',
    timeoutMs: 5000,
    ...(overrides.maxChars !== undefined ? { maxChars: overrides.maxChars } : {}),
    ...(overrides.imageMaxBytes !== undefined ? { imageMaxBytes: overrides.imageMaxBytes } : {}),
    ...(overrides.maxImageResults !== undefined ? { maxImageResults: overrides.maxImageResults } : {}),
  },
  secret: (name: string) => {
    if (name === WEB_FETCH_SECRET) return overrides.secret ?? 'test-key';
    if (name === WEB_FETCH_PEXELS_SECRET) return overrides.pexelsKey ?? '';
    if (name === WEB_FETCH_PIXABAY_SECRET) return overrides.pixabayKey ?? '';
    return '';
  },
  storeSecret: () => {},
  allowLocal: overrides.allowLocal !== false,
  ...(overrides.pexelsBase ? { pexelsBase: overrides.pexelsBase } : {}),
  ...(overrides.pixabayBase ? { pixabayBase: overrides.pixabayBase } : {}),
});

function tool(baseUrl: string, overrides: { maxChars?: number; secret?: string } = {}) {
  return webFetchTool(options({ ...overrides, baseUrl }));
}

/** The image tools' options: they read from the same local server the page tests use. */
function imageTool(overrides: { imageMaxBytes?: number; allowLocal?: boolean } = {}) {
  return imageFetchTool(options(overrides));
}

/** The search tool's options: a provider base points at a local server, the keys are scripted. */
function searchTool(overrides: {
  pexelsKey?: string;
  pixabayKey?: string;
  pexelsBase?: string;
  pixabayBase?: string;
  maxImageResults?: number;
} = {}) {
  return searchImagesTool(options(overrides));
}

describe('web_fetch', () => {
  it('sends the URL and returns the page title with its Markdown body', async () => {
    const { baseUrl, calls } = await api(() => ({ body: { title: '示例页', content: '# 标题\n\n正文' } }));
    const out = await tool(baseUrl).handler({ url: 'https://example.com/a?b=1' }, {} as never);
    expect(calls).toEqual(['https://example.com/a?b=1']);
    expect(out).toBe('web_fetch: https://example.com/a?b=1\n示例页\n\n# 标题\n\n正文');
  });

  it('cuts a long page and says how much was left out', async () => {
    const { baseUrl } = await api(() => ({ body: { title: 't', content: 'x'.repeat(50) } }));
    const out = await tool(baseUrl, { maxChars: 10 }).handler({ url: 'https://example.com/' }, {} as never);
    expect(out).toBe('web_fetch: https://example.com/\nt\n\nxxxxxxxxxx\n…(truncated: 50 characters in all)');
  });

  it("reports the API's own reason when the page cannot be read", async () => {
    const { baseUrl } = await api(() => ({ status: 404, body: { error: { message: 'no usable content' } } }));
    expect(await tool(baseUrl).handler({ url: 'https://example.com/gone' }, {} as never))
      .toBe('[fetch failed] DeepSeek Fetch API 404: no usable content');
  });

  it('retries a 5xx and succeeds on the next try', async () => {
    let hits = 0;
    const { baseUrl } = await api(() => (++hits === 1 ? { status: 500, body: { error: { message: 'boom' } } } : { body: { title: 't', content: 'ok' } }));
    const out = await tool(baseUrl).handler({ url: 'https://example.com/' }, {} as never);
    expect(hits).toBe(2);
    expect(out).toContain('ok');
  });

  it('says it is not configured rather than calling without a key', async () => {
    const { baseUrl, calls } = await api(() => ({ body: { title: 't', content: 'c' } }));
    const out = await tool(baseUrl, { secret: '' }).handler({ url: 'https://example.com/' }, {} as never);
    expect(out).toContain('missing DEEPSEEK_SEARCH_API_KEY');
    expect(calls).toEqual([]);
  });

  it('refuses a URL it must not fetch', async () => {
    const { baseUrl, calls } = await api(() => ({ body: {} }));
    for (const url of ['ftp://example.com/x', 'file:///etc/passwd', 'https://user:pass@example.com/', 'example.com', '']) {
      expect(await tool(baseUrl).handler({ url }, {} as never)).toBe('[bad input] url must be an absolute http or https URL with a host and no credentials');
    }
    expect(calls).toEqual([]);
  });
});

const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0]);

describe('web_fetch_image', () => {
  it('returns the image as an attachment the bot can show', async () => {
    const { origin } = await serveGet((_path, res) => {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(Buffer.from(png));
    });
    const out = await imageTool().handler({ url: `${origin}/cat.png` }, {} as never);
    expect(typeof out).toBe('object');
    const outcome = out as { text: string; blobs?: Array<{ bytes: Uint8Array; mime: string; name?: string; fallbackText: string }> };
    expect(outcome.text).toBe(`web image: ${origin}/cat.png · image/png · ${png.length} B`);
    expect(outcome.blobs).toHaveLength(1);
    expect(outcome.blobs?.[0]).toMatchObject({ mime: 'image/png', name: 'cat.png' });
    expect([...(outcome.blobs?.[0]?.bytes ?? [])]).toEqual([...png]);
    expect(outcome.blobs?.[0]?.fallbackText).toBe(`an image from 127.0.0.1:${new URL(origin).port}`);
  });

  it('refuses an answer that is not an image', async () => {
    const { origin } = await serveGet((_path, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html></html>');
    });
    expect(await imageTool().handler({ url: `${origin}/x.html` }, {} as never)).toBe('[not an image] the answer is text/html');
  });

  it('refuses an image over the size limit', async () => {
    const { origin } = await serveGet((_path, res) => {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': '2048' });
      res.flushHeaders();
      res.write(Buffer.from(png));
    });
    expect(await imageTool({ imageMaxBytes: 1024 }).handler({ url: `${origin}/big.png` }, {} as never)).toMatch(/^\[too large\]/);
  });

  it('will not read the local network unless a test says so', async () => {
    const { origin, hits } = await serveGet((_path, res) => {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(Buffer.from(png));
    });
    expect(await imageTool({ allowLocal: false }).handler({ url: `${origin}/cat.png` }, {} as never)).toMatch(/^\[not allowed\]/);
    expect(hits).toEqual([]);
  });

  it('refuses a URL it must not fetch', async () => {
    for (const url of ['ftp://example.com/cat.png', 'https://user:pass@example.com/cat.png', 'example.com']) {
      expect(await imageTool().handler({ url }, {} as never)).toBe('[bad input] url must be an absolute http or https URL with a host and no credentials');
    }
  });
});

describe('web_search_images', () => {
  it('returns picture addresses and their credits from Pexels', async () => {
    const { origin, hits } = await serveGet((_path, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        photos: [
          { alt: 'a corgi on grass', photographer: 'Ann', src: { large: 'https://images.example.com/corgi.jpg' } },
          { alt: '', photographer: '', src: { large: 'https://images.example.com/two.jpg' } },
        ],
      }));
    });
    const out = await searchTool({ pexelsKey: 'k', pexelsBase: origin }).handler({ query: 'corgi' }, {} as never);
    expect(out).toBe([
      'web images: corgi',
      '1. a corgi on grass — https://images.example.com/corgi.jpg (by Ann · Pexels)',
      '2. a picture — https://images.example.com/two.jpg (Pexels)',
    ].join('\n'));
    expect(hits[0]).toContain('query=corgi');
  });

  it('falls back to Pixabay when only its key is set', async () => {
    const { origin, hits } = await serveGet((_path, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ hits: [{ tags: 'corgi puppy', user: 'Bob', largeImageURL: 'https://cdn.example.com/x.jpg' }] }));
    });
    const out = await searchTool({ pixabayKey: 'k', pixabayBase: origin }).handler({ query: 'corgi' }, {} as never);
    expect(out).toBe('web images: corgi\n1. corgi puppy — https://cdn.example.com/x.jpg (by Bob · Pixabay)');
    expect(hits[0]).toContain('key=k');
  });

  it('prefers Pexels when both keys are set', async () => {
    let pixabayAsked = false;
    const pexels = await serveGet((_path, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ photos: [{ alt: 'a corgi', photographer: 'Ann', src: { large: 'https://images.example.com/a.jpg' } }] }));
    });
    const pixabay = await serveGet((_path, res) => {
      pixabayAsked = true;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ hits: [] }));
    });
    await searchTool({ pexelsKey: 'p', pixabayKey: 'q', pexelsBase: pexels.origin, pixabayBase: pixabay.origin })
      .handler({ query: 'corgi' }, {} as never);
    expect(pixabayAsked).toBe(false);
  });

  it('says which keys it needs when neither is set', async () => {
    expect(await searchTool().handler({ query: 'corgi' }, {} as never))
      .toBe('[tool failed] image search needs PEXELS_API_KEY or PIXABAY_API_KEY');
  });

  it('reports an empty answer as nothing found', async () => {
    const { origin } = await serveGet((_path, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ photos: [] }));
    });
    expect(await searchTool({ pexelsKey: 'k', pexelsBase: origin }).handler({ query: 'nonexistent' }, {} as never))
      .toBe('[no results] nothing found for "nonexistent"');
  });

  it('names the provider status when it refuses the key', async () => {
    const { origin } = await serveGet((_path, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 401 }));
    });
    expect(await searchTool({ pexelsKey: 'bad', pexelsBase: origin }).handler({ query: 'corgi' }, {} as never))
      .toBe('[fetch failed] HTTP 401');
  });

  it('refuses an empty query', async () => {
    for (const query of ['', 'x'.repeat(201)]) {
      expect(await searchTool().handler({ query }, {} as never)).toBe('[bad input] query must be 1 to 200 characters');
    }
  });
});

/** A World whose secrets can change, as the settings page's setKey does. */
function settingsWorld(keys: Record<string, string> = {}) {
  const secrets: Record<string, string> = { ...keys };
  const stored: Array<[string, string]> = [];
  const world = WEB_FETCH.create({
    cfg: { ...WEB_FETCH_DEFAULTS },
    secret: (name: string) => secrets[name] ?? '',
    storeSecret: (name: string, value: string) => { secrets[name] = value; stored.push([name, value]); },
  } as unknown as Parameters<typeof WEB_FETCH.create>[0]);
  return { world, secrets, stored };
}

describe('the settings page', () => {
  it('shows a lamp per capability and a badge per key', () => {
    const { world } = settingsWorld({ [WEB_FETCH_PIXABAY_SECRET]: 'abcdefghijklmnop' });
    const ui = world.webUi!('en');
    expect(ui.label).toBe('WebFetch');
    expect(ui.lamps?.map((lamp) => [lamp.label, lamp.state])).toEqual([['Pages', 'offline'], ['Pictures', 'online']]);
    expect(ui.badges?.map((badge) => [badge.label, badge.value])).toEqual([
      ['Page key', 'none'],
      ['Pixabay key', 'Set'],
      ['Pexels key', 'none'],
    ]);
  });

  it('never returns a whole key, only its masked form', async () => {
    const { world } = settingsWorld({ [WEB_FETCH_PIXABAY_SECRET]: 'abcdefghijklmnop' });
    const state = await world.webUi!().invoke!('setup', 'state', []) as Record<string, string | null>;
    expect(state).toEqual({ fetch: null, pixabay: 'abcdef…mnop', pexels: null });
  });

  it('saves and clears a key through the World, so the next search reads it', async () => {
    const { world, secrets, stored } = settingsWorld();
    const ui = world.webUi!('en');
    await ui.invoke!('setup', 'setKey', ['pixabay', '  fresh-key-123456  ']);
    expect(stored).toEqual([[WEB_FETCH_PIXABAY_SECRET, 'fresh-key-123456']]);
    expect(secrets[WEB_FETCH_PIXABAY_SECRET]).toBe('fresh-key-123456');
    expect(await ui.invoke!('setup', 'state', [])).toMatchObject({ pixabay: 'fresh-…3456' });
    await ui.invoke!('setup', 'clearKey', ['pixabay']);
    expect(secrets[WEB_FETCH_PIXABAY_SECRET]).toBe('');
    expect(await ui.invoke!('setup', 'state', [])).toMatchObject({ pixabay: null });
  });

  it('refuses an empty key, an unknown key name, panel or method', async () => {
    const { world } = settingsWorld();
    const ui = world.webUi!('en');
    await expect(ui.invoke!('setup', 'setKey', ['pixabay', '   '])).rejects.toThrow('Paste a key first');
    await expect(ui.invoke!('setup', 'setKey', ['nope', 'abc'])).rejects.toThrow('Unknown key: nope');
    await expect(ui.invoke!('other', 'state', [])).rejects.toThrow('Unknown panel: other');
    await expect(ui.invoke!('setup', 'delete', [])).rejects.toThrow('Unknown method: delete');
  });

  it('offers the state method by GET and says what a test needs', async () => {
    const { world } = settingsWorld();
    const ui = world.webUi!('en');
    expect(ui.panels?.[0]).toMatchObject({ id: 'setup', getMethods: ['state'] });
    await expect(ui.invoke!('setup', 'test', [])).rejects.toThrow('Set a Pixabay or Pexels key before testing');
  });

  it('renders its own settings group', () => {
    const { world } = settingsWorld();
    const group = world.webUi!('en').config?.[0];
    expect(group?.id).toBe('world:web-fetch');
    expect(Object.keys(group?.schema.properties ?? {})).toEqual([
      'worlds.web-fetch.baseUrl',
      'worlds.web-fetch.maxChars',
      'worlds.web-fetch.imageMaxBytes',
      'worlds.web-fetch.maxImageResults',
      'worlds.web-fetch.timeoutMs',
    ]);
    expect(group?.schema.properties['worlds.web-fetch.maxChars']).toMatchObject({ type: 'integer', 'x-hot': true });
  });
});

describe('the web-fetch World', () => {
  it('mounts both tools and describes them for the WebUI', () => {
    const world = WEB_FETCH.create({ cfg: { ...WEB_FETCH_DEFAULTS }, secret: () => 'test-key', storeSecret: () => {} } as unknown as Parameters<typeof WEB_FETCH.create>[0]);
    expect(world.id).toBe(WEB_FETCH.id);
    expect(world.tools().map((tool) => tool.name)).toEqual(['web_fetch', 'web_fetch_image', 'web_search_images']);
    expect(WEB_FETCH.describe?.tools.map((tool) => tool.name)).toEqual(['web_fetch', 'web_fetch_image', 'web_search_images']);
    expect(WEB_FETCH.defaults()).toEqual(WEB_FETCH_DEFAULTS);
  });
});
