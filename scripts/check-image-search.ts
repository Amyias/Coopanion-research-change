/**
 * The hand-run check behind image search: ask each provider that has a key for one query and report how
 * many picture addresses came back. Run it before a release; a provider that answers 0 has changed or is
 * unreachable, and the tool would tell Coo nothing found. No key means that provider is skipped.
 */
import { searchImages } from '../core/web-fetch/image-search.ts';

const QUERY = 'corgi puppy';
const pexelsKey = (process.env.PEXELS_API_KEY ?? '').trim();
const pixabayKey = (process.env.PIXABAY_API_KEY ?? '').trim();
if (!pexelsKey && !pixabayKey) {
  console.log('no PEXELS_API_KEY or PIXABAY_API_KEY in this shell; nothing to check');
  process.exit(0);
}

let hits = 0;
try {
  const found = await searchImages(QUERY, { maxResults: 5, timeoutMs: 20_000, pexelsKey, pixabayKey });
  hits = found.length;
  for (const hit of found) console.log('•', hit.title.slice(0, 50), '|', hit.url.slice(0, 90));
} catch (error) {
  console.log('image search failed:', error instanceof Error ? error.message : String(error));
}

console.log(hits > 0 ? `ok: ${hits} pictures for "${QUERY}"` : 'MISMATCH: no pictures came back');
process.exit(hits > 0 ? 0 : 1);
