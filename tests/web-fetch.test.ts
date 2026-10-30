/**
 * The web-fetch World: what its tool sends and returns, how it reports a refusal from the API, and
 * the contract its definition offers. The server is a real local one; only the API's answers are
 * scripted.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WEB_FETCH_DEFAULTS, WEB_FETCH_SECRET } from '../core/web-fetch/config.ts';
import { WEB_FETCH } from '../core/web-fetch/definition.ts';
import { imageFetchTool, webFetchTool } from '../core/web-fetch/tools.ts';

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

function tool(baseUrl: string, overrides: { maxChars?: number; imageMaxBytes?: number; secret?: string } = {}) {
  return webFetchTool({
    baseUrl,
    timeoutMs: 5000,
    maxChars: overrides.maxChars ?? WEB_FETCH_DEFAULTS.maxChars,
    imageMaxBytes: overrides.imageMaxBytes ?? WEB_FETCH_DEFAULTS.imageMaxBytes,
    secret: (name) => (name === WEB_FETCH_SECRET ? (overrides.secret ?? 'test-key') : ''),
  });
}

/** The image tool's options: it reads from the same local server the page tests use. */
function imageTool(overrides: { imageMaxBytes?: number; allowLocal?: boolean } = {}) {
  return imageFetchTool({
    baseUrl: '',
    timeoutMs: 5000,
    maxChars: WEB_FETCH_DEFAULTS.maxChars,
    imageMaxBytes: overrides.imageMaxBytes ?? WEB_FETCH_DEFAULTS.imageMaxBytes,
    secret: () => 'test-key',
    ...(overrides.allowLocal === false ? {} : { allowLocal: true }),
  });
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

describe('the web-fetch World', () => {
  it('mounts both tools and describes them for the WebUI', () => {
    const world = WEB_FETCH.create({ cfg: { ...WEB_FETCH_DEFAULTS }, secret: () => 'test-key' } as unknown as Parameters<typeof WEB_FETCH.create>[0]);
    expect(world.id).toBe(WEB_FETCH.id);
    expect(world.tools().map((tool) => tool.name)).toEqual(['web_fetch', 'web_fetch_image']);
    expect(WEB_FETCH.describe?.tools.map((tool) => tool.name)).toEqual(['web_fetch', 'web_fetch_image']);
    expect(WEB_FETCH.defaults()).toEqual(WEB_FETCH_DEFAULTS);
  });
});
