/**
 * Finding pictures on the web: a provider answers with a picture's direct address, which is what
 * `web_fetch_image` takes. Pixabay needs a free key, set once in the settings page; Bing's image
 * search needs none, so it answers when the API has no key or finds nothing.
 */
import { searchBingImages } from './bing-images.ts';
import { reasonOf } from './image.ts';

export type ImageProvider = 'Pixabay' | 'Bing';

export interface ImageHit {
  /** What the picture shows, in the provider's words. */
  title: string;
  /** The picture itself, on the provider's CDN. */
  url: string;
  /** The photographer or uploader, for a credit line. */
  credit: string;
  /** Which provider answered, for the receipt. */
  provider: ImageProvider;
}

export type ImageSearchFailure = 'no-provider' | 'fetch' | 'no-results';

export class ImageSearchError extends Error {
  readonly kind: ImageSearchFailure;
  constructor(kind: ImageSearchFailure, message: string) {
    super(message);
    this.kind = kind;
  }
}

export interface ImageSearchOptions {
  maxResults: number;
  timeoutMs: number;
  pixabayKey: string;
  /** Tests point the provider at a local server; nothing else sets this. */
  pixabayBase?: string;
  /** The keyless fallback; on unless the config turns it off. */
  bingFallback?: boolean;
  bingBase?: string;
  allowLocal?: boolean;
}

const PIXABAY_BASE = 'https://pixabay.com/api';

/** A query in Chinese finds more when the provider searches Chinese tags. */
const searchLanguage = (query: string): string => (/[\u3400-\u9fff]/.test(query) ? 'zh' : '');

async function getJson(url: string, headers: Record<string, string>, timeoutMs: number): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new ImageSearchError('fetch', reasonOf(error));
  }
  if (!res.ok) throw new ImageSearchError('fetch', `HTTP ${res.status}`);
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    throw new ImageSearchError('fetch', 'the answer is not JSON');
  }
}

/** One line per picture: what it shows, its address, who made it and where it came from. */
const toHit = (title: unknown, url: unknown, credit: unknown, provider: ImageProvider): ImageHit | null => {
  if (typeof url !== 'string' || !/^https?:\/\//.test(url)) return null;
  return {
    title: typeof title === 'string' ? title.trim().slice(0, 80) || 'a picture' : 'a picture',
    url,
    credit: typeof credit === 'string' ? credit.trim() : '',
    provider,
  };
};

async function fromPixabay(query: string, opts: ImageSearchOptions, key: string): Promise<ImageHit[]> {
  const base = (opts.pixabayBase ?? PIXABAY_BASE).replace(/\/+$/, '');
  const language = searchLanguage(query);
  const url = `${base}/?key=${encodeURIComponent(key)}&q=${encodeURIComponent(query)}&image_type=photo`
    + `&per_page=${opts.maxResults}&safesearch=true${language ? `&lang=${language}` : ''}`;
  const body = await getJson(url, {}, opts.timeoutMs);
  const hits = Array.isArray(body.hits) ? (body.hits as Array<Record<string, unknown>>) : [];
  return hits.flatMap((item) => {
    const hit = toHit(item.tags, item.largeImageURL ?? item.webformatURL, item.user, 'Pixabay');
    return hit ? [hit] : [];
  });
}

/** Picture addresses for a query, from the first provider that has one; a refusal is the last one's reason. */
export async function searchImages(query: string, opts: ImageSearchOptions): Promise<ImageHit[]> {
  const providers: Array<() => Promise<ImageHit[]>> = [];
  if (opts.pixabayKey) providers.push(() => fromPixabay(query, opts, opts.pixabayKey));
  if (opts.bingFallback !== false) {
    providers.push(() => searchBingImages(query, {
      maxResults: opts.maxResults,
      timeoutMs: opts.timeoutMs,
      ...(opts.bingBase ? { base: opts.bingBase } : {}),
      ...(opts.allowLocal ? { allowLocal: true } : {}),
    }));
  }
  if (providers.length === 0) {
    throw new ImageSearchError('no-provider', 'image search needs a Pixabay key');
  }

  let lastError: unknown;
  for (const provider of providers) {
    try {
      const hits = await provider();
      if (hits.length > 0) return hits.slice(0, opts.maxResults);
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  throw new ImageSearchError('no-results', `nothing found for "${query}"`);
}
