// Premiere Pro standard effects of the fx catalogue (family "premiere-stylize-distort-generate", wave 2): the entries,
// their Premiere-facing params, and the pure TypeScript maths (time hooks, timecode text, strobe timing, paddings,
// text encoding). Pixel behaviour: packages/compositions/test/fx-psdg-*-gl.test.ts.
import { describe, expect, it } from 'vitest';
import { defaultEffectRegistry, type EffectSpec, FX_FAMILIES, validateGpuEffect } from '../src/index.ts';
import { PSDG_BLEND_MODES } from '../src/registry/fx/premiere-stylize-distort-generate/common.ts';
import { waveWarpPadding } from '../src/registry/fx/premiere-stylize-distort-generate/distort.ts';
import {
	lensFlarePadding,
	lightningPadding,
} from '../src/registry/fx/premiere-stylize-distort-generate/generate-render.ts';
import { strobeOn } from '../src/registry/fx/premiere-stylize-distort-generate/stylize-2.ts';
import {
	echoIntensity,
	echoOffsets,
	posterizeTimeFrame,
} from '../src/registry/fx/premiere-stylize-distort-generate/time.ts';
import {
	encodeText,
	formatTimecode,
	PSDG_TEXT_MAX,
	parseTimecode,
	timecodeText,
} from '../src/registry/fx/premiere-stylize-distort-generate/video.ts';
import { PREMIERE_STYLIZE_DISTORT_GENERATE_EFFECTS as FAMILY } from '../src/registry/fx/premiere-stylize-distort-generate.ts';

const byId = (id: string): EffectSpec => {
	const s = FAMILY.find((e) => e.id === id);
	if (!s) throw new Error(`missing ${id}`);
	return s;
};
const defaults = (s: EffectSpec) => Object.fromEntries(s.params.map((p) => [p.name, p.default]));
const labels = (id: string) => byId(id).params.map((p) => p.label);

/** Premiere label → id, per Video Effects bin. */
const EXPECTED: Record<string, [string, string][]> = {
	Distort: [
		['Lens Distortion', 'jasper.lens-distortion'],
		['Magnify', 'jasper.magnify'],
		['Mirror', 'jasper.mirror'],
		['Offset', 'jasper.offset'],
		['Spherize', 'jasper.spherize'],
		['Turbulent Displace', 'jasper.turbulent-displace'],
		['Twirl', 'jasper.twirl'],
		['Wave Warp', 'jasper.wave-warp'],
	],
	Generate: [
		['4-Color Gradient', 'jasper.4-color-gradient'],
		['Cell Pattern', 'jasper.cell-pattern'],
		['Checkerboard', 'jasper.checkerboard'],
		['Circle', 'jasper.circle'],
		['Ellipse', 'jasper.ellipse'],
		['Eyedropper Fill', 'jasper.eyedropper-fill'],
		['Grid', 'jasper.grid'],
		['Ramp', 'jasper.ramp'],
		['Lens Flare', 'jasper.lens-flare'],
		['Lightning', 'jasper.lightning'],
		['Paint Bucket', 'jasper.paint-bucket'],
		['Write-on', 'jasper.write-on'],
	],
	'Noise & Grain': [
		['Dust & Scratches', 'jasper.dust-and-scratches'],
		['Median', 'jasper.median'],
		['Noise', 'jasper.noise'],
		['Noise Alpha', 'jasper.noise-alpha'],
		['Noise HLS', 'jasper.noise-hls'],
		['Noise HLS Auto', 'jasper.noise-hls-auto'],
	],
	Stylize: [
		['Alpha Glow', 'jasper.alpha-glow'],
		['Brush Strokes', 'jasper.brush-strokes'],
		['Color Emboss', 'jasper.color-emboss'],
		['Emboss', 'jasper.emboss'],
		['Find Edges', 'jasper.find-edges'],
		['Mosaic', 'jasper.mosaic'],
		['Posterize', 'jasper.posterize'],
		['Replicate', 'jasper.replicate'],
		['Roughen Edges', 'jasper.roughen-edges'],
		['Solarize', 'jasper.solarize'],
		['Strobe Light', 'jasper.strobe-light'],
		['Texturize', 'jasper.texturize'],
		['Threshold', 'jasper.threshold'],
		['Vignette', 'jasper.vignette'],
		['Glow', 'jasper.glow'],
	],
	Time: [
		['Echo', 'jasper.echo'],
		['Posterize Time', 'jasper.posterize-time'],
	],
	Video: [
		['Clip Name', 'jasper.clip-name'],
		['Timecode', 'jasper.timecode'],
		['Simple Text', 'jasper.simple-text'],
	],
	Transition: [
		['Block Dissolve', 'jasper.block-dissolve'],
		['Gradient Wipe', 'jasper.gradient-wipe'],
		['Linear Wipe', 'jasper.linear-wipe'],
		['Radial Wipe', 'jasper.radial-wipe'],
		['Venetian Blinds', 'jasper.venetian-blinds'],
	],
};

describe('premiere-stylize-distort-generate family', () => {
	it('has every Premiere effect of the brief, in its bin, registered and valid', () => {
		const all = Object.entries(EXPECTED).flatMap(([cat, list]) =>
			list.map(([label, id]) => ({ cat, label, id })),
		);
		expect(FAMILY.map((s) => s.id).sort()).toEqual(all.map((e) => e.id).sort());
		for (const e of all) {
			const s = byId(e.id);
			expect(s.label).toBe(e.label);
			expect(s.category).toBe(e.cat);
			expect(s.bin).toBeUndefined();
			expect(s.gpu).toBeTruthy();
			expect(s.description).toBeTruthy();
			expect(defaultEffectRegistry.get(e.id)).toBe(s);
			expect(validateGpuEffect(s)).toEqual([]);
		}
		expect(FX_FAMILIES.find((f) => f.file === 'premiere-stylize-distort-generate')!.effects).toBe(FAMILY);
	});

	it('does not duplicate the existing Premiere effects', () => {
		const existing = [
			'Crop',
			'Gaussian Blur',
			'Brightness & Contrast',
			'Hue/Saturation',
			'Black & White',
			'Corner Pin',
		];
		for (const s of FAMILY) expect(existing).not.toContain(s.label);
	});

	it('uses Premiere parameter names and order', () => {
		expect(labels('jasper.lens-distortion')).toEqual([
			'Curvature',
			'Vertical Decentering',
			'Horizontal Decentering',
			'Vertical Prism FX',
			'Horizontal Prism FX',
			'Fill Alpha',
			'Fill Color',
		]);
		expect(labels('jasper.wave-warp')).toEqual([
			'Wave Type',
			'Wave Height',
			'Wave Width',
			'Direction',
			'Wave Speed',
			'Pinning',
			'Phase',
			'Antialiasing (Best Quality)',
		]);
		expect(labels('jasper.lens-flare')).toEqual([
			'Flare Center',
			'Flare Brightness',
			'Lens Type',
			'Blend With Original',
		]);
		expect(byId('jasper.lens-flare').params[2]!.optionLabels).toEqual([
			'50-300mm Zoom',
			'35mm Prime',
			'105mm Prime',
		]);
		expect(labels('jasper.ramp')).toEqual([
			'Start of Ramp',
			'Start Color',
			'End of Ramp',
			'End Color',
			'Ramp Shape',
			'Ramp Scatter',
			'Blend With Original',
		]);
		expect(labels('jasper.echo')).toEqual([
			'Echo Time (seconds)',
			'Number of Echoes',
			'Starting Intensity',
			'Decay',
			'Echo Operator',
		]);
		expect(labels('jasper.mosaic')).toEqual(['Horizontal Blocks', 'Vertical Blocks', 'Sharp Colors']);
		expect(labels('jasper.mirror')).toEqual(['Reflection Center', 'Reflection Angle']);
		expect(labels('jasper.vignette')).toEqual(['Amount', 'Midpoint', 'Roundness', 'Feather']);
		expect(labels('jasper.linear-wipe')).toEqual(['Transition Completion', 'Wipe Angle', 'Feather']);
		expect(labels('jasper.radial-wipe')).toEqual([
			'Transition Completion',
			'Start Angle',
			'Wipe Center',
			'Wipe',
			'Feather',
		]);
	});

	it('defaults are neutral where Premiere’s are (filters that start as identity)', () => {
		const d = (id: string) => defaults(byId(id));
		expect(d('jasper.lens-distortion').curvature).toBe(0);
		expect(d('jasper.spherize').radius).toBe(0);
		expect(d('jasper.noise').amount).toBe(0);
		expect(d('jasper.median').radius).toBe(0);
		expect(d('jasper.vignette').amount).toBe(0);
		for (const id of EXPECTED.Transition!.map(([, i]) => i)) expect(d(id).completion).toBe(0);
	});

	it('centres and positions are point params; randomness via a `seed` param', () => {
		for (const s of FAMILY)
			for (const p of s.params) {
				if (/center|point|position|anchor|corner/i.test(p.label) && p.type === 'vec2')
					expect(p.ui?.control, `${s.id} ${p.name}`).toBe('point');
				if (p.label === 'Random Seed') expect(p.name === 'seed' || p.name === 'randomSeed').toBe(true);
			}
	});

	it('generator blending modes follow the AE list', () => {
		const circle = byId('jasper.circle').params.find((p) => p.name === 'blendingMode')!;
		expect(circle.options).toEqual(PSDG_BLEND_MODES);
		expect(circle.default).toBe('none');
	});
});

describe('time effects (pure hooks)', () => {
	const echo = defaults(byId('jasper.echo'));
	it('Echo: offsets of k × Echo Time, intensities decay', () => {
		expect(echoOffsets(echo, { fps: 30 })).toEqual([-1]);
		expect(echoOffsets({ ...echo, numberOfEchoes: 4, echoTime: -0.1 }, { fps: 30 })).toEqual([
			-3, -6, -9, -12,
		]);
		expect(echoOffsets({ ...echo, numberOfEchoes: 20 }, { fps: 30 })).toHaveLength(8);
		expect(echoOffsets({ ...echo, numberOfEchoes: 0 }, { fps: 30 })).toEqual([]);
		expect(echoIntensity({ ...echo, startingIntensity: 0.8, decay: 0.5 }, 2)).toBeCloseTo(0.2);
		const spec = byId('jasper.echo');
		const ctx = { frame: 10, fps: 30, duration: 60, headHandle: 0, tailHandle: 0, seed: 0.5 };
		expect(spec.gpu!.time!.samples!(echo, ctx)).toEqual(spec.gpu!.time!.samples!(echo, ctx));
	});

	it('Posterize Time holds frames at the posterized rate', () => {
		const p = { frameRate: 10 };
		const frames = Array.from({ length: 9 }, (_, f) => posterizeTimeFrame(p, { frame: f, fps: 30 }));
		expect(frames).toEqual([0, 0, 0, 3, 3, 3, 6, 6, 6]);
		expect(posterizeTimeFrame({ frameRate: 60 }, { frame: 7, fps: 30 })).toBe(7);
		expect(posterizeTimeFrame({ frameRate: 12 }, { frame: 25, fps: 24 })).toBe(24);
	});

	it('Strobe Light fires for Strobe Duration at every Strobe Period (and randomly with probability)', () => {
		const p = { strobeDuration: 0.1, strobePeriod: 1, probability: 0 };
		const on = (frame: number, extra = {}) => strobeOn({ ...p, ...extra }, { frame, fps: 30, seed: 0.3 });
		expect([0, 1, 2, 3, 29, 30, 31, 33].map((f) => on(f))).toEqual([
			true,
			true,
			true,
			false,
			false,
			true,
			true,
			false,
		]);
		expect(on(15, { probability: 100 })).toBe(true);
		const r = Array.from({ length: 200 }, (_, f) => on(f + 300, { probability: 30, strobeDuration: 0 }));
		const n = r.filter(Boolean).length;
		expect(n).toBeGreaterThan(30);
		expect(n).toBeLessThan(90);
		expect(r).toEqual(
			Array.from({ length: 200 }, (_, f) => on(f + 300, { probability: 30, strobeDuration: 0 })),
		);
	});
});

describe('Video bin text', () => {
	it('packs strings into floats (3 × 7 bits, exact in float32)', () => {
		const e = encodeText('Hi!');
		expect(e.length).toBe(3);
		expect(e.floats).toHaveLength(PSDG_TEXT_MAX / 3);
		expect(e.floats[0]).toBe(72 - 31 + (105 - 31) * 128 + (33 - 31) * 16384);
		expect(Math.fround(e.floats[0]!)).toBe(e.floats[0]);
		expect(encodeText('x'.repeat(200)).length).toBe(PSDG_TEXT_MAX);
		expect(encodeText('é').floats[0]).toBe(63 - 31);
	});

	it('formats SMPTE (incl. drop-frame), frames and feet+frames', () => {
		expect(formatTimecode(0, '30', 'smpte')).toBe('00:00:00:00');
		expect(formatTimecode(30 * 61 + 5, '30', 'smpte')).toBe('00:01:01:05');
		expect(formatTimecode(25 * 3600, '25', 'smpte')).toBe('01:00:00:00');
		// 29.97 DF: frame 1800 is 00:01:00;02 (frames 0 and 1 of minute 1 are dropped); 17982 = 00:10:00;00.
		expect(formatTimecode(1800, '30df', 'smpte')).toBe('00:01:00;02');
		expect(formatTimecode(17982, '30df', 'smpte')).toBe('00:10:00;00');
		expect(formatTimecode(1234, '30', 'frames')).toBe('001234');
		expect(formatTimecode(35, '24', 'feet35')).toBe('0002+03');
		expect(formatTimecode(85, '24', 'feet16')).toBe('0002+05');
		expect(parseTimecode('01:00:00:00', '25')).toBe(90000);
		expect(parseTimecode('nonsense', '25')).toBe(0);
	});

	it('Timecode text per frame: source, offset, starting timecode, label', () => {
		const p = defaults(byId('jasper.timecode'));
		expect(timecodeText(p, { frame: 45, fps: 30 })).toBe('00:00:01:15');
		expect(timecodeText({ ...p, offset: 15 }, { frame: 45, fps: 30 })).toBe('00:00:02:00');
		expect(timecodeText({ ...p, timeDisplay: '25' }, { frame: 60, fps: 30 })).toBe('00:00:02:00');
		expect(
			timecodeText(
				{ ...p, timecodeSource: 'generate', startingTimecode: '01:00:00:00' },
				{ frame: 1, fps: 30 },
			),
		).toBe('01:00:00:01');
		expect(timecodeText({ ...p, labelText: 'v2' }, { frame: 0, fps: 30 })).toBe('V2 00:00:00:00');
		const u = byId('jasper.timecode').gpu!.uniforms!;
		const ctx = {
			width: 1920,
			height: 1080,
			pxScale: 1,
			fps: 30,
			frame: 12,
			duration: 90,
			seed: 0.1,
			progress: 0,
		};
		expect(u(p, ctx)).toEqual(u(p, ctx));
		expect(u(p, ctx)).not.toEqual(u(p, { ...ctx, frame: 13 }));
	});
});

describe('paddings', () => {
	it('draw-outside effects pad, others do not', () => {
		expect(waveWarpPadding(10, 'none')).toBe(11);
		expect(waveWarpPadding(10, 'allEdges')).toBe(0);
		expect(lensFlarePadding(1920, 1080)).toBe(Math.ceil(0.25 * Math.hypot(1920, 1080)));
		expect(lightningPadding({ width: 10, amplitude: 0 }, 100, 100)).toBe(30);
		const ctx = { width: 1920, height: 1080, pxScale: 1, fps: 30 };
		const pad = (id: string, over = {}) =>
			byId(id).gpu!.padding?.({ ...defaults(byId(id)), ...over }, ctx) ?? 0;
		expect(pad('jasper.glow')).toBe(100);
		expect(pad('jasper.alpha-glow')).toBeGreaterThan(10);
		expect(pad('jasper.magnify')).toBe(0);
		expect(pad('jasper.magnify', { resizeLayer: true })).toBe(100);
		expect(pad('jasper.mirror')).toBe(0);
		expect(pad('jasper.turbulent-displace', { resizeLayer: true })).toBe(60);
	});
});
