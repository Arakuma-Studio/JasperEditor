import {
	applyTransaction,
	createEmptyProject,
	createSeededIdSource,
	defaultRegistries,
} from '@jasper/project';
import { describe, expect, it } from 'vitest';
import {
	canonicalJson,
	easeInOutCubic,
	easeOutCubic,
	escapeXml,
	estimateTextWidth,
	fitCanvas,
	lowerThird,
	MG_CATALOG,
	mgRegistry,
	mgRenderKeyMaterial,
	num,
	specFromClip,
	spring,
	titleCard,
} from '../src/index.ts';

const HD = { width: 1920, height: 1080 };

describe('core math (mirrors jasper-mg-core)', () => {
	it('formats numbers like the Rust `num`', () => {
		expect(num(0)).toBe('0');
		expect(num(-0.0001)).toBe('0');
		expect(num(1)).toBe('1');
		expect(num(12.3456)).toBe('12.346');
		expect(num(-2.5)).toBe('-2.5');
		expect(num(0.1 + 0.2)).toBe('0.3');
		expect(num(1920)).toBe('1920');
		expect(num(-0.0005)).toBe('0');
		expect(num(Number.NaN)).toBe('0');
	});
	it('fits design canvases like the Rust `fit_canvas`', () => {
		expect(fitCanvas(1920, 1080)).toMatchObject({ designW: 1920, scale: 1, offsetX: 0, offsetY: 0 });
		const hd720 = fitCanvas(1280, 720);
		expect(hd720.designW).toBe(1920);
		expect(hd720.scale).toBeCloseTo(2 / 3, 12);
		expect(fitCanvas(1200, 1080)).toMatchObject({ designW: 1080, designH: 1080, offsetX: 60 });
		expect(fitCanvas(1440, 1080)).toMatchObject({ designW: 1920, scale: 0.75, offsetY: 135 });
		expect(fitCanvas(720, 1280).designH).toBe(1920);
	});
	it('eases and springs between 0 and 1', () => {
		for (const f of [easeOutCubic, easeInOutCubic]) {
			expect(f(0)).toBe(0);
			expect(f(1)).toBe(1);
			expect(f(-1)).toBe(0);
			expect(f(2)).toBe(1);
		}
		for (const [k, c] of [
			[180, 20],
			[100, 20],
			[100, 40],
		] as const) {
			expect(spring(0, k, c, 1)).toBe(0);
			expect(Math.abs(spring(5, k, c, 1) - 1)).toBeLessThan(1e-4);
		}
	});
	it('estimates text width and escapes XML', () => {
		expect(estimateTextWidth('Alex', 60, 400)).toBeCloseTo((0.68 + 0.3 + 0.56 + 0.56) * 60, 9);
		expect(estimateTextWidth('Alex', 60, 700)).toBeGreaterThan(estimateTextWidth('Alex', 60, 400));
		expect(escapeXml(`a<b & "c" 'd'>\u0001`)).toBe('a&lt;b &amp; &quot;c&quot; &#39;d&#39;&gt;');
	});
});

describe('SVG twins', () => {
	for (const def of MG_CATALOG) {
		const fps = 30;
		const duration = Math.round(def.defaultDurationSeconds * fps);
		it(`${def.id}@${def.version} renders deterministic SVG at frames 0 / mid / end`, () => {
			for (const frame of [0, Math.floor(duration / 2), duration - 1]) {
				const svg = def.renderSvg(def.defaults, frame, fps, HD, { durationFrames: duration });
				expect(svg).toBe(def.renderSvg(def.defaults, frame, fps, HD, { durationFrames: duration }));
				expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080"')).toBe(
					true,
				);
				expect(svg.endsWith('</svg>')).toBe(true);
				expect(svg).toMatchSnapshot(`${def.id}@${def.version} frame ${frame}`);
			}
		});
		it(`${def.id}@${def.version} scales to other canvases`, () => {
			const svg = def.renderSvg(def.defaults, 45, fps, { width: 1280, height: 720 }, { durationFrames: 120 });
			expect(svg).toContain('width="1280" height="720"');
			expect(svg).toContain('scale(0.667)');
		});
	}

	it('lower-third slides in, holds and fades out at the clip end', () => {
		const at = (frame: number, extra: Parameters<typeof lowerThird.renderSvg>[4] = {}) =>
			lowerThird.renderSvg(lowerThird.defaults, frame, 30, HD, { durationFrames: 150, ...extra });
		expect(at(0)).toContain('opacity="1"');
		expect(at(0)).toMatch(/<rect x="0" y="0" width="0" height="150"/);
		expect(at(75)).toContain('translate(120 800)');
		expect(at(149)).toMatch(/translate\((\d+\.?\d*) 800\)" opacity="0\.\d+"/);
		// holdUntilFrames moves the outro earlier; a longer clip keeps the same intro
		expect(at(100, {})).toContain('translate(120 800)" opacity="1"');
		const held = lowerThird.renderSvg({ ...lowerThird.defaults, holdUntilFrames: 60 }, 100, 30, HD, {
			durationFrames: 150,
		});
		expect(held).toContain('opacity="0"');
		expect(at(10, { durationFrames: 900 })).toBe(at(10));
		expect(at(5, { idPrefix: 'clp_1' })).toContain('id="clp_1-lt-clip"');
		expect(lowerThird.renderSvg({ ...lowerThird.defaults, name: '<Ana & Bo>' }, 60, 30, HD)).toContain(
			'&lt;Ana &amp; Bo&gt;',
		);
	});

	it('title-card fades in and out over the configured frames', () => {
		const at = (frame: number, p = titleCard.defaults) =>
			titleCard.renderSvg(p, frame, 30, HD, { durationFrames: 120 });
		expect(at(0)).toMatch(/^<svg[^>]*><g opacity="0">/);
		expect(at(60)).toMatch(/^<svg[^>]*><g opacity="1">/);
		expect(at(119)).not.toMatch(/^<svg[^>]*><g opacity="1">/);
		const noFade = { ...titleCard.defaults, fadeInFrames: 0, fadeOutFrames: 0 };
		expect(at(0, noFade)).toMatch(/^<svg[^>]*><g opacity="1">/);
		expect(at(60, { ...titleCard.defaults, subtitle: '' })).not.toContain('font-size="44"');
		expect(at(60, { ...titleCard.defaults, alignment: 'left' })).toContain('text-anchor="start"');
	});
});

describe('render specs and keys', () => {
	it('builds the spec of a motion-graphic clip and a stable key', () => {
		const ids = createSeededIdSource(9);
		const doc = createEmptyProject({ ids, name: 'mg' });
		const { document, result } = applyTransaction(
			doc,
			{
				label: 'MG',
				origin: 'user',
				commands: [
					{
						type: 'clip.addMotionGraphic',
						at: 0,
						duration: 150,
						track: 'V2',
						template: { id: 'lower-third', version: 1 },
						params: { name: 'Ana' },
					},
				],
			},
			{ ids, now: () => 't', revision: 0, registries: defaultRegistries(mgRegistry) },
		);
		expect(result.ok).toBe(true);
		const seq = Object.values(document.sequences)[0]!;
		const clip = Object.values(seq.clips).find((c) => c.kind === 'motion-graphic')!;
		expect(clip.kind).toBe('motion-graphic');
		const spec = specFromClip(
			{
				source: {
					mg: {
						template: { id: 'lower-third', version: 1 },
						params: { name: 'Ana' },
						canvas: { width: 1920, height: 1080 },
					},
				},
				duration: 150,
				sourceIn: 0,
			},
			{ num: 30, den: 1 },
			mgRegistry,
		)!;
		expect(spec.params).toEqual({ ...lowerThird.defaults, name: 'Ana' });
		expect(spec).toMatchObject({ width: 1920, height: 1080, durationFrames: 150, sourceInFrames: 0 });
		const a = mgRenderKeyMaterial(spec, 'r1');
		const b = mgRenderKeyMaterial({ ...spec, params: { ...spec.params } }, 'r1');
		expect(a).toBe(b);
		expect(mgRenderKeyMaterial({ ...spec, durationFrames: 151 }, 'r1')).not.toBe(a);
		expect(mgRenderKeyMaterial(spec, 'r2')).not.toBe(a);
		expect(
			specFromClip({ source: { color: [0, 0, 0, 1] }, duration: 1, sourceIn: 0 }, { num: 30, den: 1 }),
		).toBe(null);
	});
	it('canonical JSON sorts keys at every level', () => {
		expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: null } })).toBe(
			'{"a":{"c":null,"d":[1,{"y":2,"z":1}]},"b":1}',
		);
	});
});
