// WP0.1 (spec 12 Phase 0): the preview graph compensates the latency of track / submix / Mix inserts like the export
// mixer. `planMixLatency` is the plan MixGraph applies (route DelayNodes + source read-ahead); it must equal the
// OfflineMixer's compensation for any topology. The sample-level comparison of the real Web Audio graph against the
// export mixer runs in Chrome (audio-preview-oracle.test.ts).
import {
	type EffectInstance,
	FLICKS_PER_SECOND,
	OfflineMixer,
	type RenderAudioMix,
	type RenderStrip,
	registerAudioProcessor,
} from '@jasper/project';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	clipEffectsLatency,
	clipGainExcess,
	planMixLatency,
	previewInsertLatency,
	registerPreviewInsert,
	stripStageTimes,
} from '../src/audio/graph.ts';

const SR = 48000;
const still = (value: number) => ({ value, keyframes: [] });

function fxLat(id: string, samples: number, postFader = false): EffectInstance {
	return {
		id,
		effectId: 'test.latency',
		effectVersion: 1,
		enabled: true,
		params: { samples: still(samples) },
		...(postFader ? { postFader: true } : {}),
	} as EffectInstance;
}

function strip(
	id: string,
	kind: RenderStrip['kind'],
	o: Partial<Pick<RenderStrip, 'inserts' | 'sends' | 'output'>> = {},
): RenderStrip {
	return {
		id,
		kind,
		label: id,
		name: id,
		format: 'stereo',
		outputFormat: kind === 'master' ? null : 'stereo',
		automation: 'read',
		volumeDb: still(0),
		pan: still(0),
		mute: still(0),
		pan51: { x: still(0), y: still(100), center: still(100), lfe: still(-96) },
		inputMap: 'stereo',
		inserts: o.inserts ?? [],
		sends: o.sends ?? [],
		output: o.output === undefined ? (kind === 'master' ? null : 'master') : o.output,
		silent: false,
		inaudible: false,
	};
}

const latencyOf = (e: EffectInstance) => (e.enabled ? (e.params.samples?.value as number) : 0);

function exportLatency(mix: RenderAudioMix): number {
	const m = new OfflineMixer({
		snapshot: { audioClips: [], audioMix: mix, settings: { fps: { num: 30, den: 1 } } as never },
		openClip: () => null,
		startSample: 0,
	});
	m.close();
	return m.latency;
}

let off: (() => void) | null = null;
beforeAll(() => {
	// The export side of the test effect: a pure delay of `samples`.
	off = registerAudioProcessor('test.latency', (effect) => {
		const n = Math.round((effect.params.samples?.value as number) ?? 0);
		return { latency: n, reset() {}, process() {} };
	});
});
afterAll(() => off?.());

describe('preview latency plan (track / submix / Mix inserts)', () => {
	it('a track insert: the other tracks are delayed to it and the graph reads ahead by it', () => {
		const mix: RenderAudioMix = {
			sampleRate: SR,
			masterFormat: 'stereo',
			strips: [
				strip('A1', 'track', { inserts: [fxLat('f1', 256)] }),
				strip('A2', 'track'),
				strip('master', 'master'),
			],
			loudness: null,
		};
		const plan = planMixLatency(mix, latencyOf);
		expect(plan.total).toBe(256);
		expect(plan.strips.A1!.outDelay).toBe(0);
		expect(plan.strips.A2!.outDelay).toBe(256);
		expect(plan.strips.master!.inLat).toBe(256);
		expect(plan.total).toBe(exportLatency(mix));
	});

	it('pre/post-fader sends, a submix insert, Mix inserts and the limiter', () => {
		const mix: RenderAudioMix = {
			sampleRate: SR,
			masterFormat: 'stereo',
			strips: [
				strip('A1', 'track', {
					inserts: [fxLat('a', 64), fxLat('b', 100, true)],
					sends: [{ id: 's1', target: 'S1', levelDb: still(0), pan: 0, preFader: true }],
				}),
				strip('A2', 'track', {
					sends: [{ id: 's2', target: 'S1', levelDb: still(0), pan: 0, preFader: false }],
				}),
				strip('S1', 'submix', { inserts: [fxLat('c', 300)] }),
				strip('master', 'master', { inserts: [fxLat('d', 30, true)] }),
			],
			loudness: null,
		};
		const plan = planMixLatency(mix, latencyOf, 7);
		const p = plan.strips;
		expect(p.A1).toMatchObject({ inLat: 0, preLat: 64, postLat: 164 });
		expect(p.S1).toMatchObject({ inLat: 64, preLat: 364, postLat: 364 });
		// every input of a bus arrives at its inLat
		expect(p.A1!.sendDelays.s1).toBe(0);
		expect(p.A2!.sendDelays.s2).toBe(64);
		expect(p.master!.inLat).toBe(364);
		expect(164 + p.A1!.outDelay).toBe(364);
		expect(0 + p.A2!.outDelay).toBe(364);
		expect(364 + p.S1!.outDelay).toBe(364);
		expect(plan.total).toBe(394 + 7);
		expect(plan.total - 7).toBe(exportLatency(mix));
	});

	it('equals the export mixer for any topology, and every route arrives aligned (property)', () => {
		const topology = fc
			.record({
				tracks: fc.integer({ min: 1, max: 4 }),
				submixes: fc.integer({ min: 0, max: 3 }),
				seed: fc.array(fc.nat(10_000), { minLength: 64, maxLength: 64 }),
			})
			.map(({ tracks, submixes, seed }) => {
				let k = 0;
				const r = (n: number) => seed[k++ % seed.length]! % n;
				const ids = [
					...Array.from({ length: tracks }, (_, i) => `A${i + 1}`),
					...Array.from({ length: submixes }, (_, i) => `S${i + 1}`),
					'master',
				];
				const strips = ids.map((id, i) => {
					const kind: RenderStrip['kind'] =
						id === 'master' ? 'master' : id.startsWith('S') ? 'submix' : 'track';
					const inserts = Array.from({ length: r(3) }, (_, j) => fxLat(`${id}fx${j}`, r(5) * 97, r(2) === 1));
					const later = ids.slice(Math.max(i + 1, tracks)).filter((t) => t !== 'master');
					const output =
						kind === 'master' ? null : r(2) === 0 || later.length === 0 ? 'master' : later[r(later.length)]!;
					const sends =
						kind === 'master' || later.length === 0
							? []
							: Array.from({ length: r(3) }, (_, j) => ({
									id: `${id}snd${j}`,
									target: later[r(later.length)]!,
									levelDb: still(0),
									pan: 0,
									preFader: r(2) === 1,
								}));
					return strip(id, kind, { inserts, sends, output });
				});
				return { sampleRate: SR, masterFormat: 'stereo', strips, loudness: null } as RenderAudioMix;
			});
		fc.assert(
			fc.property(topology, (mix) => {
				const plan = planMixLatency(mix, latencyOf);
				expect(plan.total).toBe(exportLatency(mix));
				for (const s of mix.strips) {
					const p = plan.strips[s.id]!;
					if (s.output) {
						expect(p.outDelay).toBeGreaterThanOrEqual(0);
						expect(p.postLat + p.outDelay).toBe(plan.strips[s.output]!.inLat);
					}
					for (const x of s.sends) {
						const d = p.sendDelays[x.id]!;
						expect(d).toBeGreaterThanOrEqual(0);
						expect((x.preFader ? p.preLat : p.postLat) + d).toBe(plan.strips[x.target]!.inLat);
					}
				}
			}),
			{ numRuns: 200 },
		);
	});

	it('hostile latencies (NaN, negative, Infinity) count as 0; dangling and backward routes are ignored', () => {
		const mix: RenderAudioMix = {
			sampleRate: SR,
			masterFormat: 'stereo',
			strips: [
				strip('A1', 'track', {
					inserts: [fxLat('a', Number.NaN), fxLat('b', -5), fxLat('c', Number.POSITIVE_INFINITY)],
				}),
				strip('S1', 'submix', { output: 'nowhere' }),
				strip('S2', 'submix', { output: 'S1' }),
				strip('master', 'master'),
			],
			loudness: null,
		};
		const plan = planMixLatency(mix, latencyOf, Number.NaN);
		expect(plan.total).toBe(0);
		expect(plan.strips.S2!.outDelay).toBe(0);
		expect(Object.values(plan.strips).every((r) => Number.isFinite(r.postLat))).toBe(true);
	});

	it('each stage is evaluated at the time of the samples it processes (the export times)', () => {
		const mix: RenderAudioMix = {
			sampleRate: SR,
			masterFormat: 'stereo',
			strips: [
				strip('A1', 'track', { inserts: [fxLat('a', 480), fxLat('b', 960, true)] }),
				strip('master', 'master'),
			],
			loudness: null,
		};
		const plan = planMixLatency(mix, latencyOf);
		const fps = FLICKS_PER_SECOND / SR;
		const t = 1_000_000;
		// picture at t: sources play `total` (1440) samples ahead; A1's fader sees content 1440 − 480 ahead …
		expect(stripStageTimes(plan, 'A1', t, SR)).toEqual({
			preInserts: t + 1440 * fps,
			fader: t + 960 * fps,
			postInserts: t + 960 * fps,
			pan: t,
		});
		expect(stripStageTimes(plan, 'master', t, SR).fader).toBe(t);
		expect(stripStageTimes(plan, 'nope', t, SR).pan).toBe(t);
	});

	it('preview slot latency comes from the registered measurement; no slot or disabled = 0', () => {
		const offSlot = registerPreviewInsert(
			'test.latency',
			() => {
				throw new Error('not built in this test');
			},
			(e, sr) => ((e.params.samples?.value as number) * sr) / SR,
		);
		try {
			expect(previewInsertLatency(fxLat('a', 128), SR)).toBe(128);
			expect(previewInsertLatency(fxLat('a', 128), 96000)).toBe(256);
			expect(previewInsertLatency({ ...fxLat('a', 128), enabled: false }, SR)).toBe(0);
			expect(previewInsertLatency({ ...fxLat('a', 128), effectId: 'unknown.fx' }, SR)).toBe(0);
			expect(clipEffectsLatency([fxLat('a', 128), fxLat('b', 72)], SR)).toBe(200);
		} finally {
			offSlot();
		}
		expect(previewInsertLatency(fxLat('a', 128), SR)).toBe(0);
	});

	it("clip gain above Remotion's +24 dB volume limit is left to the graph (the export applies all of it)", () => {
		const clip = {
			duration: 30,
			sourceIn: 0,
			speed: { rate: 1, reverse: false, maintainPitch: false },
			gainDb: 30,
			volumeDb: still(0),
		} as Parameters<typeof clipGainExcess>[0];
		const fps = { num: 30, den: 1 };
		expect(20 * Math.log10(16 * clipGainExcess(clip, 5, fps))).toBeCloseTo(30, 9);
		expect(clipGainExcess({ ...clip, gainDb: 10 }, 5, fps)).toBe(1);
		expect(clipGainExcess({ ...clip, gainDb: Number.NaN }, 5, fps)).toBe(1);
	});
});
