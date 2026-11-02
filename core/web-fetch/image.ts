/**
 * Reading one image over HTTP: the bytes and the MIME type the first bytes prove, and nothing else.
 * The guards behind the request (public hosts only, redirects, size, timeout) live in http.ts, which
 * every reader of this World shares.
 */
import { OpenError, openUrl, reasonOf } from './http.ts';

export { reasonOf };

/** The types the chat page, the bubble and every model endpoint read. */
export const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export type ImageMime = (typeof IMAGE_MIMES)[number];

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

const FAILURE_OF: Record<OpenError['kind'], ImageFailure> = {
  blocked: 'blocked',
  fetch: 'fetch',
  'too-large': 'too-large',
  type: 'not-image',
};

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
  let opened: { url: string; bytes: Uint8Array; type: string };
  try {
    opened = await openUrl(raw, {
      timeoutMs: opts.timeoutMs,
      maxBytes: opts.maxBytes,
      typePrefix: 'image/',
      ...(opts.allowLocal ? { allowLocal: true } : {}),
    });
  } catch (error) {
    if (error instanceof OpenError) throw new ImageError(FAILURE_OF[error.kind], error.message);
    throw error;
  }
  const mime = sniffImage(opened.bytes);
  if (!mime) throw new ImageError('not-image', `${opened.type || 'the answer'} is not a PNG, JPEG, GIF or WebP image`);
  return { bytes: opened.bytes, mime, size: opened.bytes.length };
}
