// Spec 19 TL-102, TL-104, TL-106: what `title_check` measures, on pictures with known answers; recipe bounds on hostile
// input; recipes from stored appearances; the appearance targets of `clip.properties`.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	appearanceFromRecipe,
	contrastRatio,
	createRandomIdSource,
	defaultRegistries,
	type LookRecipe,
	matteAlpha,
	measureBackdropL,
	measureContrast,
	measureTitleFrame,
	RECIPE_BOUNDS,
	recipeBoundsProblem,
	recipeOfAppearance,
	relativeLuminance,
	runAgentQuery,
	summarizeTitleRows,
	TITLE_CHECK_THRESHOLDS,
	TITLE_NOT_CHECKED,
	TITLE_SAFE_MARGINS,
	type TitleCheckRow,
	type TitleFrameMeasure,
	type TitleImage,
	titleCheckFrames,
	titleReadSeconds,
	titleRenderedRows,
	titleTextRows,
	titleTiming,
} from '../src/index.ts';
import { Harness } from './helpers.ts';

type RGB = readonly [number, number, number];

function image(w: number, h: number, paint: (x: number, y: number) => RGB): TitleImage {
	const data = new Uint8Array(w * h * 4);
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) {
			const c = paint(x, y);
			data.set([c[0], c[1], c[2], 255], (y * w + x) * 4);
		}
	return { width: w, height: h, data };
}

const W = 200;
const H = 100;
const inBox = (x: number, y: number) => x >= 60 && x < 140 && y >= 40 && y < 60;

/** A flat box of `face` composited at `a` over the three backgrounds, the four renders of a frame. */
function renders(face: RGB, back: (x: number, y: number) => RGB, a = 1, box = inBox) {
	const over = (bg: RGB, x: number, y: number): RGB =>
		box(x, y) ? ([0, 1, 2].map((k) => Math.round(face[k]! * a + bg[k]! * (1 - a))) as unknown as RGB) : bg;
	return {
		with: image(W, H, (x, y) => over(back(x, y), x, y)),
		behind: image(W, H, back),
		black: image(W, H, (x, y) => over([0, 0, 0], x, y)),
		white: image(W, H, (x, y) => over([255, 255, 255], x, y)),
	};
}

const flat = (c: RGB) => () => c;

describe('colour', () => {
	it('gives the WCAG values', () => {
		expect(relativeLuminance(255, 255, 255)).toBeCloseTo(1, 6);
		expect(relativeLuminance(0, 0, 0)).toBe(0);
		expect(contrastRatio(1, 0)).toBeCloseTo(21, 6);
		// #767676 on white is the classic 4.54:1.
		expect(contrastRatio(relativeLuminance(0x76, 0x76, 0x76), 1)).toBeCloseTo(4.54, 1);
	});
});

describe('difference matting', () => {
	it('recovers alpha for any colour', () => {
		fc.assert(
			fc.property(
				fc.tuple(
					fc.integer({ min: 0, max: 255 }),
					fc.integer({ min: 0, max: 255 }),
					fc.integer({ min: 0, max: 255 }),
				),
				fc.integer({ min: 0, max: 255 }),
				(face, a255) => {
					const a = a255 / 255;
					const r = renders(face, flat([10, 20, 30]), a);
					const alpha = matteAlpha(r.black, r.white);
					expect(alpha[(50 * W + 100) | 0]!).toBeCloseTo(a, 1);
					expect(alpha[0]!).toBe(0);
				},
			),
		);
	});
});

describe('contrast against the rendered background', () => {
	const alphaOf = (r: ReturnType<typeof renders>) => matteAlpha(r.black, r.white);

	it('measures white on black and a title lost in its background', () => {
		const good = renders([255, 255, 255], flat([0, 0, 0]));
		expect(measureContrast(good.with, good.behind, alphaOf(good))).toMatchObject({
			ratio: 21,
			worst: 21,
			face: '#ffffff',
			background: '#000000',
		});
		const bad = renders([250, 250, 250], flat([240, 240, 240]));
		expect(measureContrast(bad.with, bad.behind, alphaOf(bad))!.ratio).toBeLessThan(1.2);
	});

	it('sees the part of a title that crosses a bright area, which an average would hide', () => {
		const half = (x: number): RGB => (x < 100 ? [0, 0, 0] : [250, 250, 250]);
		const r = renders([255, 255, 255], half);
		const c = measureContrast(r.with, r.behind, alphaOf(r))!;
		expect(c.ratio).toBeGreaterThan(1);
		expect(c.worst).toBeLessThan(1.2);
		expect(c.worstTile.x0).toBeGreaterThanOrEqual(100 - 8);
	});

	it('a dark rim keeps a white title readable on a white picture', () => {
		const rim = (x: number, y: number): RGB =>
			x >= 63 && x < 137 && y >= 43 && y < 57 ? [255, 255, 255] : [0, 0, 0];
		const r = {
			with: image(W, H, (x, y) => (inBox(x, y) ? rim(x, y) : [255, 255, 255])),
			behind: image(W, H, flat([255, 255, 255])),
			black: image(W, H, (x, y) => (inBox(x, y) ? rim(x, y) : [0, 0, 0])),
			white: image(W, H, (x, y) => (inBox(x, y) ? rim(x, y) : [255, 255, 255])),
		};
		expect(measureContrast(r.with, r.behind, matteAlpha(r.black, r.white))!.ratio).toBeGreaterThan(15);
		const bare = renders([255, 255, 255], flat([255, 255, 255]));
		expect(measureContrast(bare.with, bare.behind, alphaOf(bare))!.ratio).toBe(1);
	});

	it('credits letters on a plate to the title’s own contrast', () => {
		// stripes of black and white inside the box stand for letters on a plate; the picture is mid grey like both means
		const stripes = (x: number): RGB => (x % 8 < 4 ? [0, 0, 0] : [255, 255, 255]);
		const r = {
			with: image(W, H, (x, y) => (inBox(x, y) ? stripes(x) : [120, 120, 120])),
			behind: image(W, H, flat([120, 120, 120])),
			black: image(W, H, (x, y) => (inBox(x, y) ? stripes(x) : [0, 0, 0])),
			white: image(W, H, (x, y) => (inBox(x, y) ? stripes(x) : [255, 255, 255])),
		};
		const c = measureContrast(r.with, r.behind, matteAlpha(r.black, r.white))!;
		expect(c.carriedBy).toBe('own-contrast');
		expect(c.ratio).toBeGreaterThan(15);
	});

	it('leaves soft slivers out, and reports nothing when nothing is drawn', () => {
		const empty = renders([255, 255, 255], flat([0, 0, 0]), 0);
		expect(measureContrast(empty.with, empty.behind, alphaOf(empty))).toBeNull();
		expect(measureBackdropL(empty.behind, alphaOf(empty))).toBeNull();
	});

	it('never throws and stays in range on arbitrary pictures', () => {
		fc.assert(
			fc.property(
				fc.uint8Array({ minLength: 4 * 64 * 4, maxLength: 4 * 64 * 4 }),
				fc.integer(),
				(bytes, seed) => {
					const noise = (s: number): TitleImage => ({
						width: 16,
						height: 16,
						data: bytes.map((b, i) => (b + s * i) & 255),
					});
					const m = measureTitleFrame(
						3,
						{ with: noise(1), behind: noise(2), black: noise(seed), white: noise(5) },
						1920,
					);
					if (m.contrast) {
						expect(m.contrast.ratio).toBeGreaterThanOrEqual(1);
						expect(m.contrast.ratio).toBeLessThanOrEqual(21);
					}
					if (m.backdropL !== null) expect(Number.isFinite(m.backdropL)).toBe(true);
				},
			),
		);
	});
});

describe('one frame', () => {
	it('scales bounds to sequence px and measures the picture just outside the title', () => {
		const r = renders([255, 255, 255], flat([0, 0, 0]));
		const m = measureTitleFrame(7, r, 1920);
		const k = 1920 / W;
		expect(m.frame).toBe(7);
		expect(m.ink).toEqual({ x0: 60 * k, y0: 40 * k, x1: 140 * k, y1: 60 * k });
		expect(m.backdropL).toBeCloseTo(0, 1);
		const light = measureTitleFrame(7, renders([0, 0, 0], flat([255, 255, 255])), 1920);
		expect(light.backdropL).toBeCloseTo(100, 0);
	});

	it('refuses renders of different sizes', () => {
		const r = renders([255, 255, 255], flat([0, 0, 0]));
		expect(() => measureTitleFrame(1, { ...r, white: image(4, 4, flat([255, 255, 255])) }, 1920)).toThrow(
			/differ in size/,
		);
	});
});

const SIZE = { width: 1920, height: 1080 };
const at = (frame: number) => ({ frame, sec: frame / 30, timecode: String(frame) });
const contrast = (ratio: number, worst = ratio) => ({
	ratio,
	worst,
	carriedBy: 'face' as const,
	face: '#ffffff',
	background: '#102030',
	tiles: 10,
	worstTile: { x0: 700, y0: 500, x1: 748, y1: 548 },
});
const frame = (o: Partial<TitleFrameMeasure> = {}): TitleFrameMeasure => ({
	frame: 10,
	ink: { x0: 600, y0: 400, x1: 1300, y1: 600 },
	faint: { x0: 560, y0: 380, x1: 1340, y1: 640 },
	contrast: contrast(8),
	backdropL: 20,
	...o,
});
const rowsOf = (frames: TitleFrameMeasure[], o: Partial<Parameters<typeof titleRenderedRows>[0]> = {}) =>
	titleRenderedRows({ frames, size: SIZE, sizePx: 120, atOf: at, ...o });
const row = (rows: TitleCheckRow[], id: string) => rows.find((r) => r.id === id)!;

describe('rendered rows', () => {
	it('passes a centred, readable title', () => {
		const rows = rowsOf([frame()]);
		expect(rows.map((r) => [r.id, r.status])).toEqual([
			['safe-area', 'pass'],
			['off-frame', 'pass'],
			['contrast', 'pass'],
		]);
		expect(summarizeTitleRows(rows)).toMatchObject({ verified: true, counts: { pass: 3 } });
	});

	it('safe-area: warns past title safe, fails past action safe, names the worst frame, and fixes by moving', () => {
		const title = frame({ frame: 20, ink: { x0: 150, y0: 400, x1: 900, y1: 600 } });
		const rows = rowsOf([frame(), title], { moveFix: (dx, dy, k) => [{ dx, dy, k }] });
		const safe = row(rows, 'safe-area');
		expect(safe).toMatchObject({ status: 'warn', at: { frame: 20 } });
		expect(safe.fix?.commands).toEqual([{ dx: 192 - 150, dy: 0, k: 1 }]);
		const action = row(rowsOf([frame({ ink: { x0: 50, y0: 400, x1: 900, y1: 600 } })]), 'safe-area');
		expect(action.status).toBe('fail');
		expect(action.message).toContain('action-safe');
		expect(TITLE_SAFE_MARGINS).toEqual({ action: 5, title: 10 });
	});

	it('safe-area: a title wider than the safe area is scaled to fit', () => {
		const rows = rowsOf([frame({ ink: { x0: 20, y0: 400, x1: 1900, y1: 600 } })], {
			moveFix: (dx, dy, k) => [{ dx, dy, k }],
		});
		const [fix] = row(rows, 'safe-area').fix!.commands as { k: number }[];
		expect(fix!.k).toBeCloseTo((1920 * 0.8) / 1880, 5);
		expect(row(rows, 'safe-area').fix!.label).toMatch(/Scale/);
	});

	it('safe-area: a title the frame cuts is centred from its anchor, because its bounds understate it', () => {
		// anchored at x 60: half of a wide title is past the left edge, so the frame shows x 0…700 of it
		const rows = rowsOf([frame({ ink: { x0: 0, y0: 400, x1: 700, y1: 600 } })], {
			position: [60, 500],
			moveFix: (dx, dy, k) => [{ dx, dy, k }],
		});
		expect(row(rows, 'safe-area').fix?.commands).toEqual([{ dx: 960 - 60, dy: 0, k: 1 }]);
		// no anchor to go on: the shift by what it can see
		const blind = rowsOf([frame({ ink: { x0: 0, y0: 400, x1: 700, y1: 600 } })], {
			moveFix: (dx, dy, k) => [{ dx, dy, k }],
		});
		expect(row(blind, 'safe-area').fix?.commands).toEqual([{ dx: 192, dy: 0, k: 1 }]);
	});

	it('off-frame: ink on the edge fails, a glow on the edge warns', () => {
		const ink = rowsOf([frame({ ink: { x0: 0, y0: 400, x1: 900, y1: 600 } })]);
		expect(row(ink, 'off-frame')).toMatchObject({ status: 'fail', measured: { inkTouches: ['left'] } });
		const glow = rowsOf([frame({ faint: { x0: 500, y0: 300, x1: 1920, y1: 1080 } })]);
		expect(row(glow, 'off-frame')).toMatchObject({
			status: 'warn',
			measured: { faintTouches: ['right', 'bottom'] },
		});
	});

	it('contrast: 3:1 for large text, 4.5:1 for small, the worst tenth warns, and a rim is offered', () => {
		expect(row(rowsOf([frame({ contrast: contrast(3.5) })]), 'contrast').status).toBe('pass');
		const small = row(rowsOf([frame({ contrast: contrast(3.5) })], { sizePx: 20 }), 'contrast');
		expect(small).toMatchObject({ status: 'fail', expected: { minRatio: 4.5 } });
		expect(row(rowsOf([frame({ contrast: contrast(6, 2) })]), 'contrast').status).toBe('warn');
		const fail = row(
			rowsOf([frame({ contrast: contrast(1.4) })], { rimFix: (color) => [{ color }] }),
			'contrast',
		);
		expect(fail.status).toBe('fail');
		expect(fail.fix?.commands).toEqual([{ color: [1, 1, 1, 1] }]);
		// without commands it still says what to do
		expect(row(rowsOf([frame({ contrast: contrast(1.4) })]), 'contrast').fix?.commands).toBeUndefined();
		// the worst frame decides
		const two = row(
			rowsOf([frame({ frame: 1, contrast: contrast(9) }), frame({ frame: 2, contrast: contrast(1.2) })]),
			'contrast',
		);
		expect(two).toMatchObject({ status: 'fail', at: { frame: 2 } });
	});

	it('a title too small to measure is unverified, and blocks verified', () => {
		const rows = rowsOf([frame({ contrast: null })]);
		expect(row(rows, 'contrast').status).toBe('unverified');
		expect(summarizeTitleRows(rows).verified).toBe(false);
	});

	it('says plainly when nothing is drawn', () => {
		const rows = rowsOf([frame({ ink: null, faint: null, contrast: null })]);
		expect(rows.map((r) => r.status)).toEqual(['fail', 'fail', 'fail']);
		expect(rows[0]!.message).toMatch(/Nothing of the title/);
	});

	it('target adds an estimate that only warns', () => {
		const low = frame({ ink: { x0: 600, y0: 1500, x1: 1000, y1: 1700 } });
		const rows = titleRenderedRows({
			frames: [low],
			size: { width: 1080, height: 1920 },
			sizePx: 120,
			target: 'tiktok',
			atOf: at,
		});
		expect(row(rows, 'target-safe-area')).toMatchObject({ status: 'warn', kind: 'judgement' });
		expect(row(rows, 'target-safe-area').message).toContain('estimate');
		expect(row(rowsOf([frame()], { target: 'youtube' }), 'target-safe-area')).toBeUndefined();
	});
});

describe('text rows', () => {
	function title(commands: unknown[] = []) {
		const h = new Harness();
		const r = h.tx([
			{
				type: 'clip.addText',
				at: 30,
				duration: 60,
				track: 'V2',
				content: { text: 'A title of some length', style: { sizePx: 20 } },
				textAnimation: {
					in: { preset: 'fade', durationFrames: 10 },
					out: { preset: 'fade', durationFrames: 10 },
				},
				ref: '$t',
			},
			...commands,
		]);
		const id = (r as { refs: Record<string, string> }).refs.$t!;
		return { h, clip: h.seq.clips[id]! as never as Parameters<typeof titleTextRows>[0]['clip'], id };
	}
	const rate = { num: 30, den: 1 };

	it('finds when the title is at rest', () => {
		const { clip } = title();
		const t = titleTiming(clip as never);
		expect(t).toMatchObject({
			inFrames: 10,
			outFrames: 10,
			intro: 35,
			holdStart: 40,
			holdEnd: 79,
			outro: 84,
		});
		expect(titleCheckFrames(t)).toEqual([40, 59, 79]);
		// no animation: the whole clip, without repeats on a one-frame clip
		expect(titleCheckFrames(titleTiming({ start: 5, duration: 1 }))).toEqual([5]);
	});

	it('reads at 15 characters a second, slower for CJK, never under the floor', () => {
		expect(titleReadSeconds('Hi')).toBe(TITLE_CHECK_THRESHOLDS.minReadSec);
		expect(titleReadSeconds('a'.repeat(45))).toBeCloseTo(3, 5);
		expect(titleReadSeconds('a '.repeat(45))).toBeCloseTo(3, 5);
		expect(titleReadSeconds('字'.repeat(45))).toBeCloseTo(5, 5);
	});

	it('flags a small, short title with fixes that really apply', () => {
		const { h, clip, id } = title();
		const rows = titleTextRows({
			clip,
			timing: titleTiming(clip as never),
			size: SIZE,
			rate,
			atOf: at,
			fixes: true,
		});
		const size = row(rows, 'min-size');
		expect(size).toMatchObject({ status: 'fail', measured: { sizePx: 20 }, expected: { minSizePx: 36 } });
		const read = row(rows, 'read-time');
		expect(read.status).toBe('pass');
		h.tx(size.fix!.commands!);
		const after = h.seq.clips[id] as never as { content: { style: { sizePx: number } } };
		expect(after.content.style.sizePx).toBe(36);
	});

	it('read-time fix lengthens the clip; a proposal gets the label only', () => {
		const h = new Harness();
		const r = h.tx([
			{
				type: 'clip.addText',
				at: 0,
				duration: 20,
				track: 'V2',
				content: { text: 'A title that takes a while', style: { sizePx: 80 } },
				ref: '$t',
			},
		]);
		const id = (r as { refs: Record<string, string> }).refs.$t!;
		const clip = h.seq.clips[id] as never as Parameters<typeof titleTextRows>[0]['clip'];
		const opts = { clip, timing: titleTiming(clip as never), size: SIZE, rate, atOf: at };
		const read = row(titleTextRows({ ...opts, fixes: true }), 'read-time');
		expect(read).toMatchObject({ status: 'warn', kind: 'judgement' });
		h.tx(read.fix!.commands!);
		expect(h.seq.clips[id]!.duration).toBeGreaterThanOrEqual(45);
		expect(row(titleTextRows({ ...opts, fixes: false }), 'read-time').fix?.commands).toBeUndefined();
	});

	it('safe-area and rim fixes are real commands', () => {
		const { h, id } = title([
			{
				type: 'look.apply',
				clipIds: ['$t'],
				look: { name: 'L', recipe: { layers: [{ type: 'face' }] } },
				seed: 1,
			},
		]);
		const fx = (h.seq.clips[id] as never as { effects: { id: string }[] }).effects[0]!.id;
		h.tx([
			{ type: 'param.set', target: ['clip', id, 'transform', 'position'], value: [100, 200] },
			{ type: 'param.set', target: ['clip', id, 'transform', 'scale'], value: 80 },
			{
				type: 'appearance.addLayer',
				effectInstanceId: fx,
				layerType: 'rim',
				index: 0,
				name: 'Contrast rim',
				params: { width: 6, paint: { kind: 'color', color: [1, 1, 1, 1] } },
			},
		]);
		const a = (h.seq.clips[id] as never as { effects: { appearance: { layers: { type: string }[] } }[] })
			.effects[0]!.appearance;
		expect(a.layers.map((l) => l.type)).toEqual(['rim', 'face']);
	});
});

describe('verified', () => {
	const r = (status: TitleCheckRow['status'], kind: TitleCheckRow['kind'] = 'format'): TitleCheckRow => ({
		id: 'x',
		kind,
		status,
		measured: null,
		expected: null,
		at: null,
		message: '',
	});
	it('means no fail row and no unverified format row', () => {
		expect(summarizeTitleRows([r('pass'), r('warn')]).verified).toBe(true);
		expect(summarizeTitleRows([r('fail', 'judgement')]).verified).toBe(false);
		expect(summarizeTitleRows([r('unverified')]).verified).toBe(false);
		expect(summarizeTitleRows([r('unverified', 'judgement')]).verified).toBe(true);
		expect(TITLE_NOT_CHECKED.join(' ')).toMatch(/Taste/);
	});
});

describe('recipe bounds (TL-106)', () => {
	const layer = (type = 'face') => ({ type });
	it('accepts a real recipe and refuses what is not an object', () => {
		expect(recipeBoundsProblem({ layers: [layer(), layer('rim')] })).toBeNull();
		for (const bad of [null, 3, 'x', [1]]) expect(recipeBoundsProblem(bad)?.cap).toBe('shape');
	});

	it('caps layers, instances of a type and generators', () => {
		const many = (n: number, type = 'rim') => ({ layers: Array.from({ length: n }, () => layer(type)) });
		expect(recipeBoundsProblem(many(RECIPE_BOUNDS.layers + 1))?.cap).toBe('layers');
		expect(recipeBoundsProblem(many(RECIPE_BOUNDS.maxTypeInstances))).toBeNull();
		expect(recipeBoundsProblem(many(RECIPE_BOUNDS.maxTypeInstances + 1))?.cap).toBe('instances');
		const generators = {
			layers: Array.from({ length: RECIPE_BOUNDS.maxGeneratorInstances + 1 }, (_, i) =>
				layer(`generator:g${i}`),
			),
		};
		expect(recipeBoundsProblem(generators)?.cap).toBe('instances');
	});

	it('caps bytes, values and depth, deep and cyclic input included, without recursion', () => {
		expect(recipeBoundsProblem({ layers: [], name: 'x'.repeat(RECIPE_BOUNDS.maxBytes + 1) })?.cap).toBe(
			'bytes',
		);
		expect(recipeBoundsProblem({ layers: new Array(RECIPE_BOUNDS.maxNodes + 1).fill(0) })?.cap).toBe('nodes');
		let deep: unknown = {};
		for (let i = 0; i < 200_000; i++) deep = { deep };
		expect(recipeBoundsProblem(deep)?.cap).toBe('depth');
		const cycle: { self?: unknown } = {};
		cycle.self = cycle;
		expect(recipeBoundsProblem(cycle)?.cap).toBe('depth');
	});

	it('the deepest legitimate recipe passes', () => {
		const recipe = {
			layers: [
				{
					type: 'face',
					params: {
						paint: {
							kind: 'gradient',
							gradient: {
								type: 'linear',
								span: 'block',
								angle: 0,
								stops: [
									{ at: 0, paint: { color: [1, 0, 0, 1] } },
									{ at: 1, paint: { color: [0, 0, 1, 1] } },
								],
							},
						},
					},
				},
			],
		};
		expect(recipeBoundsProblem(recipe)).toBeNull();
	});

	it('never throws on arbitrary JSON', () => {
		fc.assert(
			fc.property(fc.jsonValue(), (v) => {
				const p = recipeBoundsProblem(v);
				expect(p === null || typeof p.message === 'string').toBe(true);
			}),
		);
		fc.assert(
			fc.property(
				fc.record({
					layers: fc.array(fc.record({ type: fc.string(), params: fc.jsonValue() }), { maxLength: 40 }),
				}),
				(v) => {
					const p = recipeBoundsProblem(v);
					if (p === null) expect(v.layers.length).toBeLessThanOrEqual(RECIPE_BOUNDS.layers);
				},
			),
		);
	});
});

describe('recipes from stored looks (TL-104)', () => {
	const recipe: LookRecipe = {
		palette: { face: [1, 0, 0, 1] },
		light: { source: 'sequence', angle: 10, altitude: 20 },
		layers: [
			{ type: 'shadow', name: 'Drop', params: { distance: 8 } },
			{ type: 'rim', enabled: false, params: { width: 5 } },
			{ type: 'face' },
		],
		font: { family: 'Inter' },
	};

	it('round-trips through an appearance', () => {
		const ids = createRandomIdSource();
		const a = appearanceFromRecipe(recipe, () => ids.next('apl'));
		const back = recipeOfAppearance(a);
		expect(back.palette).toEqual(recipe.palette);
		expect(back.light).toEqual(recipe.light);
		expect(back.font).toEqual(recipe.font);
		expect(back.layers.map((l) => [l.type, l.name, l.enabled])).toEqual([
			['shadow', 'Drop', true],
			['rim', undefined, false],
			['face', undefined, true],
		]);
		expect(back.layers[0]!.params!.distance).toBe(8);
		const again = appearanceFromRecipe(back, () => ids.next('apl'));
		expect(again.layers.map((l) => Object.keys(l.params).sort())).toEqual(
			a.layers.map((l) => Object.keys(l.params).sort()),
		);
	});
});

describe('appearance targets of clip.properties (TL-104)', () => {
	it('lists palette, light and layer params with param.set targets that work', () => {
		const h = new Harness();
		const r = h.tx([
			{ type: 'clip.addText', at: 0, duration: 30, track: 'V2', content: { text: 'T' }, ref: '$t' },
			{
				type: 'look.apply',
				clipIds: ['$t'],
				look: {
					name: 'L',
					recipe: { palette: { face: [1, 0, 0, 1] }, layers: [{ type: 'rim', params: { width: 7 } }] },
				},
				seed: 1,
			},
		]);
		const clipId = (r as { refs: Record<string, string> }).refs.$t!;
		const q = () =>
			runAgentQuery(
				{ doc: h.doc, revision: h.revision, effects: defaultRegistries().effects },
				'clip.properties',
				{ clipId, keys: ['appearance'] },
			) as { properties: { key: string; target: string[]; value: unknown; evaluated: unknown }[] };
		const props = q().properties;
		const width = props.find((p) => p.key.endsWith('.width'))!;
		expect(width).toMatchObject({ value: 7, evaluated: 7 });
		expect(width.target[0]).toBe('appearance');
		expect(props.find((p) => p.key.endsWith('.palette.face'))!.value).toEqual([1, 0, 0, 1]);
		expect(props.some((p) => p.key.endsWith('.light.angle'))).toBe(true);
		h.tx([{ type: 'param.set', target: width.target, value: 11 }]);
		expect(q().properties.find((p) => p.key === width.key)!.value).toBe(11);
	});
});
