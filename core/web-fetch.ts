/**
 * The `web-fetch` World: one tool, `web_fetch`, which reads a single page as Markdown through
 * DeepSeek's Fetch API (`POST <base>/v1/tools/fetch`). Cortico's `websearch` World covers search only;
 * this World closes that gap without touching the vendored copy.
 *
 * The key is the one the `websearch` World's DeepSeek provider uses (`DEEPSEEK_SEARCH_API_KEY` in the
 * deployment `.env`), so a deployment that configured search needs nothing else. A page the API cannot
 * read comes back as the API's own reason (403 refused by its policy, 404 no usable content, 402 the
 * account is out of credit), never as a guess.
 */
import type { ToolDef, World, WorldHost } from 'cortico/core/types.ts';
import { describeTools, type WorldDefinition, type WorldDescribe, type WorldSection } from 'cortico/world.ts';

export const WEB_FETCH_ID = 'web-fetch';
/** The secret the websearch World's DeepSeek provider stores; the Fetch API takes the same key. */
const SECRET = 'DEEPSEEK_SEARCH_API_KEY';
/** The API refuses a longer URL, and one with credentials in it. */
const URL_MAX = 8192;
const RETRY_DELAYS_MS = [1000, 3000];

export interface WebFetchConfigSection extends WorldSection {
  /** `<baseUrl>/v1/tools/fetch`; empty means the public API. */
  baseUrl: string;
  timeoutMs: number;
  /** A page longer than this is cut, and the receipt says how much was left out. */
  maxChars: number;
}

export const WEB_FETCH_DEFAULTS = {
  enabled: false,
  baseUrl: 'https://api.deepseek.com',
  timeoutMs: 20_000,
  maxChars: 12_000,
} as const satisfies WebFetchConfigSection;

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
      const key = opts.secret(SECRET).trim();
      if (!key) return `[tool failed] web fetch is not configured (missing ${SECRET})`;
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

class WebFetchWorld implements World {
  readonly id = WEB_FETCH_ID;
  private readonly opts: WebFetchOptions;

  constructor(opts: WebFetchOptions) {
    this.opts = opts;
  }

  /** No environment section: the tool's description says when to use it. */
  envPromptVars(): null {
    return null;
  }

  tools(): ToolDef[] {
    return [webFetchTool(this.opts)];
  }

  async start(_host: WorldHost): Promise<void> {}

  async stop(): Promise<void> {}
}

const DESCRIBE: WorldDescribe = {
  tools: describeTools(WEB_FETCH_TOOL_DECLS, {
    web_fetch: { zh: '把指定网页的正文按 Markdown 读回来。', en: 'Reads one page as Markdown.' },
  }),
  events: [],
};

export function webFetchDefinition(): WorldDefinition<WebFetchConfigSection> {
  return {
    id: WEB_FETCH_ID,
    label: 'WebFetch',
    defaults: () => ({ ...WEB_FETCH_DEFAULTS }),
    create: (ctx) =>
      new WebFetchWorld({
        baseUrl: ctx.cfg.baseUrl ?? WEB_FETCH_DEFAULTS.baseUrl,
        timeoutMs: ctx.cfg.timeoutMs ?? WEB_FETCH_DEFAULTS.timeoutMs,
        maxChars: ctx.cfg.maxChars ?? WEB_FETCH_DEFAULTS.maxChars,
        secret: (name) => ctx.secret(name),
      }),
    describe: DESCRIBE,
  };
}
