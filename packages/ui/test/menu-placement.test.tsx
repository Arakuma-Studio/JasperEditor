// Menus stay inside the window (wp fixups): point menus flip / pin and scroll, submenus flip left and slide up.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { PointMenu } from '../src/menu/PointMenu.tsx';
import { placeAtPoint, placeBeside } from '../src/menu/placement.ts';

const VIEW = { width: 1600, height: 1000 };

describe('placeAtPoint', () => {
	it('opens right and down from the point when it fits', () => {
		expect(placeAtPoint({ x: 100, y: 200 }, { width: 200, height: 300 }, VIEW)).toEqual({
			left: 100,
			top: 200,
			maxHeight: 992,
		});
	});
	it('flips up / left when the bottom / right edge has no room', () => {
		const p = placeAtPoint({ x: 1500, y: 900 }, { width: 200, height: 300 }, VIEW);
		expect(p.left).toBe(1300);
		expect(p.top).toBe(600);
	});
	it('pins to the bottom edge when neither side fits (a long Project panel menu at y = 600)', () => {
		const p = placeAtPoint({ x: 100, y: 600 }, { width: 200, height: 760 }, VIEW);
		expect(p.top).toBe(1000 - 4 - 760);
		expect(p.top + 760).toBeLessThanOrEqual(1000);
	});
	it('a menu taller than the window fills it and scrolls', () => {
		const p = placeAtPoint({ x: 100, y: 600 }, { width: 200, height: 1400 }, VIEW);
		expect(p).toEqual({ left: 100, top: 4, maxHeight: 992 });
	});
	it('a menu wider than the window starts at the left margin', () => {
		expect(placeAtPoint({ x: 50, y: 10 }, { width: 2000, height: 100 }, VIEW).left).toBe(4);
	});
});

describe('placeBeside', () => {
	const item = { left: 300, top: 500, right: 500, bottom: 522 };
	it('opens to the right of its item, aligned with it', () => {
		expect(placeBeside(item, { width: 180, height: 200 }, VIEW)).toMatchObject({ left: 500, top: 500 });
	});
	it('flips to the left of the item at the right edge', () => {
		const r = { left: 1400, top: 100, right: 1590, bottom: 122 };
		expect(placeBeside(r, { width: 180, height: 200 }, VIEW).left).toBe(1220);
	});
	it('slides up so its bottom stays in the window, and scrolls when taller than it', () => {
		expect(placeBeside(item, { width: 180, height: 700 }, VIEW).top).toBe(1000 - 4 - 700);
		expect(placeBeside(item, { width: 180, height: 1500 }, VIEW)).toMatchObject({ top: 4, maxHeight: 992 });
	});
});

describe('PointMenu', () => {
	let host: HTMLDivElement | null = null;
	afterEach(() => {
		host?.remove();
		document.body.innerHTML = '';
	});
	it('measures itself and moves inside the window before paint (in a portal on body)', async () => {
		Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1600 });
		Object.defineProperty(window, 'innerHeight', { configurable: true, value: 1000 });
		const sizes = Object.getOwnPropertyDescriptors(HTMLElement.prototype);
		Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 220 });
		Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => 760 });
		try {
			host = document.createElement('div');
			document.body.append(host);
			const root = createRoot(host);
			await act(async () => {
				root.render(
					<PointMenu x={1500} y={600} data-testid="m">
						<button type="button">Item</button>
					</PointMenu>,
				);
			});
			const el = document.querySelector<HTMLElement>('[data-testid="m"]')!;
			expect(el.parentElement).toBe(document.body);
			expect(el.getAttribute('role')).toBe('menu');
			expect(el.style.left).toBe('1280px');
			expect(el.style.top).toBe(`${1000 - 4 - 760}px`);
			expect(el.style.maxHeight).toBe('992px');
			await act(async () => root.unmount());
		} finally {
			for (const k of ['offsetWidth', 'scrollHeight'] as const) {
				const d = sizes[k];
				if (d) Object.defineProperty(HTMLElement.prototype, k, d);
				else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[k];
			}
		}
	});
});
