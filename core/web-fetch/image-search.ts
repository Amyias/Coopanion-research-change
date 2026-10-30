/**
 * Finding pictures on the web: a provider answers with a picture's direct address, which is what
 * `web_fetch_image` takes. Both providers need a free key; no keyless source is reachable from here
 * (Wikimedia Commons and Openverse time out, Bing answers with advertising, Baidu with a challenge page).
 *
 * Pexels is asked first when its key is set, then Pixabay; either can answer, and an empty or failed
 * provider does not hide the other one. Pexels stopped issuing keys, so Pixabay is the one a new
 * deployment can still set up.
 */
import { reasonOf } from './image.ts';

export type ImageProvider = 'Pexels' | 'Pixabay';

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
  pexelsKey: string;
  pixabayKey: string;
  /** Tests point a provider at a local server; nothing else sets these. */
  pexelsBase?: string;
  pixabayBase?: string;
}

const PEXELS_BASE = 'https://api.pexels.com';
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

async function fromPexels(query: string, opts: ImageSearchOptions, key: string): Promise<ImageHit[]> {
  const base = (opts.pexelsBase ?? PEXELS_BASE).replace(/\/+$/, '');
  const url = `${base}/v1/search?query=${encodeURIComponent(query)}&per_page=${opts.maxResults}&orientation=landscape`;
  const body = await getJson(url, { Authorization: key }, opts.timeoutMs);
  const photos = Array.isArray(body.photos) ? (body.photos as Array<Record<string, unknown>>) : [];
  return photos.flatMap((photo) => {
    const src = photo.src as Record<string, unknown> | undefined;
    const hit = toHit(photo.alt, src?.large ?? src?.original, photo.photographer, 'Pexels');
    return hit ? [hit] : [];
  });
}

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
  if (opts.pexelsKey) providers.push(() => fromPexels(query, opts, opts.pexelsKey));
  if (opts.pixabayKey) providers.push(() => fromPixabay(query, opts, opts.pixabayKey));
  if (providers.length === 0) {
    throw new ImageSearchError('no-provider', 'image search needs a Pexels or Pixabay key');
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
