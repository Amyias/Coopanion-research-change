/**
 * Operator-facing text for the WebFetch World's settings page and config group; zh and en, as the vendored
 * worlds do (a language without its own table reads the base one).
 */
import { pick, type Language } from 'cortico/core/language.ts';

const zh = {
  moduleLabel: 'WebFetch',
  // config group
  configTitle: 'WebFetch · 读网页与搜图',
  configDescription: '改完立即生效。',
  baseUrlTitle: 'Fetch API 地址',
  baseUrlDescription: (def: string) => `读网页发往 <地址>/v1/tools/fetch。留空用 ${def}。`,
  maxCharsTitle: '网页回执上限',
  maxCharsDescription: '超过就截断,并在回执里写明省略了多少字符。',
  imageMaxBytesTitle: '图片大小上限',
  imageMaxBytesDescription: '超过就拒绝,不保存字节。',
  maxImageResultsTitle: '搜图返回条数',
  maxImageResultsDescription: '一次搜索最多返回多少条图片地址。',
  timeoutTitle: '请求超时',
  timeoutDescription: '单次请求的超时。',
  // WebUI
  fetch: '网页',
  search: '搜图',
  fetchKey: '网页密钥',
  pixabayKey: 'Pixabay 密钥',
  pexelsKey: 'Pexels 密钥',
  keySet: '已配置',
  keyUnset: '未配置',
  keyUnsetBadge: '缺',
  panelTitle: '快速配置',
  panelDescription: 'Pixabay 或 Pexels 填一个就能搜图;读网页只用 DeepSeek 搜索密钥。',
  keyEmpty: '请先粘贴密钥',
  unknownPanel: (panel: string) => `未知页签: ${panel}`,
  unknownMethod: (method: string) => `未知方法: ${method}`,
  unknownKey: (name: string) => `未知密钥: ${name}`,
  noTestKey: '先填 Pixabay 或 Pexels 密钥再测试',
  testQuery: 'corgi',
  testOk: (n: number, provider: string) => `${provider} 返回 ${n} 条`,
};

const en: typeof zh = {
  moduleLabel: 'WebFetch',
  configTitle: 'WebFetch · pages and pictures',
  configDescription: 'Takes effect at once.',
  baseUrlTitle: 'Fetch API base URL',
  baseUrlDescription: (def: string) => `Pages go to <url>/v1/tools/fetch; empty means ${def}.`,
  maxCharsTitle: 'Page receipt limit',
  maxCharsDescription: 'Longer pages are cut, and the receipt says how much was left out.',
  imageMaxBytesTitle: 'Picture size limit',
  imageMaxBytesDescription: 'A larger picture is refused; its bytes are not kept.',
  maxImageResultsTitle: 'Pictures per search',
  maxImageResultsDescription: 'How many picture addresses one search returns.',
  timeoutTitle: 'Request timeout',
  timeoutDescription: 'Timeout of one request.',
  fetch: 'Pages',
  search: 'Pictures',
  fetchKey: 'Page key',
  pixabayKey: 'Pixabay key',
  pexelsKey: 'Pexels key',
  keySet: 'Set',
  keyUnset: 'Not set',
  keyUnsetBadge: 'none',
  panelTitle: 'Quick setup',
  panelDescription: 'One Pixabay or Pexels key is enough for pictures; pages use the DeepSeek search key.',
  keyEmpty: 'Paste a key first',
  unknownPanel: (panel: string) => `Unknown panel: ${panel}`,
  unknownMethod: (method: string) => `Unknown method: ${method}`,
  unknownKey: (name: string) => `Unknown key: ${name}`,
  noTestKey: 'Set a Pixabay or Pexels key before testing',
  testQuery: 'corgi',
  testOk: (n: number, provider: string) => `${provider} returned ${n}`,
};

export const webFetchText = (language: Language = 'zh') => pick(language, { zh, en });
