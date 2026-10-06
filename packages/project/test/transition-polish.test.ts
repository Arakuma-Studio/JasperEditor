// Wave-4 transition polish (docs/wp-notes/fx-transition-framework.md): the `expensive` flag, image (`media`) params
// (Gradient Wipe / VR Gradient Wipe custom gradients), the sides' trackers (S_MochaWhip's Mocha mode), uniform
// collision checks of both validators, and the Custom Completion timing curve.
import { describe, expect, it } from 'vitest';
import {
	buildRenderSnapshot,
	defaultRegistries,
	type EffectSpec,
	exportAgentSchema,
	flicksPerFrame,
	type MediaHandle,
	planGpuTransition,
	type Rational,
	type TrackerSamples,
	type TransitionSpec,
	transitionLinearProgress,
	transitionProgress,
	transitionSpec,
	transitionTiming,
	transitionTrackerOf,
	validateGpuEffect,
	validateGpuTransition,
} from '../src/index.ts';
import { mochaTrackUniforms } from '../src/registry/transitions/sapphire-swish-other/swish.ts';
import { Harness, videoAsset } from './helpers.ts';

const HANDLE: MediaHandle = {
	url: '/m',
	proxyUrl: null,
	kind: 'video',
	width: 1920,
	height: 1080,
	durationFlicks: null,
	hasAudio: false,
	rotation: 0,
};
const spec = (id: string) => transitionSpec(id)!;
const defaults = (s: TransitionSpec) => Object.fromEntries(s.params.map((p) => [p.name, p.default]));
const side = { width: 64, height: 36, compToCanvas: [1, 0, 0, 0, 1, 0, 0, 0, 1], opacity: 1 };

describe('expensive transitions', () => {
	const HEAVY = [
		'jasper.s.swish-3d',
		'jasper.s.hyper-push',
		'jasper.s.hyper-pull',
		'jasper.s.film-roll',
		'jasper.s.parallax-strips-transition',
		'jasper.s.dissolve-defocus',
		'jasper.s.dissolve-pixel-sort',
		'jasper.s.dissolve-pixel-mosh',
		'jasper.s.dissolve-zap',
		'jasper.s.dissolve-auto-paint',
		'jasper.s.dissolve-glow',
		'jasper.s.dissolve-ultra-glow',
		'jasper.s.dissolve-light-leak',
		'jasper.s.dissolve-rays',
		'jasper.s.dissolve-digital-damage',
		'jasper.morph-cut',
		'jasper.vr-spherical-blur',
	];
	it('marks the heavy transitions the authors named (and only flags, never changes output)', () => {
		for (const id of HEAVY) expect(spec(id).expensive, id).toBe(true);
		for (const id of ['jasper.push', 'jasper.cross-dissolve', 'jasper.s.dissolve-luma', 'jasper.s.swish-pan'])
			expect(spec(id).expensive, id).toBeUndefined();
	});
	it('exports the flag in the agent schema', () => {
		const schema = exportAgentSchema(defaultRegistries());
		expect(
			schema.transitions
				.filter((t) => t.expensive)
				.map((t) => t.id)
				.sort(),
		).toEqual([...HEAVY].sort());
	});
});

describe('image params on transitions', () => {
	it('Gradient Wipe and VR Gradient Wipe take a Custom Gradient image (hold-only, images only)', () => {
		for (const id of ['jasper.gradient-wipe', 'jasper.vr-gradient-wipe']) {
			const p = spec(id).params.find((x) => x.name === 'gradientImage')!;
			expect(p).toMatchObject({ type: 'media', mediaKinds: ['image'], animatable: false });
			expect(p.default).toEqual({ mediaId: '' });
			// The built-in gradient choice stays (the fallback without an image).
			expect(spec(id).params.some((x) => x.name === 'gradient')).toBe(true);
		}
	});

	it('binds the image as u_<name> + u_<name>_size, like effects', () => {
		const s = spec('jasper.gradient-wipe');
		const r = planGpuTransition(
			s,
			{
				id: 'trn_1',
				params: { ...defaults(s), gradientImage: { mediaId: 'med_g' } },
				frame: 3,
				duration: 10,
				sides: 'both',
			},
			{ width: 64, height: 36, fps: 30 },
			{ out: side, in: side },
		);
		expect(r.plan.textures).toContainEqual({
			param: 'gradientImage',
			uniform: 'u_gradientImage',
			mediaId: 'med_g',
		});
		const last = r.plan.passes.at(-1)!.source;
		expect(last).toMatch(/uniform sampler2D u_gradientImage;/);
		expect(last).toMatch(/uniform vec2 u_gradientImage_size;/);
		// Unbound: the texture is still listed (size (0, 0) at run time → the built-in gradient).
		const none = planGpuTransition(
			s,
			{ id: 'trn_1', params: defaults(s), frame: 3, duration: 10, sides: 'both' },
			{ width: 64, height: 36, fps: 30 },
			{ out: side, in: side },
		);
		expect(none.plan.textures.find((t) => t.param === 'gradientImage')!.mediaId).toBe('');
	});

	it('validates media params: images only, hold-only', () => {
		const base = spec('jasper.gradient-wipe');
		const withParam = (p: object) => ({
			...base,
			id: 'test.media',
			params: base.params.map((x) => (x.name === 'gradientImage' ? { ...x, ...p } : x)),
		});
		expect(validateGpuTransition(base)).toEqual([]);
		expect(validateGpuTransition(withParam({ mediaKinds: ['video'] })).join('\n')).toMatch(/images only/);
		expect(validateGpuTransition(withParam({ mediaKinds: ['lut'] })).join('\n')).toMatch(/images only/);
		expect(validateGpuTransition(withParam({ animatable: true })).join('\n')).toMatch(/hold-only/);
	});

	it('the render snapshot gives the bound image a media handle', () => {
		const h = new Harness();
		const a = h.registerVideo({ audio: false });
		const img = h.registerVideo({ kind: 'image', audio: false });
		h.ok([
			{
				type: 'clip.place',
				source: { mediaId: a },
				at: 0,
				sourceRange: { in: { sourceFrames: 30 }, out: { sourceFrames: 130 } },
			},
			{
				type: 'clip.place',
				source: { mediaId: a },
				at: 100,
				sourceRange: { in: { sourceFrames: 60 }, out: { sourceFrames: 160 } },
			},
			{
				type: 'transition.add',
				trackId: 'V1',
				at: 100,
				effectId: 'jasper.gradient-wipe',
				duration: 20,
				params: { gradientImage: { mediaId: img } },
			},
		]);
		const snap = buildRenderSnapshot(h.doc, h.seqId, { resolveMedia: () => HANDLE, resolveFont: () => null });
		expect(snap.media[img]).toEqual(HANDLE);
		expect(snap.videoTracks[0]!.transitions![0]!.params.gradientImage!.value).toEqual({ mediaId: img });
	});
});

describe('trackers of transition sides', () => {
	/** A at 0–100, B at 100–200 (B's source in-point at its frame 60), Push at the cut (span 90–110). */
	function setup(opts: { scaleB?: number; tracker?: 'planar' | 'point' } = {}) {
		const h = new Harness();
		const m = h.registerVideo({ audio: false });
		const r = h.ok([
			{
				type: 'clip.place',
				source: { mediaId: m },
				at: 0,
				sourceRange: { in: { sourceFrames: 30 }, out: { sourceFrames: 130 } },
				ref: '$a',
			},
			{
				type: 'clip.place',
				source: { mediaId: m },
				at: 100,
				sourceRange: { in: { sourceFrames: 60 }, out: { sourceFrames: 160 } },
				ref: '$b',
			},
			{ type: 'transition.add', trackId: 'V1', at: 100, effectId: 'jasper.s.mocha-whip', duration: 20 },
		]);
		const b = r.refs.$b!;
		const F = flicksPerFrame(h.seq.settings.frameRate as Rational);
		if (opts.scaleB)
			h.ok([{ type: 'param.set', target: ['clip', b, 'transform', 'scale'], value: opts.scaleB }]);
		if (opts.tracker) {
			const planar = opts.tracker === 'planar';
			const t = h.ok([
				planar
					? {
							type: 'tracker.add',
							clipId: b,
							kind: 'planar',
							at: { frames: 0 },
							corners: [
								[800, 400],
								[1100, 400],
								[1100, 700],
								[800, 700],
							],
						}
					: { type: 'tracker.add', clipId: b, kind: 'point', at: { frames: 0 }, point: [960, 540] },
			]);
			const id = (t.results[0] as { trackerId: string }).trackerId;
			// The tracked region moves +1 px right per source frame.
			const n = 300;
			const stride = planar ? 8 : 2;
			const data: number[] = [];
			for (let i = 0; i < n; i++)
				data.push(...(planar ? [800 + i, 400, 1100 + i, 400, 1100 + i, 700, 800 + i, 700] : [960 + i, 540]));
			const samples: TrackerSamples = { start: 0, step: F, stride, data, confidence: new Array(n).fill(1) };
			h.ok([{ type: 'tracker.setSamples', trackerId: id, samples, method: 'test@1' }]);
		}
		const snap = buildRenderSnapshot(h.doc, h.seqId, { resolveMedia: () => HANDLE, resolveFont: () => null });
		return { h, b, t: snap.videoTracks[0]!.transitions![0]! };
	}

	it('no tracker: no tracks on the transition', () => {
		expect(setup().t.tracks).toBeUndefined();
	});

	it("a planar track of B over the span, through B's Motion, in sequence px", () => {
		const { t } = setup({ tracker: 'planar' });
		expect([t.start, t.duration]).toEqual([90, 20]);
		const tr = t.tracks!.in!;
		expect(t.tracks!.out).toBeUndefined();
		expect(tr.kind).toBe('planar');
		expect(tr.frames).toHaveLength(20);
		// Span frame 0 = sequence frame 90 = B's local frame −10 → source frame 50.
		expect(tr.frames[0]!.corners![0]).toEqual([850, 400]);
		expect(tr.frames[19]!.corners![2]).toEqual([1169, 700]);
		expect(tr.frames[0]!.point).toEqual([1000, 550]);
		expect(tr.frames[0]!.tracked).toBe(true);
		// B scaled to 50 % about the frame centre: (x − 960) / 2 + 960.
		const s = setup({ tracker: 'planar', scaleB: 50 }).t.tracks!.in!;
		expect(s.frames[0]!.corners![0]).toEqual([905, 470]);
	});

	it('the stage context gets the track of the frame; Reverse swaps it with the sides', () => {
		const { t } = setup({ tracker: 'point' });
		const s = spec('jasper.s.mocha-whip');
		const plan = (params: Record<string, unknown>, frame: number) =>
			planGpuTransition(
				s,
				{
					id: t.id,
					params: { ...defaults(s), ...params } as never,
					frame,
					duration: 20,
					sides: 'both',
					tracks: t.tracks,
				},
				{ width: 1920, height: 1080, fps: 30 },
				{ out: side, in: side },
			);
		const r = plan({}, 5);
		expect(r.ctx.tracks!.to).toMatchObject({ kind: 'point', point: [1015, 540] });
		expect(r.ctx.tracks!.from).toBeNull();
		expect(mochaTrackUniforms(defaults(s), r.ctx)).toMatchObject({
			u_mwTrack: { int: 2 },
			u_mwTrackAt: [1015, 540],
		});
		expect(r.plan.uniforms.find((u) => u.name === 'u_mwTrack')!.value).toEqual([2]);
		expect(mochaTrackUniforms({ ...defaults(s), trackMode: 'off' }, r.ctx).u_mwTrack).toEqual({ int: 0 });
		const rev = plan({ reverse: true }, 5);
		expect(rev.ctx.tracks!.from).toMatchObject({ point: [1015, 540] });
		expect(rev.ctx.tracks!.to).toBeNull();
	});

	it('picks the planar tracker with samples first', () => {
		const ref = {
			time: 0,
			corners: [
				[0, 0],
				[1, 0],
				[1, 1],
				[0, 1],
			] as [number, number][],
		};
		const samples = { start: 0, step: 1, stride: 2 as const, data: [1, 2], confidence: [1] };
		const mk = (id: string, kind: 'planar' | 'point', s: typeof samples | null) =>
			({
				id,
				name: id,
				kind,
				reference: kind === 'point' ? { time: 0, point: [1, 1] as [number, number] } : ref,
				samples: s,
				method: 'm',
			}) as never;
		expect(transitionTrackerOf(undefined)).toBeNull();
		expect(transitionTrackerOf([mk('a', 'planar', null), mk('b', 'point', samples)])!.id).toBe('b');
		expect(transitionTrackerOf([mk('a', 'planar', null)])!.id).toBe('a');
	});
});

describe('uniform collisions (validators)', () => {
	const push = spec('jasper.push');
	const gpu = push.gpu!;
	it('rejects extra uniforms that redeclare a param uniform, a built-in or a pass output', () => {
		const withGpu = (g: object): TransitionSpec => ({ ...push, id: 'test.collide', gpu: { ...gpu, ...g } });
		const one = (uniforms: Record<string, number>) => [
			{ output: 'mixed', frag: 'void main() { fragColor = vec4(0.0); }', uniforms },
			{ frag: 'void main() { fragColor = texture(u_mixed, v_uv); }' },
		];
		expect(validateGpuTransition(withGpu({ uniforms: () => ({ u_direction: 1 }) })).join('\n')).toMatch(
			/uniform "u_direction" collides with the uniform of param "direction"/,
		);
		expect(validateGpuTransition(withGpu({ uniforms: () => ({ u_hasTo: 1 }) })).join('\n')).toMatch(
			/"u_hasTo" is a built-in/,
		);
		expect(validateGpuTransition(withGpu({ passes: one({ u_mixed: 1 }) })).join('\n')).toMatch(
			/pass 0: uniform "u_mixed" collides with the pass output "mixed"/,
		);
		expect(validateGpuTransition(withGpu({ passes: one({ u_from: 1 }) })).join('\n')).toMatch(
			/"u_from" is a built-in/,
		);
		expect(
			validateGpuTransition(withGpu({ uniforms: () => ({ u_k: 1 }), passes: one({ u_k: 2 }) })).join('\n'),
		).toMatch(/pass 0: uniform "u_k" is also returned by uniforms\(\)/);
		const gw = spec('jasper.gradient-wipe');
		expect(
			validateGpuTransition({
				...gw,
				id: 'test.gw',
				gpu: { ...gw.gpu!, uniforms: () => ({ u_gradientImage_size: [1, 1] }) },
			}).join('\n'),
		).toMatch(/collides with the uniform of param "gradientImage"/);
	});

	it('validateGpuEffect checks the same', () => {
		const fx = defaultRegistries()
			.effects.list()
			.find((e) => e.gpu && e.params.some((p) => p.type === 'number'))!;
		const num = fx.params.find((p) => p.type === 'number')!;
		const bad: EffectSpec = {
			...fx,
			id: 'test.fx',
			gpu: { ...fx.gpu!, uniforms: () => ({ [`u_${num.name}`]: 1 }) },
		};
		expect(validateGpuEffect(bad).join('\n')).toMatch(
			new RegExp(`collides with the uniform of param "${num.name}"`),
		);
		const out: EffectSpec = {
			...fx,
			id: 'test.fx2',
			gpu: {
				passes: [
					{ output: 'blurred', frag: 'void main() { fragColor = vec4(0.0); }' },
					{ frag: 'void main() { fragColor = texture(u_blurred, v_uv); }', uniforms: { u_blurred: 1 } },
				],
			},
		};
		expect(validateGpuEffect(out).join('\n')).toMatch(/collides with the pass output "blurred"/);
	});
});

describe('Custom Completion (keyframable timing curve)', () => {
	const gpu = spec('jasper.push').gpu;
	it('every GPU transition has Custom Completion + Transition Completion after Start / End', () => {
		for (const id of ['jasper.push', 'jasper.s.dissolve-luma', 'jasper.morph-cut']) {
			const names = spec(id).params.map((p) => p.name);
			expect(names.slice(0, 4)).toEqual(['startPercent', 'endPercent', 'useCompletion', 'completion']);
		}
		const p = spec('jasper.push').params;
		expect(p.find((x) => x.name === 'useCompletion')).toMatchObject({
			type: 'boolean',
			default: false,
			animatable: false,
		});
		expect(p.find((x) => x.name === 'completion')).toMatchObject({
			type: 'number',
			unit: '%',
			animatable: true,
		});
		expect(spec('jasper.cross-dissolve').params).toEqual([]);
	});

	it('untouched (off) keeps the linear timing exactly, whatever the completion value', () => {
		for (const f of [0, 4, 9]) {
			const lin = transitionLinearProgress(f, 10, 'both');
			expect(transitionTiming({ completion: 80 }, lin)).toBe(lin);
			expect(transitionProgress(gpu, { useCompletion: false, completion: 80 }, lin).progress).toBe(lin);
		}
	});

	it('on: the completion replaces the ramp; Start / End and Reverse apply on top', () => {
		expect(transitionProgress(gpu, { useCompletion: true, completion: 0 }, 0.7).progress).toBe(0);
		expect(transitionProgress(gpu, { useCompletion: true, completion: 100 }, 0.1).progress).toBe(1);
		expect(
			transitionProgress(gpu, { useCompletion: true, completion: 50, startPercent: 20, endPercent: 60 }, 0.9)
				.progress,
		).toBeCloseTo(0.4);
		expect(transitionProgress(gpu, { useCompletion: true, completion: 25, reverse: true }, 0.9)).toEqual({
			progress: 0.75,
			swapped: true,
			reversed: true,
		});
	});

	it('keyframed through the commands: the stage follows the curve frame by frame', () => {
		const h = new Harness();
		const m = h.ok([{ type: 'media.register', asset: videoAsset({ audio: false }) }]).results[0] as {
			mediaId: string;
		};
		h.ok([
			{
				type: 'clip.place',
				source: { mediaId: m.mediaId },
				at: 0,
				sourceRange: { in: { sourceFrames: 30 }, out: { sourceFrames: 130 } },
			},
			{
				type: 'clip.place',
				source: { mediaId: m.mediaId },
				at: 100,
				sourceRange: { in: { sourceFrames: 60 }, out: { sourceFrames: 160 } },
			},
			{ type: 'transition.add', trackId: 'V1', at: 100, effectId: 'jasper.push', duration: 20, ref: '$t' },
		]);
		const id = Object.keys(h.seq.transitions)[0]!;
		h.ok([
			{ type: 'param.set', target: ['transition', id, 'useCompletion'], value: true },
			{ type: 'keyframe.add', target: ['transition', id, 'completion'], at: { sequenceFrame: 90 }, value: 0 },
			{
				type: 'keyframe.add',
				target: ['transition', id, 'completion'],
				at: { sequenceFrame: 109 },
				value: 100,
			},
		]);
		const a = h.seq.transitions[id]!.params.completion!;
		expect(a.keyframes.map((k) => k.value)).toEqual([0, 100]);
	});
});
