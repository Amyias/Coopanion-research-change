/**
 * Picture addresses in a page's HTML: og:image and twitter:image, <img> sources (lazy-loading
 * attributes included), and <source srcset>, resolved against the page. Only addresses are returned;
 * nothing is downloaded here, and web_fetch_image reads the one the bot picks.
 */
import { OpenError, openUrl } from './http.ts';

export interface PageImage {
  url: string;
  alt: string;
}

export interface ReadPageImagesOptions {
  timeoutMs: number;
  maxBytes: number;
  maxImages: number;
  /** Tests run against a server on this machine; the tool never sets it. */
  allowLocal?: boolean;
}

/** Attributes that carry the picture, in the order a reader should prefer them. */
const IMG_ATTRS = ['src', 'data-src', 'data-original', 'data-lazy-src', 'data-actualsrc', 'data-url'];
/** Extensions web_fetch_image cannot read; keeping them out keeps the list usable. */
const UNREADABLE = /\.(?:svg|ico|bmp|avif|tiff?|heic)(?:$|[?#])/i;

/** The first usable address in a srcset value ("a.jpg 1x, b.jpg 2x" → "a.jpg"). */
function firstCandidate(srcset: string): string {
  const first = srcset.split(',')[0]?.trim() ?? '';
  return first.split(/\s+/)[0] ?? '';
}

function attribute(tag: string, name: string): string {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return (match?.[1] ?? match?.[2] ?? match?.[3] ?? '').trim();
}

const decodeEntities = (text: string): string => text
  .replace(/&amp;/gi, '&')
  .replace(/&quot;/gi, '"')
  .replace(/&#0?39;|&apos;/gi, "'")
  .replace(/&lt;/gi, '<')
  .replace(/&gt;/gi, '>');

/** The absolute picture address a raw attribute value names, or null for anything not a public http(s) picture. */
function pictureUrl(raw: string, base: string): string | null {
  if (!raw || /^(?:data|blob|javascript|about):/i.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(decodeEntities(raw), base);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (UNREADABLE.test(url.pathname + url.search)) return null;
  return url.href;
}

/** Picture addresses from one page, in document order, without duplicates, at most `max`. */
export function extractPageImages(html: string, baseUrl: string, max: number): PageImage[] {
  const found: PageImage[] = [];
  const seen = new Set<string>();
  const add = (raw: string, alt: string): void => {
    if (found.length >= max) return;
    const url = pictureUrl(raw, baseUrl);
    if (!url || seen.has(url)) return;
    seen.add(url);
    found.push({ url, alt: decodeEntities(alt).slice(0, 120) });
  };

  for (const match of html.matchAll(/<meta\s[^>]*>/gi)) {
    const tag = match[0];
    const name = (attribute(tag, 'property') || attribute(tag, 'name')).toLowerCase();
    if (!/^(?:og:image(?::url)?|twitter:image(?::src)?)$/.test(name)) continue;
    add(attribute(tag, 'content'), attribute(tag, 'alt'));
  }
  for (const match of html.matchAll(/<img\s[^>]*>/gi)) {
    const tag = match[0];
    const alt = attribute(tag, 'alt');
    const srcset = attribute(tag, 'srcset');
    if (srcset) add(firstCandidate(srcset), alt);
    for (const name of IMG_ATTRS) add(attribute(tag, name), alt);
    const lazySrcset = attribute(tag, 'data-srcset');
    if (lazySrcset) add(firstCandidate(lazySrcset), alt);
  }
  for (const match of html.matchAll(/<source\s[^>]*>/gi)) {
    const tag = match[0];
    const srcset = attribute(tag, 'srcset') || attribute(tag, 'data-srcset');
    if (srcset) add(firstCandidate(srcset), '');
  }
  return found;
}

/** The charset the answer declares, or utf-8 when it names none this runtime knows. */
function decoderFor(contentType: string): (bytes: Uint8Array) => string {
  const charset = /charset\s*=\s*"?([\w-]+)"?/i.exec(contentType)?.[1] ?? '';
  let decoder: { decode(bytes?: Uint8Array): string };
  try {
    decoder = new TextDecoder(charset || 'utf-8');
  } catch {
    decoder = new TextDecoder('utf-8');
  }
  return (bytes) => decoder.decode(bytes);
}

/** Picture addresses from one page; a non-HTML answer, an unreachable page or no pictures all answer with none. */
export async function readPageImages(pageUrl: string, opts: ReadPageImagesOptions): Promise<PageImage[]> {
  let opened: { url: string; bytes: Uint8Array; type: string; contentType: string };
  try {
    opened = await openUrl(pageUrl, {
      timeoutMs: opts.timeoutMs,
      maxBytes: opts.maxBytes,
      ...(opts.allowLocal ? { allowLocal: true } : {}),
    });
  } catch (error) {
    if (error instanceof OpenError) return [];
    throw error;
  }
  if (opened.type && opened.type !== 'text/html' && opened.type !== 'application/xhtml+xml') return [];
  return extractPageImages(decoderFor(opened.contentType)(opened.bytes), opened.url, opts.maxImages);
}
