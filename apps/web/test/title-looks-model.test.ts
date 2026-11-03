// Spec 19 §10, the pure parts: the library, the virtual grid's window, posters on the client and on-canvas geometry.

import { createCounterIdSource, emptyAppearance, type FactoryLook, type Gradient } from '@jasper/project';
import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { stepColorway } from '../src/title-looks/actions.ts';
import { gridStep, gridWindow, scrollToCard } from '../src/title-looks/grid-window.ts';
import { filterLooks, lookCategories, lookEntries, recentLooks } from '../src/title-looks/library.ts';
import {
	direction,
	edgeAnchor,
	handlePoint,
	handleValues,
	lookFrame,
	outlineQuad,
	type Quad,
} from '../src/title-looks/overlay-geometry.ts';
import {
	addStop,
	convertPaint,
	flatPalette,
	paintCss,
	removeStop,
	stopAt,
} from '../src/title-looks/paint.ts';
import {
	type PosterState,
	PosterStore,
	posterRequest,
	posterWidth,
	usePoster,
} from '../src/title-looks/posters.ts';

const recipe = { layers: [{ type: 'face' }] };
const library = [
	{ libraryId: 'look.a', name: 'Gold Bar', category: 'Luxury', tags: ['metal'], recipe },
	{ libraryId: 'look.b', name: 'Neon Sign', category: 'Neon', tags: ['glow', 'night'], recipe },
] as unknown as FactoryLook[];
const colorways = [
	{ id: 'cw.red', name: 'Red', palette: { face: [1, 0, 0, 1] as [number, number, number, number] } },
];

describe('the library (TL-086)', () => {
	it('lists the library, then what only the project has; a project copy of a library look is that look', () => {
		const appearance = emptyAppearance();
		const ids = createCounterIdSource(1);
		const copy = ids.next('tlk');
		const own = ids.next('tlk');
		const doc = {
			titleLooks: {
				[copy]: { id: copy, name: 'Gold Bar', sourceId: 'look.a', appearance },
				[own]: { id: own, name: 'Mine', appearance },
			},
		} as never;
		const entries = lookEntries(doc, library, colorways);
		expect(entries.map((e) => [e.lookId, e.source])).toEqual([
			['look.a', 'library'],
			['look.b', 'library'],
			[own, 'project'],
		]);
		expect(entries[0]!.colorways.map((c) => c.id)).toEqual(['cw.red']);
	});

	it('searches names, categories and tags; every word must match', () => {
		const entries = lookEntries(null, library, colorways);
		const names = (q: string, category: string | null = null) =>
			filterLooks(entries, { query: q, category }).map((e) => e.name);
		expect(names('gold')).toEqual(['Gold Bar']);
		expect(names('night glow')).toEqual(['Neon Sign']);
		expect(names('gold night')).toEqual([]);
		expect(names('', 'Neon')).toEqual(['Neon Sign']);
		expect(names('')).toHaveLength(2);
	});

	it('keeps categories in library order, and recents in order of use without looks that are gone', () => {
		const entries = lookEntries(null, library, colorways);
		expect(lookCategories(entries)).toEqual(['Luxury', 'Neon']);
		expect(recentLooks(entries, ['look.b', 'gone', 'look.a']).map((e) => e.lookId)).toEqual([
			'look.b',
			'look.a',
		]);
	});

	it('shows suggested colourways first on the card when the library names them', () => {
		const withSuggested = [{ ...library[0], suggestedColorways: ['cw.red'] }] as unknown as FactoryLook[];
		const entries = lookEntries(null, withSuggested, [
			...colorways,
			{ id: 'cw.blue', name: 'Blue', palette: {} },
		]);
		expect(entries[0]!.cardColorways.map((c) => c.id)).toEqual(['cw.red']);
		expect(entries[0]!.colorways.map((c) => c.id)).toEqual(['cw.red', 'cw.blue']);
	});
});

describe('virtual grid (TL-086)', () => {
	const g = (over: Partial<Parameters<typeof gridWindow>[0]> = {}) =>
		gridWindow({
			width: 350,
			scrollTop: 0,
			viewport: 300,
			count: 1000,
			tile: 160,
			gap: 4,
			footer: 44,
			...over,
		});

	it('mounts only the rows on screen and one row beyond', () => {
		const w = g();
		expect(w.columns).toBe(2);
		expect(w.start).toBe(0);
		expect(w.end - w.start).toBeLessThan(12);
		expect(w.totalHeight).toBeGreaterThan(40_000);
	});

	it('follows the scroll', () => {
		const w = g({ scrollTop: 10_000 });
		expect(w.start).toBeGreaterThan(100);
		expect(w.end - w.start).toBeLessThanOrEqual(12);
		expect(w.top % (w.cellHeight + 4)).toBe(0);
	});

	it('stays in bounds at the end, with nothing, and at odd widths', () => {
		expect(g({ scrollTop: 1e9 }).end).toBe(1000);
		const none = g({ count: 0 });
		expect([none.start, none.end, none.totalHeight]).toEqual([0, 0, 0]);
		expect(g({ width: 0 }).columns).toBe(1);
		expect(g({ scrollTop: Number.NaN }).start).toBe(0);
	});

	it('moves by key within the grid', () => {
		expect(gridStep(5, 'ArrowRight', 3, 10)).toBe(6);
		expect(gridStep(5, 'ArrowLeft', 3, 10)).toBe(4);
		expect(gridStep(5, 'ArrowDown', 3, 10)).toBe(8);
		expect(gridStep(1, 'ArrowUp', 3, 10)).toBe(1);
		expect(gridStep(8, 'ArrowDown', 3, 10)).toBe(9);
		expect(gridStep(0, 'ArrowLeft', 3, 10)).toBe(0);
		expect(gridStep(4, 'Home', 3, 10)).toBe(0);
		expect(gridStep(4, 'End', 3, 10)).toBe(9);
	});

	it('scrolls a card into view only when it is out of view', () => {
		const w = { columns: 2, cellHeight: 100 };
		expect(scrollToCard(0, w, 4, 500, 300)).toBe(0);
		expect(scrollToCard(20, w, 4, 0, 300)).toBe(1040 + 100 - 300);
		expect(scrollToCard(2, w, 4, 0, 300)).toBe(0);
	});
});

describe('posters on the client (TL-087)', () => {
	const bytes = new Uint8Array([1]);
	const req = (text: string) => posterRequest(recipe as never, null, { text }, 240);

	function store(opts: { max?: number } = {}) {
		const pending: {
			req: unknown;
			signal: AbortSignal;
			resolve(b: Uint8Array): void;
			reject(e: Error): void;
		}[] = [];
		const revoked: string[] = [];
		let n = 0;
		const s = new PosterStore(
			(r, signal) => new Promise((resolve, reject) => pending.push({ req: r, signal, resolve, reject })),
			{
				maxPosters: opts.max ?? 10,
				createUrl: () => `blob:${++n}`,
				revokeUrl: (u) => revoked.push(u),
			},
		);
		return { s, pending, revoked };
	}
	const flush = () => new Promise((r) => setTimeout(r, 0));

	it('asks once per poster, and answers from memory afterwards', async () => {
		const { s, pending } = store();
		const a: PosterState[] = [];
		const b: PosterState[] = [];
		s.ask(req('x'), (v) => a.push(v));
		s.ask(req('x'), (v) => b.push(v));
		expect(pending).toHaveLength(1);
		pending[0]!.resolve(bytes);
		await flush();
		expect(a.at(-1)).toEqual({ state: 'ready', url: 'blob:1' });
		expect(b.at(-1)).toEqual({ state: 'ready', url: 'blob:1' });
		const c: PosterState[] = [];
		s.ask(req('x'), (v) => c.push(v));
		expect(c).toEqual([{ state: 'ready', url: 'blob:1' }]);
		expect(pending).toHaveLength(1);
	});

	it('stops the request when the last card leaves, not before', () => {
		const { s, pending } = store();
		const stopA = s.ask(req('x'), () => {});
		const stopB = s.ask(req('x'), () => {});
		stopA();
		expect(pending[0]!.signal.aborted).toBe(false);
		stopB();
		expect(pending[0]!.signal.aborted).toBe(true);
	});

	it('asks at most four at a time and starts the newest ask first', async () => {
		const { s, pending } = store();
		for (const t of ['a', 'b', 'c', 'd', 'e', 'f']) s.ask(req(t), () => {});
		expect(pending).toHaveLength(4);
		pending[0]!.resolve(bytes);
		await flush();
		expect(pending).toHaveLength(5);
		expect((pending[4]!.req as { text: string }).text).toBe('f');
	});

	it('reports a refusal to the card and a retry can ask again', async () => {
		const { s, pending } = store();
		const seen: PosterState[] = [];
		s.ask(req('x'), (v) => seen.push(v));
		pending[0]!.reject(new Error('Remotion is not ready'));
		await flush();
		expect(seen.at(-1)).toEqual({ state: 'error', message: 'Remotion is not ready' });
		s.ask(req('x'), () => {});
		expect(pending).toHaveLength(2);
	});

	it('keeps a bounded number of pictures: the least recently used goes', async () => {
		const { s, pending, revoked } = store({ max: 2 });
		for (const [i, t] of ['a', 'b', 'c'].entries()) {
			s.ask(req(t), () => {});
			pending[i]!.resolve(bytes);
			await flush();
			if (t === 'b') s.cached(req('a'));
		}
		expect(revoked).toEqual(['blob:2']);
	});

	it('a card waits a moment before asking: a fast scroll asks for nothing', async () => {
		vi.useFakeTimers();
		try {
			const { s, pending } = store();
			const { unmount } = renderHook(() => usePoster(s, req('x')));
			await act(async () => {
				vi.advanceTimersByTime(50);
			});
			unmount();
			await act(async () => {
				vi.advanceTimersByTime(500);
			});
			expect(pending).toHaveLength(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it('a card that stays asks, and leaving cancels it', async () => {
		vi.useFakeTimers();
		try {
			const { s, pending } = store();
			const { result, unmount } = renderHook(() => usePoster(s, req('x')));
			expect(result.current.state).toBe('loading');
			await act(async () => {
				vi.advanceTimersByTime(200);
			});
			expect(pending).toHaveLength(1);
			unmount();
			expect(pending[0]!.signal.aborted).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it('picks a poster size for the tile', () => {
		expect(posterWidth(120, 1)).toBe(240);
		expect(posterWidth(168, 2)).toBe(360);
		expect(posterWidth(240, 2)).toBe(540);
		expect(posterWidth(900, 3)).toBe(540);
	});

	it("uses the selection's words and the sample when there are none", () => {
		expect(posterRequest(recipe as never, null, { text: ' ' }, 240).text).toBe('Title');
		const r = posterRequest(
			recipe as never,
			{ palette: { face: [0, 0, 0, 1] } },
			{ text: 'Hi', font: { family: 'Inter' } },
			360,
		);
		expect(r).toMatchObject({
			text: 'Hi',
			font: { family: 'Inter' },
			width: 360,
			palette: { face: [0, 0, 0, 1] },
		});
	});
});

describe('colourway cycling', () => {
	const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
	it('wraps both ways, and starts at an end from no colourway', () => {
		expect(stepColorway(list, 'a', 1)?.id).toBe('b');
		expect(stepColorway(list, 'c', 1)?.id).toBe('a');
		expect(stepColorway(list, 'a', -1)?.id).toBe('c');
		expect(stepColorway(list, undefined, 1)?.id).toBe('a');
		expect(stepColorway(list, 'gone', -1)?.id).toBe('c');
		expect(stepColorway([], 'a', 1)).toBeNull();
	});
});

describe('paints (TL-091)', () => {
	const palette = flatPalette({
		palette: {
			face: { value: [1, 0, 0, 1], keyframes: [] },
			faceAlt: { value: [0, 0, 1, 1], keyframes: [] },
		},
	});
	const gradient: Gradient = {
		type: 'linear',
		span: 'block',
		angle: 0,
		stops: [
			{ at: 0, paint: { role: 'face' } },
			{ at: 1, paint: { role: 'faceAlt' } },
		],
	};

	it('converts between kinds, keeping what the new kind can keep', () => {
		expect(convertPaint({ kind: 'role', role: 'face' }, 'color', palette)).toEqual({
			kind: 'color',
			color: [1, 0, 0, 1],
		});
		const g = convertPaint({ kind: 'role', role: 'glow' }, 'gradient', palette);
		expect(g.kind === 'gradient' && g.gradient.stops[0]!.paint).toEqual({ role: 'glow' });
		expect(convertPaint({ kind: 'source' }, 'source', palette)).toEqual({ kind: 'source' });
		expect(convertPaint(g, 'color', palette)).toEqual({ kind: 'color', color: palette.glow });
	});

	it('a click on the ramp adds the colour already there', () => {
		const s = stopAt(gradient, 0.5, palette);
		expect(s.at).toBe(0.5);
		expect(s.paint).toEqual({ color: [0.5, 0, 0.5, 1] });
	});

	it('keeps at least two stops and at most 32', () => {
		expect(removeStop(gradient as never, 0).stops).toHaveLength(2);
		const full = {
			...gradient,
			stops: Array.from({ length: 32 }, (_, i) => ({ at: i / 31, paint: { role: 'face' } })),
		};
		expect(addStop(full as never, 0.5, palette).index).toBe(-1);
		const r = addStop(gradient as never, 0.25, palette);
		expect(r.gradient.stops).toHaveLength(3);
		expect(removeStop(r.gradient, 2).stops).toHaveLength(2);
	});

	it('draws swatches for every kind, and stops in order', () => {
		expect(paintCss({ kind: 'role', role: 'face' }, palette)).toContain('rgba(255, 0, 0, 1)');
		expect(paintCss({ kind: 'color', color: [0, 1, 0, 0.5] }, palette)).toContain('rgba(0, 255, 0, 0.5)');
		expect(paintCss({ kind: 'source' }, palette)).toContain('repeating-conic-gradient');
		expect(paintCss(null, palette)).toBe('transparent');
		const css = paintCss(
			{ kind: 'gradient', gradient: { ...gradient, stops: [...gradient.stops].reverse() } as never },
			palette,
		);
		expect(css.indexOf('255, 0, 0')).toBeLessThan(css.indexOf('0, 0, 255'));
	});
});

describe('on-canvas geometry (TL-092)', () => {
	const quad: Quad = [
		[100, 100],
		[300, 100],
		[300, 200],
		[100, 200],
	];
	const f = lookFrame(quad, { width: 400, height: 200 }, 100);

	it('reads the layer from its quad: 0.5 scale and a unit of 100 px is half a sequence px per percent', () => {
		expect(f.center).toEqual([200, 150]);
		expect(f.u).toEqual([1, 0]);
		expect(f.perPercent).toBeCloseTo(0.5, 6);
	});

	it('uses the shorter side when the look has no unit', () => {
		expect(lookFrame(quad, { width: 400, height: 200 }, null).perPercent).toBeCloseTo(1, 6);
	});

	it('survives an empty box', () => {
		const zero: Quad = [
			[5, 5],
			[5, 5],
			[5, 5],
			[5, 5],
		];
		const z = lookFrame(zero, { width: 0, height: 0 }, null);
		expect(Number.isFinite(z.center[0])).toBe(true);
		expect(z.u).toEqual([1, 0]);
		expect(
			Number.isFinite(handleValues(z, { kind: 'axis', param: 'p', dir: [1, 0], value: 0 }, [9, 9]).p!),
		).toBe(true);
	});

	it('grows the outline per side', () => {
		const q = outlineQuad(f, { left: 10, top: 0, right: 20, bottom: 0 });
		expect(q[0]).toEqual([95, 100]);
		expect(q[2]).toEqual([310, 200]);
	});

	it('a distance handle sits at the value and drags back to it, never below 0', () => {
		const { anchor, dir } = edgeAnchor(f, 0);
		const h = { kind: 'distance' as const, param: 'width', anchor, dir, start: 4, value: 6 };
		const p = handlePoint(f, h);
		expect(p).toEqual([305, 150]);
		expect(handleValues(f, h, p).width).toBeCloseTo(6, 6);
		expect(handleValues(f, h, [100, 150]).width).toBe(0);
	});

	it('a shadow handle sets angle and distance together', () => {
		const h = {
			kind: 'offset' as const,
			angleParam: 'angle',
			distanceParam: 'distance',
			angle: 90,
			distance: 40,
		};
		// From the box edge, 50 px below the centre: a small offset does not hide under the anchor.
		const p = handlePoint(f, h);
		expect(p[0]).toBeCloseTo(200, 6);
		expect(p[1]).toBeCloseTo(220, 6);
		const v = handleValues(f, h, [320, 150]);
		expect(v.angle).toBeCloseTo(0, 6);
		expect(v.distance).toBeCloseTo(40, 6);
		const back = handleValues(f, h, p);
		expect(back.angle).toBeCloseTo(90, 6);
		expect(back.distance).toBeCloseTo(40, 6);
	});

	it('an angle handle reports the param, not the angle on screen', () => {
		const h = { kind: 'angle' as const, param: 'paintAngle', base: 30, value: 15, radius: 40 };
		const p = handlePoint(f, h);
		expect(handleValues(f, h, p).paintAngle).toBeCloseTo(15, 1);
		expect(handleValues(f, h, [240, 150]).paintAngle).toBeCloseTo(-30, 6);
	});

	it('a position handle runs 0…100 % across the shape', () => {
		const h = {
			kind: 'position' as const,
			param: 'position',
			dir: [1, 0] as [number, number],
			extent: 100,
			value: 50,
		};
		expect(handlePoint(f, h)).toEqual([200, 150]);
		expect(handleValues(f, h, [300, 150]).position).toBeCloseTo(100, 6);
		expect(handleValues(f, h, [100, 150]).position).toBeCloseTo(0, 6);
	});

	it('handles turn with the clip', () => {
		const turned: Quad = [
			[200, 100],
			[200, 300],
			[100, 300],
			[100, 100],
		];
		const t = lookFrame(turned, { width: 400, height: 200 }, 100);
		const d = direction(t, 0);
		expect(d[0]).toBeCloseTo(0, 6);
		expect(d[1]).toBeCloseTo(1, 6);
	});
});
