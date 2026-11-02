/**
 * Reading one URL over HTTP: the bytes, the type the answer declares, and the guards every reader of
 * this World shares. Redirects are followed only onto other public hosts, a host that resolves into
 * the local network is refused before any request is made, and a body larger than the caller allows
 * is dropped as soon as it crosses the line.
 */
import { lookup } from 'node:dns/promises';

const MAX_REDIRECTS = 5;

/** Why a URL was not read; each reader turns these into its own sentence. */
export type OpenFailure = 'blocked' | 'fetch' | 'too-large' | 'type';

export class OpenError extends Error {
  readonly kind: OpenFailure;
  constructor(kind: OpenFailure, message: string) {
    super(message);
    this.kind = kind;
  }
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
  if (host === 'localhost' || host.endsWith('.localhost')) throw new OpenError('blocked', `${host} is this machine`);
  const addresses = /^[\d.]+$/.test(host) || host.includes(':')
    ? [{ address: host }]
    : await lookup(host, { all: true }).catch(() => { throw new OpenError('fetch', `${host} does not resolve`); });
  const local = addresses.find((entry) => isLocalAddress(entry.address));
  if (local) throw new OpenError('blocked', `${host} resolves into the local network (${local.address})`);
}

/** `fetch` reports a failed connection as "fetch failed"; the code behind it is what a receipt needs. */
export function reasonOf(error: unknown): string {
  const cause = (error as { cause?: { code?: unknown; message?: unknown } } | null)?.cause;
  const code = typeof cause?.code === 'string' ? cause.code : '';
  const detail = typeof cause?.message === 'string' ? cause.message : '';
  if (code && detail) return `${code}: ${detail}`;
  if (code) return code;
  return detail || (error instanceof Error ? error.message : String(error));
}

export interface OpenOptions {
  timeoutMs: number;
  maxBytes: number;
  /** Tests run against a server on this machine; the tools never set it. */
  allowLocal?: boolean;
  /** The content-type prefix the answer must declare; empty accepts any type, and an answer without one passes. */
  typePrefix?: string;
}

export interface OpenResult {
  url: string;
  bytes: Uint8Array;
  /** The media type alone, lowercased, for a prefix check. */
  type: string;
  /** The whole content-type header, which carries a charset for text. */
  contentType: string;
}

/**
 * One GET, within `maxBytes` and `timeoutMs`; a redirect is followed only onto another public host.
 * `url` in the result is the address that answered, which resolves relative links against it.
 */
export async function openUrl(raw: string, opts: OpenOptions): Promise<OpenResult> {
  let url = new URL(raw);
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), opts.timeoutMs);
  try {
    for (let hop = 0; ; hop++) {
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new OpenError('blocked', `${url.protocol} is not http or https`);
      if (url.username || url.password) throw new OpenError('blocked', 'the URL carries credentials');
      if (!opts.allowLocal) await assertPublicHost(url);
      const res = await fetch(url, { redirect: 'manual', signal: abort.signal });
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        await res.body?.cancel();
        if (hop >= MAX_REDIRECTS) throw new OpenError('fetch', `more than ${MAX_REDIRECTS} redirects`);
        url = new URL(res.headers.get('location') ?? '', url);
        continue;
      }
      if (res.status !== 200) {
        await res.body?.cancel();
        throw new OpenError('fetch', `HTTP ${res.status}`);
      }
      const contentType = res.headers.get('content-type') ?? '';
      const type = contentType.split(';')[0].trim().toLowerCase();
      const prefix = opts.typePrefix ?? '';
      if (prefix && type && !type.startsWith(prefix)) {
        await res.body?.cancel();
        throw new OpenError('type', `the answer is ${type}`);
      }
      const declared = Number(res.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > opts.maxBytes) {
        await res.body?.cancel();
        throw new OpenError('too-large', `${(declared / 1048576).toFixed(1)} MB is over the ${(opts.maxBytes / 1048576).toFixed(1)} MB limit`);
      }
      const reader = res.body?.getReader();
      if (!reader) throw new OpenError('fetch', 'the answer has no body');
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > opts.maxBytes) {
          await reader.cancel();
          throw new OpenError('too-large', `over the ${(opts.maxBytes / 1048576).toFixed(1)} MB limit`);
        }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let at = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, at);
        at += chunk.byteLength;
      }
      return { url: url.href, bytes, type, contentType };
    }
  } catch (error) {
    if (error instanceof OpenError) throw error;
    if (abort.signal.aborted) throw new OpenError('fetch', `no answer within ${opts.timeoutMs} ms`);
    throw new OpenError('fetch', reasonOf(error));
  } finally {
    clearTimeout(timer);
  }
}
