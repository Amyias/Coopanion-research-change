/** The `web-fetch` World's class: it mounts the tools and has no environment section of its own. */
import type { Language } from 'cortico/core/language.ts';
import type { ToolDef, World, WorldHost, WorldWebUiDecl } from 'cortico/core/types.ts';
import { WEB_FETCH_PEXELS_SECRET, WEB_FETCH_PIXABAY_SECRET, WEB_FETCH_SECRET, webFetchConfigGroup, type WebFetchPanelState } from './config.ts';
import { searchImages } from './image-search.ts';
import { webFetchText } from './strings.ts';
import { imageFetchTool, searchImagesTool, webFetchTool, type WebFetchOptions } from './tools.ts';

/** The one page the advanced mode shows for this World. */
const SETUP_PANEL = 'setup';
/** The keys the page may write, by the name the page passes. */
const SECRET_NAMES: Readonly<Record<string, string>> = {
  fetch: WEB_FETCH_SECRET,
  pixabay: WEB_FETCH_PIXABAY_SECRET,
  pexels: WEB_FETCH_PEXELS_SECRET,
};

/** A key as the page shows it: its first six and last four characters. */
function maskKey(key: string): string {
  return key.length <= 12 ? `${key.slice(0, 2)}…` : `${key.slice(0, 6)}…${key.slice(-4)}`;
}

export class WebFetchWorld implements World {
  readonly id = 'web-fetch';
  private readonly opts: WebFetchOptions;

  constructor(opts: WebFetchOptions) {
    this.opts = opts;
  }

  /** No environment section: the tool's description says when to use it. */
  envPromptVars(): Record<string, string> {
    return {};
  }

  tools(): ToolDef[] {
    return [webFetchTool(this.opts), imageFetchTool(this.opts), searchImagesTool(this.opts)];
  }

  webUi(language: Language = 'zh'): WorldWebUiDecl {
    const t = webFetchText(language);
    const has = (name: string) => !!this.opts.secret(name).trim();
    const search = has(WEB_FETCH_PIXABAY_SECRET) || has(WEB_FETCH_PEXELS_SECRET);
    return {
      label: t.moduleLabel,
      lamps: [
        { label: t.fetch, state: has(WEB_FETCH_SECRET) ? 'online' : 'offline', hint: has(WEB_FETCH_SECRET) ? t.keySet : t.keyUnset },
        { label: t.search, state: search ? 'online' : 'offline', hint: search ? t.keySet : t.keyUnset },
      ],
      badges: [
        { label: t.fetchKey, value: has(WEB_FETCH_SECRET) ? t.keySet : t.keyUnsetBadge, tone: has(WEB_FETCH_SECRET) ? 'on' : 'off' },
        { label: t.pixabayKey, value: has(WEB_FETCH_PIXABAY_SECRET) ? t.keySet : t.keyUnsetBadge, tone: has(WEB_FETCH_PIXABAY_SECRET) ? 'on' : 'off' },
        { label: t.pexelsKey, value: has(WEB_FETCH_PEXELS_SECRET) ? t.keySet : t.keyUnsetBadge, tone: has(WEB_FETCH_PEXELS_SECRET) ? 'on' : 'off' },
      ],
      panels: [{ id: SETUP_PANEL, title: t.panelTitle, description: t.panelDescription, getMethods: ['state'] }],
      invoke: (panel, method, args) => this.invoke(panel, method, args, language),
      config: [webFetchConfigGroup(language)],
    };
  }

  /** The page's keys, masked; nothing else about the deployment is shown. */
  private panelState(): WebFetchPanelState {
    const masked = (name: string) => {
      const key = this.opts.secret(name).trim();
      return key ? maskKey(key) : null;
    };
    return { fetch: masked(WEB_FETCH_SECRET), pixabay: masked(WEB_FETCH_PIXABAY_SECRET), pexels: masked(WEB_FETCH_PEXELS_SECRET) };
  }

  private async invoke(panel: string, method: string, args: unknown[], language: Language): Promise<unknown> {
    const t = webFetchText(language);
    if (panel !== SETUP_PANEL) throw new Error(t.unknownPanel(panel));
    const which = typeof args[0] === 'string' ? args[0] : '';
    switch (method) {
      case 'state':
        return this.panelState();
      case 'setKey': {
        const name = SECRET_NAMES[which];
        if (!name) throw new Error(t.unknownKey(which));
        const key = typeof args[1] === 'string' ? args[1].trim() : '';
        if (!key || /\s/.test(key)) throw new Error(t.keyEmpty);
        this.opts.storeSecret(name, key);
        return this.panelState();
      }
      case 'clearKey': {
        const name = SECRET_NAMES[which];
        if (!name) throw new Error(t.unknownKey(which));
        this.opts.storeSecret(name, '');
        return this.panelState();
      }
      case 'test': {
        const pexelsKey = this.opts.secret(WEB_FETCH_PEXELS_SECRET).trim();
        const pixabayKey = this.opts.secret(WEB_FETCH_PIXABAY_SECRET).trim();
        if (!pexelsKey && !pixabayKey) throw new Error(t.noTestKey);
        const hits = await searchImages(t.testQuery, { maxResults: 1, timeoutMs: this.opts.cfg.timeoutMs, pexelsKey, pixabayKey });
        return { ok: true, provider: hits[0]?.provider ?? '', count: hits.length, text: t.testOk(hits.length, hits[0]?.provider ?? '') };
      }
      default:
        throw new Error(t.unknownMethod(method));
    }
  }

  async start(_host: WorldHost): Promise<void> {}

  async stop(): Promise<void> {}
}
