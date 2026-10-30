/**
 * Finding pictures on the web: Pexels and Pixabay answer with a picture's direct address, which is what
 * `web_fetch_image` takes. Both need a free key; no keyless provider is reachable from here (Wikimedia
 * Commons and Openverse time out, and Bing or Baidu answer with advertising or a challenge page).
 */
import { reasonOf } from './image.ts';

export interface ImageHit {
  /** What the picture shows, in the provider's words. */
  title: string;
  /** The picture itself, on the provider's CDN. */
  url: string;
  /** The photographer or uploader, for a credit line. */
  credit: string;
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

/** One line per picture: what it shows, its address, and who made it. */
const toHit = (title: unknown, url: unknown, credit: unknown): ImageHit | null => {
  if (typeof url !== 'string' || !/^https?:\/\//.test(url)) return null;
  return {
    title: typeof title === 'string' && title.trim() ? title.trim() : 'a picture',
    url,
    credit: typeof credit === 'string' ? credit.trim() : '',
  };
};

async function fromPexels(query: string, opts: ImageSearchOptions, key: string): Promise<ImageHit[]> {
  const base = (opts.pexelsBase ?? PEXELS_BASE).replace(/\/+$/, '');
  const url = `${base}/v1/search?query=${encodeURIComponent(query)}&per_page=${opts.maxResults}&orientation=landscape`;
  const body = await getJson(url, { Authorization: key }, opts.timeoutMs);
  const photos = Array.isArray(body.photos) ? (body.photos as Array<Record<string, unknown>>) : [];
  return photos.flatMap((photo) => {
    const src = photo.src as Record<string, unknown> | undefined;
    const hit = toHit(photo.alt, src?.large ?? src?.original, photo.photographer);
    return hit ? [hit] : [];
  });
}

async function fromPixabay(query: string, opts: ImageSearchOptions, key: string): Promise<ImageHit[]> {
  const base = (opts.pixabayBase ?? PIXABAY_BASE).replace(/\/+$/, '');
  const url = `${base}/?key=${encodeURIComponent(key)}&q=${encodeURIComponent(query)}&image_type=photo&per_page=${opts.maxResults}`;
  const body = await getJson(url, {}, opts.timeoutMs);
  const hits = Array.isArray(body.hits) ? (body.hits as Array<Record<string, unknown>>) : [];
  return hits.flatMap((item) => {
    const hit = toHit(item.tags, item.largeImageURL ?? item.webformatURL, item.user);
    return hit ? [hit] : [];
  });
}

/** Picture addresses for a query: Pexels when its key is set, then Pixabay. */
export async function searchImages(query: string, opts: ImageSearchOptions): Promise<ImageHit[]> {
  if (!opts.pexelsKey && !opts.pixabayKey) {
    throw new ImageSearchError('no-provider', 'image search needs a Pexels or Pixabay key');
  }
  const hits = opts.pexelsKey
    ? await fromPexels(query, opts, opts.pexelsKey)
    : await fromPixabay(query, opts, opts.pixabayKey);
  if (hits.length === 0) throw new ImageSearchError('no-results', `nothing found for "${query}"`);
  return hits.slice(0, opts.maxResults);
}
