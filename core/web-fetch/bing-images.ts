/**
 * Picture addresses from Bing's image search HTML, used when the picture search API has no key or
 * finds nothing: the page script carries each result's media address as `murl`. Nothing is
 * downloaded here; web_fetch_image reads the one the bot picks.
 */
import type { ImageHit } from './image-search.ts';
import { openUrl } from './http.ts';

const BING_BASE = 'https://cn.bing.com';
/** Bing answers a program without a browser's headers with a challenge page. */
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
};

/** `murl` is escaped in one of three ways depending on how the page was serialized. */
const MURL_PATTERNS = [
  /murl&quot;:&quot;([^"<>]+?)&quot;/g,
  /"murl":"([^"<>]+?)"/g,
  /\\"murl\\":\\"([^"<>]+?)\\"/g,
];

const decode = (value: string): string => value
  .replace(/&amp;/gi, '&')
  .replace(/\\\//g, '/')
  .replace(/&quot;/gi, '"');

/** Picture addresses in one Bing image-search answer, without duplicates, at most `max`. */
export function extractBingImages(html: string, max: number): ImageHit[] {
  const found: ImageHit[] = [];
  const seen = new Set<string>();
  for (const pattern of MURL_PATTERNS) {
    for (const match of html.matchAll(pattern)) {
      if (found.length >= max) return found;
      const url = decode(match[1]).trim();
      if (!/^https?:\/\/[^\s]+$/i.test(url) || seen.has(url)) continue;
      seen.add(url);
      found.push({ title: 'a picture', url, credit: '', provider: 'Bing' });
    }
  }
  return found;
}

export interface BingSearchOptions {
  maxResults: number;
  timeoutMs: number;
  /** Tests point the search at a local server; nothing else sets it. */
  base?: string;
  allowLocal?: boolean;
}

/** Picture addresses for a query from Bing's image search; an empty list means this answer carried none. */
export async function searchBingImages(query: string, opts: BingSearchOptions): Promise<ImageHit[]> {
  const base = (opts.base ?? BING_BASE).replace(/\/+$/, '');
  const opened = await openUrl(`${base}/images/search?q=${encodeURIComponent(query)}&form=HDRSC2&first=1&mkt=zh-CN`, {
    timeoutMs: opts.timeoutMs,
    maxBytes: 2 * 1024 * 1024,
    headers: HEADERS,
    ...(opts.allowLocal ? { allowLocal: true } : {}),
  });
  if (opened.type && opened.type !== 'text/html') return [];
  return extractBingImages(new TextDecoder('utf-8').decode(opened.bytes), opts.maxResults);
}
