/** The `web-fetch` World's config section: where the Fetch API lives, how long to wait, and how much of a page or an image to keep. */
import type { WorldSection } from 'cortico/world.ts';

/** The secret the websearch World's DeepSeek provider stores; the Fetch API takes the same key. */
export const WEB_FETCH_SECRET = 'DEEPSEEK_SEARCH_API_KEY';
/** Image search keys: either one is enough, Pexels first. */
export const WEB_FETCH_PEXELS_SECRET = 'PEXELS_API_KEY';
export const WEB_FETCH_PIXABAY_SECRET = 'PIXABAY_API_KEY';

export interface WebFetchConfigSection extends WorldSection {
  /** `<baseUrl>/v1/tools/fetch`; empty means the public API. */
  baseUrl: string;
  timeoutMs: number;
  /** A page longer than this is cut, and the receipt says how much was left out; stays under Core's 8,000-character receipt limit. */
  maxChars: number;
  /** An image larger than this is refused before its body is kept. */
  imageMaxBytes: number;
  /** How many picture addresses one search returns. */
  maxImageResults: number;
}

export const WEB_FETCH_DEFAULTS = {
  enabled: false,
  baseUrl: 'https://api.deepseek.com',
  timeoutMs: 20_000,
  maxChars: 6_000,
  imageMaxBytes: 8 * 1024 * 1024,
  maxImageResults: 8,
} as const satisfies WebFetchConfigSection;
