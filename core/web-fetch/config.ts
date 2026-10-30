/** The `web-fetch` World's config section: where the Fetch API lives, how long to wait, and how much of a page or an image to keep. */
import type { ConfigGroup } from 'cortico/core/config-schema.ts';
import type { Language } from 'cortico/core/language.ts';
import type { WorldSection } from 'cortico/world.ts';
import { webFetchText } from './strings.ts';

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

/** 「快速配置」页签 `state` 的形状:密钥只给打码后的样子。 */
export interface WebFetchPanelState {
  fetch: string | null;
  pixabay: string | null;
  pexels: string | null;
}

/** The settings group the advanced mode renders for this World; every key applies at once. */
export function webFetchConfigGroup(language: Language = 'zh'): ConfigGroup {
  const t = webFetchText(language);
  return {
    id: 'world:web-fetch',
    owner: 'world:web-fetch',
    schema: {
      type: 'object',
      title: t.configTitle,
      description: t.configDescription,
      properties: {
        'worlds.web-fetch.baseUrl': {
          type: 'string',
          title: t.baseUrlTitle,
          'x-hot': true,
          description: t.baseUrlDescription(WEB_FETCH_DEFAULTS.baseUrl),
        },
        'worlds.web-fetch.maxChars': {
          type: 'integer',
          minimum: 1000,
          maximum: 8000,
          title: t.maxCharsTitle,
          'x-hot': true,
          description: t.maxCharsDescription,
        },
        'worlds.web-fetch.imageMaxBytes': {
          type: 'integer',
          minimum: 1024,
          maximum: 32 * 1024 * 1024,
          title: t.imageMaxBytesTitle,
          'x-hot': true,
          description: t.imageMaxBytesDescription,
        },
        'worlds.web-fetch.maxImageResults': {
          type: 'integer',
          minimum: 1,
          maximum: 20,
          title: t.maxImageResultsTitle,
          'x-hot': true,
          description: t.maxImageResultsDescription,
        },
        'worlds.web-fetch.timeoutMs': {
          type: 'integer',
          minimum: 1000,
          maximum: 120000,
          title: t.timeoutTitle,
          'x-hot': true,
          description: t.timeoutDescription,
        },
      },
    },
  };
}

export const WEB_FETCH_DEFAULTS = {
  enabled: false,
  baseUrl: 'https://api.deepseek.com',
  timeoutMs: 20_000,
  maxChars: 6_000,
  imageMaxBytes: 8 * 1024 * 1024,
  maxImageResults: 8,
} as const satisfies WebFetchConfigSection;
