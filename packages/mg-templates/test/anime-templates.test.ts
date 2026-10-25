import { paramsPropertySpecs } from '@jasper/project';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
	ANIME_CATALOG,
	type AnyMgTemplate,
	animeTemplateTiming,
	createMgRegistry,
	formatCounterValue,
	type MgAnimeTemplateDefinition,
	mgRegistry,
} from '../src/index.ts';

describe('shipped anime parameters (ATP-003/006)', () => {
	it('rejects unknown fields, invalid RGBA channels and oversized text', () => {
		for (const d of ANIME_CATALOG) {
			expect(d.paramsSchema.safeParse({}).success, d.id).toBe(true);
			expect(d.paramsSchema.safeParse({ bogus: 1 }).success, d.id).toBe(false);
			const colours = Object.keys(d.defaults).filter((key) => key.endsWith('Color'));
			// social-comment draws the platform's own colours, chosen by its `theme` (no free colour params)
			if (d.id === 'social-comment') expect(d.paramsSchema.safeParse({ theme: 'sepia' }).success).toBe(false);
			else expect(colours.length, d.id).toBeGreaterThan(0);
			for (const name of colours) {
				expect(d.paramsSchema.safeParse({ [name]: [0, 0.5, 1, 0.25] }).success, `${d.id}.${name}`).toBe(true);
				expect(d.paramsSchema.safeParse({ [name]: [2, 0, 0, 1] }).success, `${d.id}.${name}`).toBe(false);
			}
		}
		const title = mgRegistry.getDefinition('title-reveal', 1)!.paramsSchema;
		expect(title.safeParse({ title: 'Hello' }).success).toBe(true);
		expect(title.safeParse({ title: 'x'.repeat(1000) }).success).toBe(false);
	});

	it('exposes actual number and colour controls as keyframable', () => {
		const specs = paramsPropertySpecs(mgRegistry.get('counter', 1)!);
		const byKey = new Map(specs.map((s) => [s.key, s.animatable]));
		expect(byKey.get('params.from')).toBe('continuous');
		expect(byKey.get('params.numberColor')).toBe('continuous');
		expect(byKey.get('params.decimals')).toBe('no');
		expect(byKey.get('params.label')).toBe('no');
	});
});

describe('responsive time (S11:ATP-004)', () => {
	const def = { introFrames: 30, outroFrames: 15 };
	it('anchors the intro at content 0 and the outro at the content end; the hold stretches', () => {
		const short = animeTemplateTiming(def, { fps: 30, localFrame: 10, durationFrames: 90 });
		const long = animeTemplateTiming(def, { fps: 30, localFrame: 10, durationFrames: 900 });
		expect(short).toMatchObject({
			introFrames: 30,
			outroFrames: 15,
			timeMs: (10 * 1000) / 30,
			totalMs: 3000,
		});
		expect(long).toMatchObject({ introFrames: 30, outroFrames: 15, timeMs: short.timeMs, totalMs: 30_000 });
		// the k-th frame before the end is the same outro position whatever the length
		for (const k of [1, 5, 15]) {
			const a = animeTemplateTiming(def, { fps: 30, localFrame: 90 - k, durationFrames: 90 });
			const b = animeTemplateTiming(def, { fps: 30, localFrame: 900 - k, durationFrames: 900 });
			expect(a.totalMs - a.timeMs).toBeCloseTo(b.totalMs - b.timeMs, 9);
		}
	});
	it('sourceIn shifts content time; the outro stays anchored at sourceIn + duration', () => {
		const t = animeTemplateTiming(def, { fps: 30, localFrame: 0, durationFrames: 60, sourceInFrames: 12 });
		expect(t).toMatchObject({ contentFrame: 12, totalFrames: 72, timeMs: 400, totalMs: 2400 });
	});
	it('converts reference frames to whole frames at other rates (frame-exact)', () => {
		for (const [introFrames, fps, expected] of [
			[15, 25, 13],
			[36, 30000 / 1001, 36],
		] as const) {
			expect(
				animeTemplateTiming({ introFrames, outroFrames: 0 }, { fps, localFrame: 0, durationFrames: 100 })
					.introFrames,
			).toBe(expected);
		}
	});
	it('compresses intro and outro proportionally when they exceed the content', () => {
		const t = animeTemplateTiming(def, { fps: 30, localFrame: 0, durationFrames: 30 });
		expect(t.introFrames + t.outroFrames).toBe(30);
		expect(t.introFrames).toBe(20);
	});
});

describe('counter formatting (S11:ATP-003)', () => {
	const base = {
		decimals: 0,
		thousandsSeparator: 'comma',
		decimalSeparator: 'period',
		prefix: '',
		suffix: '',
	} as const;
	it('groups thousands, rounds to the decimals, adds prefix and suffix', () => {
		expect(formatCounterValue(1234567.891, base)).toBe('1,234,568');
		expect(formatCounterValue(1234567.891, { ...base, decimals: 2 })).toBe('1,234,567.89');
		expect(
			formatCounterValue(1234.5, {
				...base,
				decimals: 1,
				thousandsSeparator: 'period',
				decimalSeparator: 'comma',
			}),
		).toBe('1.234,5');
		expect(formatCounterValue(999, { ...base, prefix: '$', suffix: ' M' })).toBe('$999 M');
		expect(formatCounterValue(1000, { ...base, thousandsSeparator: 'none' })).toBe('1000');
		expect(formatCounterValue(1000, { ...base, thousandsSeparator: 'thin' })).toBe('1 000');
	});
	it('uses a minus sign for negatives and rounds half away from zero without negative zero', () => {
		expect(formatCounterValue(-1500, base)).toBe('−1,500');
		expect(formatCounterValue(-0.2, base)).toBe('0');
		expect(formatCounterValue(2.5, base)).toBe('3');
		expect(formatCounterValue(-2.5, base)).toBe('−3');
	});
});

describe('template version upgrades (S11:ATP-009, FIX-005)', () => {
	const params1 = z.strictObject({ text: z.string().default('a') });
	const params2 = z.strictObject({ title: z.string().default('a'), size: z.number().default(10) });
	const params3 = z.strictObject({
		title: z.string().default('a'),
		size: z.number().default(10),
		bold: z.boolean().default(false),
	});
	const mk = (version: number, schema: z.ZodType, upgrades?: AnyMgTemplate['upgrades']) =>
		({
			id: 't',
			version,
			name: `T${version}`,
			category: 'Titles',
			renderer: 'anime',
			renderVersion: 1,
			paramsSchema: schema,
			defaults: schema.parse({}),
			introFrames: 10,
			outroFrames: 10,
			defaultDurationSeconds: 3,
			canvases: [{ width: 1920, height: 1080 }],
			...(upgrades ? { upgrades } : {}),
		}) as MgAnimeTemplateDefinition;
	const v1 = mk(1, params1);
	const v2 = mk(2, params2, [{ fromVersion: 1, migrate: (p) => ({ title: p.text }) }]);
	const v3 = mk(3, params3, [{ fromVersion: 2, migrate: (p) => ({ ...p, bold: (p.size as number) > 20 }) }]);
	const reg = createMgRegistry([v1, v2, v3]);

	it('walks the steps to the newest version, validating and defaulting each result', () => {
		expect(reg.upgrade('t', 1, { text: 'Hi' })).toEqual({
			version: 3,
			params: { title: 'Hi', size: 10, bold: false },
		});
		expect(reg.upgrade('t', 2, { title: 'Hi', size: 40 })).toEqual({
			version: 3,
			params: { title: 'Hi', size: 40, bold: true },
		});
	});
	it('stops at the requested version and refuses unreachable targets', () => {
		expect(reg.upgrade('t', 1, { text: 'Hi' }, 2)).toEqual({ version: 2, params: { title: 'Hi', size: 10 } });
		expect(reg.upgrade('t', 3, {})).toBeNull();
		expect(createMgRegistry([v1, v3]).upgrade('t', 1, {})).toBeNull();
		expect(reg.upgrade('t', 1, {}, 5)).toBeNull();
	});
	it('prefers a valid direct jump and refuses invalid migration results', () => {
		const direct = mk(3, params3, [
			{ fromVersion: 2, migrate: (p) => p },
			{ fromVersion: 1, migrate: (p) => ({ title: `direct ${p.text}` }) },
		]);
		expect(createMgRegistry([v1, v2, direct]).upgrade('t', 1, { text: 'x' })?.params.title).toBe('direct x');
		const bad = mk(2, params2, [{ fromVersion: 1, migrate: () => ({ title: 3 }) }]);
		expect(createMgRegistry([v1, bad]).upgrade('t', 1, {})).toBeNull();
	});
	it('backtracks from a larger dead-end jump to the highest reachable version', () => {
		const params4 = params3.extend({ italic: z.boolean().default(false) });
		const via2 = mk(2, params2, [{ fromVersion: 1, migrate: (p) => ({ title: `via2 ${p.text}` }) }]);
		const deadEnd = mk(3, params3, [{ fromVersion: 1, migrate: (p) => ({ title: p.text }) }]);
		const v4from2 = mk(4, params4, [{ fromVersion: 2, migrate: (p) => ({ ...p, italic: true }) }]);
		expect(createMgRegistry([v1, via2, deadEnd, v4from2]).upgrade('t', 1, { text: 'x' })).toEqual({
			version: 4,
			params: { title: 'via2 x', size: 10, bold: false, italic: true },
		});
	});
	it('tries another path when a direct migration throws', () => {
		const via2 = mk(2, params2, [{ fromVersion: 1, migrate: (p) => ({ title: p.text }) }]);
		const twoStep = mk(3, params3, [
			{
				fromVersion: 1,
				migrate: () => {
					throw new Error('broken');
				},
			},
			{ fromVersion: 2, migrate: (p) => ({ ...p, bold: true }) },
		]);
		expect(createMgRegistry([v1, via2, twoStep]).upgrade('t', 1, { text: 'x' }, 3)).toEqual({
			version: 3,
			params: { title: 'x', size: 10, bold: true },
		});
	});
});
