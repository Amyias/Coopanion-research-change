/**
 * The `web-fetch` World: one tool, `web_fetch`, which reads a single page as Markdown through
 * DeepSeek's Fetch API (`POST <base>/v1/tools/fetch`). Cortico's `websearch` World covers search only;
 * this World closes that gap without touching the vendored copy.
 *
 * The key is the one the `websearch` World's DeepSeek provider uses (`DEEPSEEK_SEARCH_API_KEY` in the
 * deployment `.env`), so a deployment that configured search needs nothing else. A page the API cannot
 * read comes back as the API's own reason (403 refused by its policy, 404 no usable content, 402 the
 * account is out of credit), never as a guess.
 */
import { describeTools, type WorldDefinition, type WorldDescribe } from 'cortico/world.ts';
import { WEB_FETCH_DEFAULTS, type WebFetchConfigSection } from './config.ts';
import { WEB_FETCH_TOOL_DECLS } from './tools.ts';
import { WebFetchWorld } from './world.ts';

const DESCRIBE: WorldDescribe = {
  tools: describeTools(WEB_FETCH_TOOL_DECLS, {
    web_fetch: { zh: '把指定网页的正文按 Markdown 读回来。', en: 'Reads one page as Markdown.' },
    web_fetch_image: { zh: '按 URL 取回一张网图，作为附件交给 Bot。', en: 'Downloads one image from a URL as an attachment.' },
    web_search_images: { zh: '按关键词搜图，返回图片直链。', en: 'Finds picture URLs for a query.' },
  }),
  events: [],
};

export const WEB_FETCH: WorldDefinition<WebFetchConfigSection> = {
  id: 'web-fetch',
  label: 'WebFetch',
  defaults: () => ({ ...WEB_FETCH_DEFAULTS }),
  create: (ctx) =>
    new WebFetchWorld({
      baseUrl: ctx.cfg.baseUrl ?? WEB_FETCH_DEFAULTS.baseUrl,
      timeoutMs: ctx.cfg.timeoutMs ?? WEB_FETCH_DEFAULTS.timeoutMs,
      maxChars: ctx.cfg.maxChars ?? WEB_FETCH_DEFAULTS.maxChars,
      imageMaxBytes: ctx.cfg.imageMaxBytes ?? WEB_FETCH_DEFAULTS.imageMaxBytes,
      maxImageResults: ctx.cfg.maxImageResults ?? WEB_FETCH_DEFAULTS.maxImageResults,
      secret: (name) => ctx.secret(name),
    }),
  describe: DESCRIBE,
};
