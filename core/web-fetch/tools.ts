/** The tools of the `web-fetch` World: `web_fetch` reads one page as Markdown through DeepSeek's Fetch API. */
import type { ToolDef } from 'cortico/core/types.ts';
import { WEB_FETCH_DEFAULTS, WEB_FETCH_PEXELS_SECRET, WEB_FETCH_PIXABAY_SECRET, WEB_FETCH_SECRET } from './config.ts';
import { ImageError, readImage, type ImageFailure, type ImageResult } from './image.ts';
import { ImageSearchError, searchImages, type ImageHit } from './image-search.ts';

/** The API refuses a longer URL, and one with credentials in it. */
const URL_MAX = 8192;
const RETRY_DELAYS_MS = [1000, 3000];

export interface WebFetchOptions {
  baseUrl: string;
  timeoutMs: number;
  maxChars: number;
  imageMaxBytes: number;
  maxImageResults: number;
  secret(name: string): string;
  /** Tests read from a server on this machine; the definition never sets it. */
  allowLocal?: boolean;
  /** Tests point a provider at a local server; the definition never sets them. */
  pexelsBase?: string;
  pixabayBase?: string;
}

const URL_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    url: { type: 'string', minLength: 1, maxLength: URL_MAX, description: 'An absolute http or https URL with a host.' },
  },
  required: ['url'],
} as const;

export const WEB_FETCH_TOOL_DECL: Omit<ToolDef, 'handler'> = {
  name: 'web_fetch',
  description:
    'Read one web page as Markdown. Use it when the person hands over a link or a search result needs its full text; web_search results usually carry enough summary on their own. One page per call.',
  tags: ['read'],
  parameters: URL_PARAMETERS,
};

export const WEB_FETCH_IMAGE_TOOL_DECL: Omit<ToolDef, 'handler'> = {
  name: 'web_fetch_image',
  description:
    'Download one image from a direct URL, so the person can see it and you can look at it. Get the URL from web_search_images or from the person. The image comes back as an attachment; show it with pet_say. One image per call.',
  tags: ['read'],
  parameters: URL_PARAMETERS,
};

export const WEB_FETCH_SEARCH_IMAGES_TOOL_DECL: Omit<ToolDef, 'handler'> = {
  name: 'web_search_images',
  description:
    'Find pictures on the web and return their direct URLs, one per line. Hand one of those URLs to web_fetch_image to look at the picture. Use it when the person asks for a picture of something.',
  tags: ['read'],
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      query: { type: 'string', minLength: 1, maxLength: 200, description: 'What the picture should show, in a few words.' },
    },
    required: ['query'],
  },
};

export const WEB_FETCH_TOOL_DECLS: ReadonlyArray<Omit<ToolDef, 'handler'>> = [WEB_FETCH_TOOL_DECL, WEB_FETCH_IMAGE_TOOL_DECL, WEB_FETCH_SEARCH_IMAGES_TOOL_DECL];

class FetchError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** The bracket each refusal opens with, so a receipt says at once which way the call failed. */
const IMAGE_FAILURE: Record<ImageFailure, string> = {
  blocked: 'not allowed',
  fetch: 'fetch failed',
  'not-image': 'not an image',
  'too-large': 'too large',
};

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
    ...WEB_FETCH_TOOL_DECL,
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

/** The size the receipt states, in the unit a person reads at a glance. */
function sizeOf(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
}

/** One image in, one attachment out; a refusal states what the answer was instead. */
export function imageFetchTool(opts: WebFetchOptions): ToolDef {
  return {
    ...WEB_FETCH_IMAGE_TOOL_DECL,
    handler: async (args) => {
      const url = fetchableUrl(typeof args.url === 'string' ? args.url.trim() : '');
      if (!url) return '[bad input] url must be an absolute http or https URL with a host and no credentials';
      let image: ImageResult;
      try {
        image = await readImage(url, {
          timeoutMs: opts.timeoutMs,
          maxBytes: opts.imageMaxBytes,
          ...(opts.allowLocal ? { allowLocal: true } : {}),
        });
      } catch (error) {
        if (error instanceof ImageError) return `[${IMAGE_FAILURE[error.kind]}] ${error.message}`;
        return `[fetch failed] ${error instanceof Error ? error.message : String(error)}`;
      }
      const parsed = new URL(url);
      const named = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() ?? '');
      const name = (named.slice(0, 80) || `image.${image.mime.split('/')[1]}`).replace(/[^\w.-]/g, '_');
      return {
        text: `web image: ${url} · ${image.mime} · ${sizeOf(image.size)}`,
        blobs: [{ bytes: image.bytes, mime: image.mime, name, fallbackText: `an image from ${parsed.host}` }],
      };
    },
  };
}

/** Picture addresses for a query, one line each, ready to hand to `web_fetch_image`. */
export function searchImagesTool(opts: WebFetchOptions): ToolDef {
  return {
    ...WEB_FETCH_SEARCH_IMAGES_TOOL_DECL,
    handler: async (args) => {
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      if (!query || query.length > 200) return '[bad input] query must be 1 to 200 characters';
      let hits: ImageHit[];
      try {
        hits = await searchImages(query, {
          maxResults: opts.maxImageResults,
          timeoutMs: opts.timeoutMs,
          pexelsKey: opts.secret(WEB_FETCH_PEXELS_SECRET).trim(),
          pixabayKey: opts.secret(WEB_FETCH_PIXABAY_SECRET).trim(),
          ...(opts.pexelsBase ? { pexelsBase: opts.pexelsBase } : {}),
          ...(opts.pixabayBase ? { pixabayBase: opts.pixabayBase } : {}),
        });
      } catch (error) {
        if (error instanceof ImageSearchError) {
          if (error.kind === 'no-provider') return `[tool failed] image search needs ${WEB_FETCH_PEXELS_SECRET} or ${WEB_FETCH_PIXABAY_SECRET}`;
          if (error.kind === 'no-results') return `[no results] ${error.message}`;
        }
        return `[fetch failed] ${error instanceof Error ? error.message : String(error)}`;
      }
      return [`web images: ${query}`, ...hits.map((hit, index) => `${index + 1}. ${hit.title} — ${hit.url}${hit.credit ? ` (by ${hit.credit})` : ''}`)].join('\n');
    },
  };
}
