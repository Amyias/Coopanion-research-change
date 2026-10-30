/** The tools of the `web-fetch` World: `web_fetch` reads one page as Markdown through DeepSeek's Fetch API. */
import type { ToolDef } from 'cortico/core/types.ts';
import { WEB_FETCH_DEFAULTS, WEB_FETCH_SECRET } from './config.ts';

/** The API refuses a longer URL, and one with credentials in it. */
const URL_MAX = 8192;
const RETRY_DELAYS_MS = [1000, 3000];

export interface WebFetchOptions {
  baseUrl: string;
  timeoutMs: number;
  maxChars: number;
  secret(name: string): string;
}

export const WEB_FETCH_TOOL_DECLS: ReadonlyArray<Omit<ToolDef, 'handler'>> = [
  {
    name: 'web_fetch',
    description:
      'Read one web page as Markdown. Use it when the person hands over a link or a search result needs its full text; web_search results usually carry enough summary on their own. One page per call.',
    tags: ['read'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        url: { type: 'string', minLength: 1, maxLength: URL_MAX, description: 'An absolute http or https URL with a host.' },
      },
      required: ['url'],
    },
  },
];

class FetchError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

const retryable = (status: number): boolean => status === 408 || status === 429 || status >= 500;
const statusOf = (body: string): string => {
  try {
    const value = (JSON.parse(body) as { error?: { message?: unknown } }).error?.message;
    return typeof value === 'string' ? value.slice(0, 200) : '';
  } catch {
    return '';
  }
};

/** The URL as the API wants it, or null when it is not an absolute http(s) URL with a host and no credentials. */
function fetchableUrl(raw: string): string | null {
  if (!raw || raw.length > URL_MAX) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!url.host || url.username || url.password) return null;
  return url.href;
}

async function fetchPage(opts: WebFetchOptions, key: string, url: string): Promise<{ title: string; content: string }> {
  let lastError: unknown;
  const base = (opts.baseUrl.trim() || WEB_FETCH_DEFAULTS.baseUrl).replace(/\/+$/, '');
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) await new Promise((done) => setTimeout(done, RETRY_DELAYS_MS[attempt - 1]));
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), opts.timeoutMs);
    try {
      const res = await fetch(`${base}/v1/tools/fetch`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ url }),
        signal: abort.signal,
      });
      const body = await res.text();
      if (!res.ok) {
        const detail = statusOf(body);
        const error = new FetchError(`DeepSeek Fetch API ${res.status}${detail ? `: ${detail}` : ''}`, res.status);
        if (retryable(res.status)) {
          lastError = error;
          continue;
        }
        throw error;
      }
      const page = JSON.parse(body) as { title?: unknown; content?: unknown };
      return {
        title: typeof page.title === 'string' ? page.title : '',
        content: typeof page.content === 'string' ? page.content : '',
      };
    } catch (error) {
      if (error instanceof FetchError && !retryable(error.status)) throw error;
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** The tool, with everything it needs handed in: the tests point it at a local server and a scripted secret. */
export function webFetchTool(opts: WebFetchOptions): ToolDef {
  return {
    ...WEB_FETCH_TOOL_DECLS[0],
    handler: async (args) => {
      const url = fetchableUrl(typeof args.url === 'string' ? args.url.trim() : '');
      if (!url) return '[bad input] url must be an absolute http or https URL with a host and no credentials';
      const key = opts.secret(WEB_FETCH_SECRET).trim();
      if (!key) return `[tool failed] web fetch is not configured (missing ${WEB_FETCH_SECRET})`;
      let page: { title: string; content: string };
      try {
        page = await fetchPage(opts, key, url);
      } catch (error) {
        return `[fetch failed] ${error instanceof Error ? error.message : String(error)}`;
      }
      if (!page.content) return `[fetch failed] no content returned for ${url}`;
      const content = page.content.length > opts.maxChars
        ? `${page.content.slice(0, opts.maxChars)}\n…(truncated: ${page.content.length} characters in all)`
        : page.content;
      return [`web_fetch: ${url}`, page.title || '(untitled)', '', content].join('\n');
    },
  };
}
