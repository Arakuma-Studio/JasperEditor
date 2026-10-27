// Missing-asset banners follow the drawn content in host coordinates (App QA N8).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { templateContentBox } from '../src/index.ts';

afterEach(() => vi.restoreAllMocks());

type Box = { left: number; top: number; width: number; height: number };
const rect = (b: Box) =>
	({
		...b,
		x: b.left,
		y: b.top,
		right: b.left + b.width,
		bottom: b.top + b.height,
		toJSON: () => b,
	}) as DOMRect;

/** Layout stub: `card` for elements matching `cardSelector`, the full canvas (scaled by `scale`) for the rest. */
function stubLayout(cardSelector: string, card: Box, canvas: { width: number; height: number }, scale = 1) {
	vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
		if (this.matches(cardSelector)) return rect(card);
		return rect({ left: 0, top: 0, width: canvas.width * scale, height: canvas.height * scale });
	});
	vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
		return this.matches(cardSelector) ? card.width / scale : canvas.width;
	});
}

describe('missing-asset banners on the card', () => {
	it('templateContentBox: the outermost drawn elements smaller than the host, in host px (scale undone)', () => {
		const host = document.createElement('div');
		const wrapper = document.createElement('div');
		const card = document.createElement('div');
		card.className = 'card';
		const skip = document.createElement('div');
		wrapper.append(card);
		host.append(wrapper, skip);
		document.body.append(host);
		stubLayout('.card', { left: 60, top: 400, width: 300, height: 100 }, { width: 1080, height: 1920 }, 0.5);
		expect(templateContentBox(host, skip)).toEqual({ left: 120, top: 800, width: 600, height: 200 });
		host.remove();
	});

	it('no layout (zero size) → null', () => {
		const host = document.createElement('div');
		document.body.append(host);
		expect(templateContentBox(host, null)).toBeNull();
		host.remove();
	});
});
