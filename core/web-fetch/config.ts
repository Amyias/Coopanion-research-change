/** The `web-fetch` World's config section: where the Fetch API lives, how long to wait and how much of a page to keep. */
import type { WorldSection } from 'cortico/world.ts';

/** The secret the websearch World's DeepSeek provider stores; the Fetch API takes the same key. */
export const WEB_FETCH_SECRET = 'DEEPSEEK_SEARCH_API_KEY';

export interface WebFetchConfigSection extends WorldSection {
  /** `<baseUrl>/v1/tools/fetch`; empty means the public API. */
  baseUrl: string;
  timeoutMs: number;
  /** A page longer than this is cut, and the receipt says how much was left out. */
  maxChars: number;
}

export const WEB_FETCH_DEFAULTS = {
  enabled: false,
  baseUrl: 'https://api.deepseek.com',
  timeoutMs: 20_000,
  maxChars: 12_000,
} as const satisfies WebFetchConfigSection;
