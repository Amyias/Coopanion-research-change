/**
 * The pictures of one `say` bubble: one at a time, with arrows and a count when there is more than one.
 * The bubble's HTML comes from here so the markup can be checked without a browser; the page binds the
 * arrow clicks and keeps the index.
 */

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

/** The index the arrows land on, kept inside the list; 0 for an empty one. */
export function clampIndex(index, count) {
  if (!count) return 0;
  return Math.min(Math.max(index, 0), count - 1);
}

/** The picture area of the bubble: one picture, then the arrows and the count when there is more than one. */
export function carouselHtml(images, index, t) {
  if (!images.length) return '';
  const at = clampIndex(index, images.length);
  const picture = images[at];
  const src = `/say-image/${encodeURIComponent(picture.token)}`;
  const alt = escapeHtml(t('say.imageAlt'));
  const arrows = images.length > 1
    ? `<div class="b-caro">`
      + `<button type="button" class="b-arrow" data-carousel="prev" aria-label="${escapeHtml(t('say.previous'))}"${at === 0 ? ' disabled' : ''}>‹</button>`
      + `<span class="b-count">${at + 1} / ${images.length}</span>`
      + `<button type="button" class="b-arrow" data-carousel="next" aria-label="${escapeHtml(t('say.next'))}"${at === images.length - 1 ? ' disabled' : ''}>›</button>`
      + '</div>'
    : '';
  return `<div class="b-images"><div class="b-pics"><img src="${src}" alt="${alt}" draggable="false"></div>${arrows}</div>`;
}

/** The enlarged view of one picture: the picture at the index, arrows when there is more than one, and a close button. */
export function lightboxHtml(images, index, t) {
  if (!images.length) return '';
  const at = clampIndex(index, images.length);
  const src = `/say-image/${encodeURIComponent(images[at].token)}`;
  const alt = escapeHtml(t('say.imageAlt'));
  const arrows = images.length > 1
    ? `<div class="lb-caro">`
      + `<button type="button" class="lb-arrow" data-lightbox="prev" aria-label="${escapeHtml(t('say.previous'))}"${at === 0 ? ' disabled' : ''}>‹</button>`
      + `<span class="lb-count">${at + 1} / ${images.length}</span>`
      + `<button type="button" class="lb-arrow" data-lightbox="next" aria-label="${escapeHtml(t('say.next'))}"${at === images.length - 1 ? ' disabled' : ''}>›</button>`
      + '</div>'
    : '';
  return `<img class="lb-pic" src="${src}" alt="${alt}">`
    + `<button type="button" class="lb-close" data-lightbox="close" aria-label="${escapeHtml(t('bubble.close'))}">×</button>${arrows}`;
}
