/**
 * WebFetch 的「快速配置」页签:三个密钥(网页 / Pixabay / Pexels),粘贴即写进部署 .env,
 * 页面只拿得到打码后的样子;下面一个测试按钮,用当前密钥搜一次。
 */
import type { WebUiClientBundle, WebUiPanel, WebUiPanelContext } from 'cortico/web/shared/client-panel.ts';
import type { WebFetchPanelState } from '../config.ts';
import { webFetchText } from '../strings.ts';

const NAMES = ['fetch', 'pixabay', 'pexels'] as const;
type KeyName = (typeof NAMES)[number];
const KEY_LABELS: Record<KeyName, 'fetchKey' | 'pixabayKey' | 'pexelsKey'> = {
  fetch: 'fetchKey',
  pixabay: 'pixabayKey',
  pexels: 'pexelsKey',
};
const KEY_URLS: Record<KeyName, string> = {
  fetch: 'https://platform.deepseek.com/api_keys',
  pixabay: 'https://pixabay.com/api/docs/',
  pexels: 'https://www.pexels.com/api/',
};

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const setupPanel: WebUiPanel = {
  mount(ctx: WebUiPanelContext) {
    const { ui, root } = ctx;
    const t = webFetchText(ctx.language);
    let state: WebFetchPanelState | null = null;

    const keys = ui.sheet({ title: t.keysTitle, desc: t.keysDesc });
    const rows = {} as Record<KeyName, { status: HTMLElement; input: HTMLInputElement; save: HTMLButtonElement; clear: HTMLButtonElement }>;
    for (const name of NAMES) {
      const label = ui.h('div', 'mono', t[KEY_LABELS[name]]);
      const status = ui.h('div', 'rowbar');
      const input = ui.input({ type: 'password', cls: 'mono grow', onCommit: () => void saveKey(name) });
      const save = ui.button(t.save, { size: 'sm', variant: 'primary', onClick: () => void saveKey(name) });
      const clear = ui.button(t.clear, { size: 'sm', variant: 'danger', onClick: () => void clearKey(name) });
      const link = ui.h('a', '', t.getKey) as HTMLAnchorElement;
      link.href = KEY_URLS[name];
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      const edit = ui.rowbar();
      edit.append(input, save, clear, link);
      keys.body.append(label, status, edit);
      rows[name] = { status, input, save, clear };
    }
    const testRow = ui.rowbar();
    const test = ui.button(t.test, { size: 'sm', onClick: () => void runTest() });
    const testOut = ui.msgline();
    testOut.hidden = true;
    testRow.append(test);
    keys.body.append(testRow, testOut);
    root.append(keys.el);

    function render(next: WebFetchPanelState): void {
      state = next;
      for (const name of NAMES) {
        const masked = next[name];
        const row = rows[name];
        row.status.replaceChildren(ui.pill(masked ? t.keySet : t.keyUnset, masked ? 'on' : 'off'));
        if (masked) row.status.append(ui.h('span', 'mono', masked));
        row.clear.disabled = !masked;
      }
    }

    async function call(method: string, args: unknown[] = []): Promise<boolean> {
      try {
        render(await ctx.invoke<WebFetchPanelState>(method, args));
        void ctx.refresh();
        return true;
      } catch (err) {
        ui.toast(errText(err), 'bad');
        return false;
      }
    }

    async function saveKey(name: KeyName): Promise<void> {
      const value = rows[name].input.value.trim();
      if (!value) {
        ui.toast(t.keyEmpty, 'bad');
        return;
      }
      const off = ui.disable(rows[name].save, rows[name].input);
      if (await call('setKey', [name, value])) {
        rows[name].input.value = '';
        ui.toast(t.keySaved);
      }
      off.dispose();
    }

    async function clearKey(name: KeyName): Promise<void> {
      if (!(await ui.confirm({ title: t.clear, danger: true }))) return;
      if (await call('clearKey', [name])) ui.toast(t.keyCleared);
    }

    async function runTest(): Promise<void> {
      const off = ui.disable(test);
      try {
        const out = await ctx.invoke<{ count: number }>('test', []);
        testOut.textContent = t.testOkShort(out.count);
        testOut.className = 'msgline';
      } catch (err) {
        testOut.textContent = errText(err);
        testOut.className = 'msgline bad';
      }
      testOut.hidden = false;
      off.dispose();
    }

    void call('state');
  },
};

const bundle: WebUiClientBundle = { panels: { setup: setupPanel } };
export default bundle;
