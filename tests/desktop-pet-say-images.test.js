// @vitest-environment jsdom
/**
 * The picture area of a say bubble: one picture at a time, the count and the arrow edges, and what a
 * hostile token does to the markup.
 */
import { describe, expect, it } from 'vitest';
import { carouselHtml, clampIndex, lightboxHtml } from '../packages/cortico-world-desktop-pet/web/say-images.js';

const text = {
  'say.imageAlt': 'An image',
  'say.previous': 'Previous image',
  'say.next': 'Next image',
};
const t = (key) => text[key] ?? key;

describe('clampIndex', () => {
  it('keeps an index inside the list', () => {
    expect(clampIndex(0, 3)).toBe(0);
    expect(clampIndex(2, 3)).toBe(2);
    expect(clampIndex(5, 3)).toBe(2);
    expect(clampIndex(-1, 3)).toBe(0);
    expect(clampIndex(4, 0)).toBe(0);
  });
});

describe('carouselHtml', () => {
  it('shows the picture at the index and counts the rest', () => {
    document.body.innerHTML = carouselHtml([{ token: 'a' }, { token: 'b' }, { token: 'c' }], 1, t);
    expect(document.querySelector('.b-pics img').getAttribute('src')).toBe('/say-image/b');
    expect(document.querySelector('.b-pics img').getAttribute('alt')).toBe('An image');
    expect(document.querySelector('.b-count').textContent).toBe('2 / 3');
    expect(document.querySelector('[data-carousel="prev"]').disabled).toBe(false);
    expect(document.querySelector('[data-carousel="next"]').disabled).toBe(false);
  });

  it('disables the arrow at each end', () => {
    document.body.innerHTML = carouselHtml([{ token: 'a' }, { token: 'b' }], 0, t);
    expect(document.querySelector('[data-carousel="prev"]').disabled).toBe(true);
    expect(document.querySelector('[data-carousel="next"]').disabled).toBe(false);
    document.body.innerHTML = carouselHtml([{ token: 'a' }, { token: 'b' }], 1, t);
    expect(document.querySelector('[data-carousel="prev"]').disabled).toBe(false);
    expect(document.querySelector('[data-carousel="next"]').disabled).toBe(true);
  });

  it('gives a single picture no arrows', () => {
    document.body.innerHTML = carouselHtml([{ token: 'a' }], 0, t);
    expect(document.querySelector('.b-pics img')).not.toBeNull();
    expect(document.querySelector('.b-caro')).toBeNull();
  });

  it('renders nothing without pictures', () => {
    expect(carouselHtml([], 0, t)).toBe('');
  });

  it('keeps a hostile token out of the markup', () => {
    document.body.innerHTML = carouselHtml([{ token: 'a" onerror="alert(1)' }], 0, t);
    const img = document.querySelector('img');
    expect(img.getAttribute('onerror')).toBeNull();
    expect(img.getAttribute('src')).toContain('a%22%20onerror%3D%22alert(1)');
  });
});

describe('lightboxHtml', () => {
  const images = [{ token: 'a' }, { token: 'b' }];

  it('shows the picture at the index with its count and arrows', () => {
    document.body.innerHTML = lightboxHtml(images, 1, t);
    expect(document.querySelector('.lb-pic').getAttribute('src')).toBe('/say-image/b');
    expect(document.querySelector('.lb-count').textContent).toBe('2 / 2');
    expect(document.querySelector('[data-lightbox="prev"]').disabled).toBe(false);
    expect(document.querySelector('[data-lightbox="next"]').disabled).toBe(true);
    expect(document.querySelector('[data-lightbox="close"]')).not.toBeNull();
  });

  it('gives a single picture a close button and no arrows', () => {
    document.body.innerHTML = lightboxHtml([images[0]], 0, t);
    expect(document.querySelector('.lb-pic')).not.toBeNull();
    expect(document.querySelector('.lb-caro')).toBeNull();
    expect(document.querySelector('[data-lightbox="close"]')).not.toBeNull();
  });

  it('renders nothing without pictures', () => {
    expect(lightboxHtml([], 0, t)).toBe('');
  });
});
