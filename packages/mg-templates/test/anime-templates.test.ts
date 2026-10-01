// Anime template catalogue (S11:ATP-001/003/004/009): metadata, responsive time, the counter formatter and the
// registry's version upgrade path (FIX-005).
import { paramsPropertySpecs } from '@jasper/project';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
	ANIME_CATALOG,
	ANIME_REFERENCE_FPS,
	type AnyMgTemplate,
	animeFramesAt,
	animeTemplateTiming,
	CANVASES,
	createMgRegistry,
	formatCounterValue,
	isAnimeTemplate,
	type MgAnimeTemplateDefinition,
	mgRegistry,
	rgbaCss,
	upgradeParams,
} from '../src/index.ts';

describe('anime catalogue (S11:ATP-001/003)', () => {
	it('ships title-reveal, lower-third-anim, callout and counter as anime templates', () => {
		expect(ANIME_CATALOG.map((d) => `${d.id}@${d.version}`)).toEqual([
			'title-reveal@1',
			'lower-third-anim@1',
			'callout@1',
			'counter@1',
		]);
		for (const d of ANIME_CATALOG) {
			expect(isAnimeTemplate(d)).toBe(true);
			expect(d.renderVersion).toBeGreaterThanOrEqual(1);
			expect(d.canvases).toEqual([...CANVASES]);
			expect(d.description?.length).toBeGreaterThan(10);
			expect(d.posterAt).toBeGreaterThan(0);
			expect(d.posterAt).toBeLessThan(d.defaultDurationSeconds);
			// intro + outro fit in the default duration at the reference rate
			expect(d.introFrames + d.outroFrames).toBeLessThan(d.defaultDurationSeconds * ANIME_REFERENCE_FPS);
			expect(mgRegistry.get(d.id, d.version)).toMatchObject({ renderer: 'anime', name: d.name });
		}
	});

	it('params follow the conventions: strict, every field defaulted, RGBA 0..1, bounded strings', () => {
		for (const d of ANIME_CATALOG) {
			expect(d.paramsSchema.parse({})).toEqual(d.defaults);
			expect(d.paramsSchema.safeParse({ bogus: 1 }).success, d.id).toBe(false);
			const json = z.toJSONSchema(d.paramsSchema, { io: 'input' }) as {
				properties: Record<
					string,
					{ type?: string; maxLength?: number; minItems?: number; enum?: unknown[] }
				>;
			};
			for (const [name, s] of Object.entries(json.properties)) {
				if (s.type === 'string' && !s.enum) expect(s.maxLength, `${d.id}.${name}`).toBeGreaterThan(0);
				if (s.type === 'array') expect(s.minItems, `${d.id}.${name}`).toBe(4);
			}
			for (const [name, v] of Object.entries(d.defaults))
				if (Array.isArray(v)) {
					expect(
						v.every((c) => c >= 0 && c <= 1),
						`${d.id}.${name}`,
					).toBe(true);
					expect(d.paramsSchema.safeParse({ [name]: [2, 0, 0, 1] }).success).toBe(false);
				}
		}
	});

	it('numeric and colour params are keyframable; their schema accepts every value in range (S11:ATP-006)', () => {
		for (const d of ANIME_CATALOG) {
			const info = mgRegistry.get(d.id, d.version)!;
			const specs = paramsPropertySpecs(info);
			const animatable = specs.filter((s) => s.animatable !== 'no');
			expect(animatable.length, d.id).toBeGreaterThan(0);
			for (const s of specs) {
				const name = s.key.slice('params.'.length);
				const keyframable = s.kind === 'color' || (s.kind === 'number' && s.ui.precision !== 0);
				expect(s.animatable, s.key).toBe(keyframable ? 'continuous' : 'no');
				if (s.kind === 'number' && keyframable) {
					const { min, max } = s.range ?? {};
					expect(min, s.key).toBeDefined();
					expect(max, s.key).toBeDefined();
					for (const v of [min!, max!, (min! + max!) / 2, min! + (max! - min!) / 3])
						expect(d.paramsSchema.safeParse({ ...d.defaults, [name]: v }).success, s.key).toBe(true);
				}
				if (s.kind === 'color')
					expect(d.paramsSchema.safeParse({ ...d.defaults, [name]: [0, 0.5, 1, 0.25] }).success).toBe(true);
			}
		}
	});

	it('rgbaCss renders straight RGBA 0..1 as CSS', () => {
		expect(rgbaCss([1, 0.5, 0, 0.25])).toBe('rgba(255, 128, 0, 0.25)');
		expect(rgbaCss([2, -1, 0.5, 1])).toBe('rgba(255, 0, 128, 1)');
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
		expect(animeFramesAt(30, 60)).toBe(60);
		expect(animeFramesAt(15, 25)).toBe(13);
		expect(animeFramesAt(36, 30000 / 1001)).toBe(36);
		const t = animeTemplateTiming(def, { fps: 25, localFrame: 0, durationFrames: 250 });
		expect(t.introMs).toBe((25 * 1000) / 25);
		expect(Number.isInteger(t.introFrames) && Number.isInteger(t.outroFrames)).toBe(true);
	});
	it('compresses intro and outro proportionally when they exceed the content', () => {
		const t = animeTemplateTiming(def, { fps: 30, localFrame: 0, durationFrames: 30 });
		expect(t.introFrames + t.outroFrames).toBe(30);
		expect(t.introFrames).toBe(20);
		expect(animeTemplateTiming(def, { fps: 30, localFrame: 0, durationFrames: 1 }).totalFrames).toBe(1);
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
	it('handles negatives, -0 and non-finite values', () => {
		expect(formatCounterValue(-1500, base)).toBe('−1,500');
		expect(formatCounterValue(-0.2, base)).toBe('0');
		expect(formatCounterValue(Number.NaN, base)).toBe('0');
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
	it('stops at toVersion; null without a path, at the newest version, or when the target is not reached', () => {
		expect(reg.upgrade('t', 1, { text: 'Hi' }, 2)).toEqual({ version: 2, params: { title: 'Hi', size: 10 } });
		expect(reg.upgrade('t', 3, {})).toBeNull();
		expect(reg.upgrade('nope', 1, {})).toBeNull();
		expect(createMgRegistry([v1, v3]).upgrade('t', 1, {})).toBeNull();
		expect(reg.upgrade('t', 1, {}, 5)).toBeNull();
	});
	it('prefers a direct jump and refuses migrations that throw or produce invalid params', () => {
		const direct = mk(3, params3, [
			{ fromVersion: 2, migrate: (p) => p },
			{ fromVersion: 1, migrate: (p) => ({ title: `direct ${p.text}` }) },
		]);
		expect(upgradeParams([v1, v2, direct], 't', 1, { text: 'x' })?.params.title).toBe('direct x');
		const bad = mk(2, params2, [{ fromVersion: 1, migrate: () => ({ title: 3 }) }]);
		expect(upgradeParams([v1, bad], 't', 1, {})).toBeNull();
		const throws = mk(2, params2, [
			{
				fromVersion: 1,
				migrate: () => {
					throw new Error('x');
				},
			},
		]);
		expect(upgradeParams([v1, throws], 't', 1, {})).toBeNull();
	});
	it('the shipped catalogue has no pending upgrades (every template is at version 1)', () => {
		for (const d of mgRegistry.definitions())
			expect(mgRegistry.upgrade(d.id, d.version, d.defaults)).toBeNull();
	});
});
