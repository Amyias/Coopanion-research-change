/**
 * The web-fetch World's one tool: what it sends, what it returns, and how it reports a refusal from
 * the API. The server is a real local one; only the API's answers are scripted.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { WEB_FETCH_DEFAULTS, webFetchTool } from '../core/web-fetch.ts';

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

function tool(baseUrl: string, overrides: { maxChars?: number; secret?: string } = {}) {
  return webFetchTool({
    baseUrl,
    timeoutMs: 5000,
    maxChars: overrides.maxChars ?? WEB_FETCH_DEFAULTS.maxChars,
    secret: (name) => (name === 'DEEPSEEK_SEARCH_API_KEY' ? (overrides.secret ?? 'test-key') : ''),
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
