/**
 * Reading one image over HTTP: the bytes, the MIME type the first bytes prove, and nothing else. The
 * type comes from the bytes rather than the answer's header, and a host that resolves into the local
 * network is refused before any request is made, so a URL cannot be used to probe the machine.
 */
import { lookup } from 'node:dns/promises';

/** The types the chat page, the bubble and every model endpoint read. */
export const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export type ImageMime = (typeof IMAGE_MIMES)[number];

const MAX_REDIRECTS = 5;

/** Why an image was not read; the tool turns each into its own sentence. */
export type ImageFailure = 'blocked' | 'fetch' | 'not-image' | 'too-large';

export class ImageError extends Error {
  readonly kind: ImageFailure;
  constructor(kind: ImageFailure, message: string) {
    super(message);
    this.kind = kind;
  }
}

const ascii = (bytes: Uint8Array, from: number, to: number): string => String.fromCharCode(...bytes.slice(from, to));

/** The type the leading bytes prove, or null for anything that is not one of {@link IMAGE_MIMES}. */
export function sniffImage(bytes: Uint8Array): ImageMime | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(bytes, 1, 4) === 'PNG') return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 6 && ascii(bytes, 0, 3) === 'GIF') return 'image/gif';
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/** Loopback, private, link-local and multicast addresses, including the v4 forms mapped into v6. */
function isLocalAddress(address: string): boolean {
  if (address.includes(':')) {
    const v6 = address.toLowerCase();
    if (v6 === '::' || v6 === '::1') return true;
    if (v6.startsWith('::ffff:')) return isLocalAddress(v6.slice(7));
    return v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80:');
  }
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

/** Throws unless every address the host resolves to is on the public internet. */
async function assertPublicHost(url: URL): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) throw new ImageError('blocked', `${host} is this machine`);
  const addresses = /^[\d.]+$/.test(host) || host.includes(':')
    ? [{ address: host }]
    : await lookup(host, { all: true }).catch(() => { throw new ImageError('fetch', `${host} does not resolve`); });
  const local = addresses.find((entry) => isLocalAddress(entry.address));
  if (local) throw new ImageError('blocked', `${host} resolves into the local network (${local.address})`);
}

export interface ReadImageOptions {
  timeoutMs: number;
  maxBytes: number;
  /** Tests run against a server on this machine; the tool never sets it. */
  allowLocal?: boolean;
}

export interface ImageResult {
  bytes: Uint8Array;
  mime: ImageMime;
  size: number;
}

/** One image, read within `maxBytes` and `timeoutMs`; redirects are followed only onto other public hosts. */
export async function readImage(raw: string, opts: ReadImageOptions): Promise<ImageResult> {
  let url = new URL(raw);
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), opts.timeoutMs);
  try {
    for (let hop = 0; ; hop++) {
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ImageError('blocked', `${url.protocol} is not http or https`);
      if (url.username || url.password) throw new ImageError('blocked', 'the URL carries credentials');
      if (!opts.allowLocal) await assertPublicHost(url);
      const res = await fetch(url, { redirect: 'manual', signal: abort.signal });
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        await res.body?.cancel();
        if (hop >= MAX_REDIRECTS) throw new ImageError('fetch', `more than ${MAX_REDIRECTS} redirects`);
        url = new URL(res.headers.get('location') ?? '', url);
        continue;
      }
      if (res.status !== 200) {
        await res.body?.cancel();
        throw new ImageError('fetch', `HTTP ${res.status}`);
      }
      const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
      if (type && !type.startsWith('image/')) {
        await res.body?.cancel();
        throw new ImageError('not-image', `the answer is ${type}`);
      }
      const declared = Number(res.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > opts.maxBytes) {
        await res.body?.cancel();
        throw new ImageError('too-large', `${(declared / 1048576).toFixed(1)} MB is over the ${(opts.maxBytes / 1048576).toFixed(1)} MB limit`);
      }
      const reader = res.body?.getReader();
      if (!reader) throw new ImageError('fetch', 'the answer has no body');
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > opts.maxBytes) {
          await reader.cancel();
          throw new ImageError('too-large', `over the ${(opts.maxBytes / 1048576).toFixed(1)} MB limit`);
        }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let at = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, at);
        at += chunk.byteLength;
      }
      const mime = sniffImage(bytes);
      if (!mime) throw new ImageError('not-image', `${type || 'the answer'} is not a PNG, JPEG, GIF or WebP image`);
      return { bytes, mime, size };
    }
  } catch (error) {
    if (error instanceof ImageError) throw error;
    if (abort.signal.aborted) throw new ImageError('fetch', `no answer within ${opts.timeoutMs} ms`);
    throw new ImageError('fetch', error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timer);
  }
}
