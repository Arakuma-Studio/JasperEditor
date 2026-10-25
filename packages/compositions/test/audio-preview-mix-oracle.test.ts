// @vitest-environment node
// Sound design Phase 4 "Done when" (spec 12): the export matches the preview mix, sample by sample, for a mix made by
// the Phase 4 commands — the masking solver's clip gain (`soundDesign.applyGains`), room glue (`soundDesign.ensureBus`:
// a post-fader send into the "SFX Room" submix with its Studio Reverb), a stop-before dip and a build sweep
// (`soundDesign.applyStopBefore` / `applyBuild`: keyframed volume and a keyframed Scientific Filter cutoff). The
// preview is the real MixGraph with the AudioWorklet effect slots in headless Chrome, driven the way the player drives
// it WHILE PLAYING (one `graph.update` and one Remotion per-clip gain per picture frame, `entry.ts` `played`); the
// export is the OfflineMixer every export path runs (`renderMixToBuffers`).
//   - "track": the music alone on its track → the dip on the track's volume lane, the build as a track insert;
//   - "clip": the music shares its track with dialogue over the cue → the dip as clip Volume keyframes and the build as
//     a clip effect (the graph applies a clip with effects' levels after its slots).
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installAudioFxProcessors } from '@jasper/audio-fx';
import {
	type Animatable,
	audioFadeGain,
	buildRenderSnapshot,
	type ClipReader,
	FLICKS_PER_SECOND,
	fadeCurve,
	fadeShapeGain,
	type RenderAudioClip,
	type RenderSnapshot,
	renderMixToBuffers,
	spanOf,
} from '@jasper/project';
import { bundleForBrowser, findChrome } from '@jasper/testkit/browser';
import { type Browser, chromium, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Harness } from '../../project/test/helpers.ts';
import { clipLevelAt, graphAppliesLevels } from '../src/audio/graph.ts';

const here = dirname(fileURLToPath(import.meta.url));
const CHROME = findChrome();
const SR = 48000;
const FPS = 30;
const S = FLICKS_PER_SECOND;
/**
 * Everything starts at frame 3 (0.1 s): a clip starting with the render would meet the graph's nodes settling (the
 * static oracle does the same). The hero cue at frame 33 (1.1 s): stop-before 0.25 s at −24 dB, build 0.5 s
 * 150 → 2000 Hz.
 */
const OFF = 3;
const HERO = 33;
const LEN = Math.round(1.8 * SR);

function noise(seed: number, n: number, amp: number, env?: (i: number) => number): number[] {
	let x = seed >>> 0 || 1;
	const out = new Array<number>(n);
	for (let i = 0; i < n; i++) {
		x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
		out[i] = ((x >>> 8) / (1 << 24) - 0.5) * 2 * amp * (env ? env(i) : 1);
	}
	return out;
}

type Case = {
	snapshot: RenderSnapshot;
	data: Map<string, number[][]>;
	results: Record<string, unknown>[];
};

function scene(kind: 'track' | 'clip'): Case {
	const h = new Harness();
	const music = h.registerVideo({ kind: 'audio', seconds: 4 });
	const hit = h.registerVideo({ kind: 'audio', seconds: 1 });
	const voice = h.registerVideo({ kind: 'audio', seconds: 2 });
	while (h.seq.audioTracks.length < 2) h.ok([{ type: 'track.add', kind: 'audio' }]);
	const place = (m: string, at: number, track: string, ref: string, out?: number) => ({
		type: 'clip.place',
		source: { mediaId: m },
		...(out !== undefined ? { sourceRange: { in: { flicks: 0 }, out: { flicks: out * (S / FPS) } } } : {}),
		at,
		tracks: { audio: track },
		ref,
	});
	const cmds: unknown[] = [
		// the clip track: music until frame 29, then dialogue on the same track over the cue
		place(music, OFF, 'A1', '$music', kind === 'clip' ? 29 : undefined),
		place(hit, OFF + 27, 'A2', '$hit'),
		{ type: 'essentialSound.setType', clipIds: ['$music'], audioType: 'music' },
		{ type: 'essentialSound.setType', clipIds: ['$hit'], audioType: 'sfx' },
	];
	if (kind === 'clip')
		cmds.push(place(voice, OFF + 29, 'A1', '$voice'), {
			type: 'essentialSound.setType',
			clipIds: ['$voice'],
			audioType: 'dialogue',
		});
	cmds.push(
		{
			type: 'soundCue.add',
			cues: [
				{
					frame: HERO,
					kind: 'land',
					weight: 'hero',
					source: 'user',
					ref: '$cue',
					stopBefore: { seconds: 0.25, depthDb: -24 },
					build: { seconds: 0.5, fromHz: 150, toHz: 2000 },
				},
			],
		},
		{ type: 'soundDesign.applyGains', gains: { $hit: -7.25 } },
		{ type: 'soundDesign.ensureBus' },
		{ type: 'soundDesign.applyStopBefore', cueId: '$cue' },
		{ type: 'soundDesign.applyBuild', cueId: '$cue' },
	);
	const r = h.ok(cmds);
	const results = r.results.slice(-4) as Record<string, unknown>[];
	const snapshot = buildRenderSnapshot(h.doc, h.seqId, {
		resolveMedia: (a) => ({
			url: a.id,
			proxyUrl: null,
			kind: a.kind,
			width: null,
			height: null,
			durationFlicks: a.probe.durationFlicks,
			hasAudio: true,
			rotation: 0,
		}),
		resolveFont: () => null,
	});
	const data = new Map<string, number[][]>();
	const hitId = r.refs.$hit!;
	snapshot.audioClips.forEach((c, i) => {
		const [s0, s1] = spanOf(c, snapshot.settings.fps, SR);
		const n = Math.min(s1 - s0, LEN);
		// the hit: a noise burst with a 60 ms decay; the music and the voice: steady noise
		const env = c.clipId === hitId ? (k: number) => Math.exp(-k / (0.06 * SR)) : undefined;
		const amp = c.clipId === hitId ? 0.6 : 0.2;
		data.set(c.clipId, [noise(10 + i, n, amp, env), noise(20 + i, n, amp, env)]);
	});
	return { snapshot, data, results };
}

/** A keyframe (bezier with Premiere's default ease-in / ease-out influence, or linear). */
function key(time: number, value: number, interpolation: 'bezier' | 'linear' = 'bezier') {
	const ease = { influence: 1 / 3, slope: 0 };
	return { id: `k${time}_${value}`, time, value, interpolation, easeIn: ease, easeOut: ease };
}
const lane = (...keys: ReturnType<typeof key>[]): Animatable<number> => ({
	value: keys[0]!.value,
	keyframes: keys,
});

/**
 * Sound design Phase 6: whooshes panned by fast sweeps (the placement's keyframed whoosh pans, and pan automation in
 * general). A1 (mono track): the strip's pan −100 → +100 in 0.4 s, back to −60; A2: the clip's own pan keyframes
 * (content time) and a post-fader send into the 5.1 submix S1 with A2's 5.1 puck sweeping; A3: output into S1 with its
 * puck sweeping (x, y, centre); S1 (5.1) → the stereo Mix, its own pan sweeping (balance after the fold).
 */
function panScene(): Case {
	const h = new Harness();
	const media = [0, 1, 2].map(() => h.registerVideo({ kind: 'audio', seconds: 4 }));
	while (h.seq.audioTracks.length < 3) h.ok([{ type: 'track.add', kind: 'audio' }]);
	h.ok(
		media.map((m, i) => ({
			type: 'clip.place',
			source: { mediaId: m },
			at: OFF,
			tracks: { audio: `A${i + 1}` },
		})),
	);
	h.ok([{ type: 'mixer.addSubmix' }]);
	const s1 = h.seq.submixTracks![0]!.id;
	h.ok([
		{ type: 'mixer.updateStrip', stripId: 'A1', patch: { channelFormat: 'mono' } },
		{ type: 'mixer.updateStrip', stripId: 'S1', patch: { channelFormat: '5.1' } },
		{ type: 'mixer.updateStrip', stripId: 'A3', patch: { output: 'S1' } },
		{ type: 'mixer.addSend', stripId: 'A2', target: s1, preFader: false, levelDb: -3 },
	]);
	const snapshot = buildRenderSnapshot(h.doc, h.seqId, {
		resolveMedia: (a) => ({
			url: a.id,
			proxyUrl: null,
			kind: a.kind,
			width: null,
			height: null,
			durationFlicks: a.probe.durationFlicks,
			hasAudio: true,
			rotation: 0,
		}),
		resolveFont: () => null,
	});
	const mix = snapshot.audioMix!;
	const strip = (l: string) => mix.strips.find((s) => s.label === l)!;
	const sec = (x: number) => Math.round(x * S);
	strip('A1').pan = lane(key(sec(0.25), -100), key(sec(0.65), 100), key(sec(0.9), -60, 'linear'));
	const a2 = strip('A2');
	a2.pan51.x = lane(key(sec(0.4), -100), key(sec(0.8), 100));
	a2.pan51.y = lane(key(sec(0.4), 100, 'linear'), key(sec(0.8), -100, 'linear'));
	const a3 = strip('A3');
	a3.pan51.x = lane(key(sec(0.2), 100), key(sec(0.7), -100));
	a3.pan51.y = lane(key(sec(0.3), -100), key(sec(0.6), 60));
	a3.pan51.center = lane(key(sec(0.2), 0, 'linear'), key(sec(0.8), 100, 'linear'));
	strip('S1').pan = lane(key(sec(0.5), 80), key(sec(0.75), -80));
	// A2's clip: its own pan, content time (the clip starts at frame OFF with sourceIn 0)
	const clip2 = snapshot.audioClips.find((c) => c.trackId === a2.id)!;
	clip2.pan = lane(key(sec(0.1), -100), key(sec(0.4), 100), key(sec(0.6), 0));
	const data = new Map<string, number[][]>();
	snapshot.audioClips.forEach((c, i) => {
		const [s0, s1end] = spanOf(c, snapshot.settings.fps, SR);
		const n = Math.min(s1end - s0, LEN);
		// a whoosh: noise under a 0.9 s sin² swell
		const env = (k: number) => Math.sin(Math.min(1, k / (0.9 * SR)) * Math.PI) ** 2;
		data.set(c.clipId, [noise(30 + i, n, 0.3, env), noise(40 + i, n, 0.3, env)]);
	});
	return { snapshot, data, results: [] };
}

/**
 * Premiere port (audio crossfades): A1 — clip A (frames 3…21) and clip B (21…45) joined by an asymmetrical,
 * off-centre Custom Fade (span [18, 30): 3 frames before the cut; fade in Cosine @ 30, fade out Linear @ −10); A2 —
 * clip C (30…50) with an Exponential Fade in and a Constant Power fade out of 6 frames. A plays on the left channel
 * only, B on the right only, C on the left only, so each fade's envelope can be read from the mix.
 */
function crossfadeScene(): Case & { ids: { a: string; b: string; c: string } } {
	const h = new Harness();
	const media = [0, 1, 2].map(() => h.registerVideo({ kind: 'audio', seconds: 4 }));
	while (h.seq.audioTracks.length < 2) h.ok([{ type: 'track.add', kind: 'audio' }]);
	const F = S / FPS;
	const place = (m: string, at: number, inF: number, outF: number, track: string, ref: string) => ({
		type: 'clip.place',
		source: { mediaId: m },
		sourceRange: { in: { flicks: inF * F }, out: { flicks: outF * F } },
		at,
		tracks: { audio: track },
		ref,
	});
	const r = h.ok([
		place(media[0]!, OFF, 6, 24, 'A1', '$a'),
		place(media[1]!, 21, 15, 39, 'A1', '$b'),
		place(media[2]!, 30, 0, 20, 'A2', '$c'),
	]);
	const ids = { a: r.refs.$a!, b: r.refs.$b!, c: r.refs.$c! };
	h.ok([
		{
			type: 'transition.add',
			trackId: h.seq.audioTracks[0]!.id,
			at: 21,
			effectId: 'jasper.custom-fade',
			duration: 12,
			cutOffset: 3,
			params: {
				fadeShape: 'cosine',
				fadeValue: 30,
				symmetry: 'asymmetric',
				outFadeShape: 'linear',
				outFadeValue: -10,
			},
		},
		{ type: 'transition.add', clipId: ids.c, edge: 'in', effectId: 'jasper.exponential-fade', duration: 6 },
		{ type: 'transition.add', clipId: ids.c, edge: 'out', effectId: 'jasper.constant-power', duration: 6 },
	]);
	const snapshot = buildRenderSnapshot(h.doc, h.seqId, {
		resolveMedia: (a) => ({
			url: a.id,
			proxyUrl: null,
			kind: a.kind,
			width: null,
			height: null,
			durationFlicks: a.probe.durationFlicks,
			hasAudio: true,
			rotation: 0,
		}),
		resolveFont: () => null,
	});
	const data = new Map<string, number[][]>();
	snapshot.audioClips.forEach((c, i) => {
		const [s0, s1] = spanOf(c, snapshot.settings.fps, SR);
		const n = Math.min(s1 - s0, LEN);
		const sig = noise(50 + i, n, 0.4);
		const zero = new Array<number>(n).fill(0);
		data.set(c.clipId, c.clipId === ids.b ? [zero, sig] : [sig, zero]);
	});
	return { snapshot, data, results: [], ids };
}

function reader(data: Map<string, number[][]>) {
	return (clip: RenderAudioClip, at: { offset: number; length: number }): ClipReader => {
		const d = data.get(clip.clipId)!;
		let pos = at.offset;
		const end = at.offset + at.length;
		return {
			channels: d.length,
			read(out, frames) {
				const n = Math.max(0, Math.min(frames, end - pos, d[0]!.length - pos));
				for (let c = 0; c < d.length; c++) for (let i = 0; i < n; i++) out[c]![i] = d[c]![pos + i]!;
				pos += n;
				return n;
			},
			close() {},
		};
	};
}

/** RMS in dB of x over [a, b) samples. */
function rmsDb(x: ArrayLike<number>, a0: number, b0: number): number {
	const a = Math.round(a0);
	const b = Math.round(b0);
	let e = 0;
	for (let i = a; i < b; i++) e += x[i]! * x[i]!;
	return 10 * Math.log10(Math.max(1e-30, e / Math.max(1, b - a)));
}

describe.runIf(!!CHROME)(
	'Phase 4 mix: preview while playing = export, sample for sample (headless Chrome, Web Audio)',
	{ timeout: 300_000 },
	() => {
		let browser: Browser;
		let page: Page;
		let workletUrl: string;

		beforeAll(async () => {
			installAudioFxProcessors();
			const [entry, worklet] = await Promise.all([
				bundleForBrowser(join(here, 'audio-oracle', 'entry.ts')),
				bundleForBrowser(join(here, '..', 'src', 'audio', 'worklet.ts')),
			]);
			browser = await chromium.launch({
				executablePath: CHROME ?? undefined,
				args: ['--autoplay-policy=no-user-gesture-required'],
			});
			page = await browser.newPage();
			await page.route('http://localhost/oracle', (r) =>
				r.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }),
			);
			await page.goto('http://localhost/oracle');
			await page.addScriptTag({ content: entry });
			workletUrl = await page.evaluate(
				(code) => URL.createObjectURL(new Blob([code], { type: 'text/javascript' })),
				worklet,
			);
		}, 120_000);

		afterAll(async () => {
			await browser?.close();
		});

		async function preview(c: Case) {
			const fps = c.snapshot.settings.fps;
			return page.evaluate(
				(spec) =>
					(window as unknown as { __mix: { played: (s: unknown) => Promise<unknown> } }).__mix.played(spec),
				{
					workletUrl,
					mix: c.snapshot.audioMix,
					clips: c.snapshot.audioClips.map((clip) => ({
						clip,
						data: c.data.get(clip.clipId)!,
						s0: spanOf(clip, fps, SR)[0],
						volume: graphAppliesLevels(clip) ? 1 : clipLevelAt(clip, 0, fps),
					})),
					fps,
					fpsValue: fps.num / fps.den,
					length: LEN,
				},
			) as Promise<{ channels: number[][]; latency: number }>;
		}

		function exported(c: Case) {
			return renderMixToBuffers({
				snapshot: c.snapshot,
				openClip: reader(c.data),
				startSample: 0,
				length: LEN,
				outputLayout: 'stereo',
			});
		}

		/** Worst |preview − export| over [from, to) (both channels) and the export's peak there. */
		function worst(p: number[][], e: Float32Array[], from0: number, to0: number) {
			const from = Math.round(from0);
			const to = Math.round(to0);
			let w = 0;
			let at = from;
			let peak = 0;
			for (let c = 0; c < 2; c++)
				for (let i = from; i < to; i++) {
					const d = Math.abs(p[c]![i]! - e[c]![i]!);
					if (d > w) {
						w = d;
						at = i;
					}
					peak = Math.max(peak, Math.abs(e[c]![i]!));
				}
			return { worst: w, at: at / SR, peak };
		}

		for (const kind of ['track', 'clip'] as const)
			it(`${kind}: solver gain, room send, stop-before dip and build sweep`, async () => {
				const c = scene(kind);
				// what the commands wrote
				const [, room, stop, build] = c.results as [
					unknown,
					{ sends: unknown[] },
					{ writes: { target: string }[] },
					{ writes: { target: string }[] },
				];
				expect(room.sends.length).toBe(1);
				expect(stop.writes[0]!.target).toBe(kind === 'track' ? 'trackVolume' : 'clipVolume');
				expect(build.writes[0]!.target).toBe(kind === 'track' ? 'trackFilter' : 'clipFilter');
				const e = await exported(c);
				const p = await preview(c);
				const T = (HERO / FPS) * SR;
				// the export does what the commands say: −24 dB under the dip (music alone, before the hit at 0.9 s)
				const music0 = rmsDb(e[0]!, 0.2 * SR, 0.5 * SR);
				const dipped = rmsDb(e[0]!, T - 0.22 * SR, T - 0.12 * SR);
				const report: Record<string, unknown> = { kind, music0, dipDb: dipped - music0 };
				const all = worst(p.channels, e, 0, LEN);
				const regions = {
					before: worst(p.channels, e, 0, 0.55 * SR),
					build: worst(p.channels, e, 0.55 * SR, T - 0.3 * SR),
					dip: worst(p.channels, e, T - 0.3 * SR, T + 0.05 * SR),
					after: worst(p.channels, e, T + 0.05 * SR, LEN),
				};
				Object.assign(report, { all, regions, latency: p.latency });
				console.log(JSON.stringify(report));
				expect(all.peak).toBeGreaterThan(0.05);
				expect(Math.abs(dipped - music0 + 24)).toBeLessThan(0.5);
				// float32 Web Audio vs the float32 mixer, as the static oracle (audio-preview-oracle.test.ts). Measured
				// 1.4e-5 for both scenes; before the graph followed automation sample by sample (frame steps, 8 ms
				// smoothing, keyframes once per frame in the effect slots) 0.19 (track) and 0.15 (clip).
				expect(all.worst).toBeLessThan(1e-4);
				expect(regions.dip.worst).toBeLessThan(1e-4);
				expect(regions.build.worst).toBeLessThan(1e-4);
				expect(regions.after.worst).toBeLessThan(1e-4);
			});

		it('audio crossfades: an asymmetrical off-centre Custom Fade, Exponential / Constant Power fades', async () => {
			const c = crossfadeScene();
			const e = await exported(c);
			const p = await preview(c);
			const all = worst(p.channels, e, 0, LEN);
			const span = worst(p.channels, e, 18 * 1600, 30 * 1600);
			const fades = worst(p.channels, e, 30 * 1600, 50 * 1600);
			// The export's envelope is the curve model's: sample i of a clip = gain(i) × its source sample.
			const clip = (id: string) => c.snapshot.audioClips.find((x) => x.clipId === id)!;
			const fps = c.snapshot.settings.fps;
			let envelope = 0;
			const check = (id: string, ch: number, from: number, to: number) => {
				const k = clip(id);
				const s0 = spanOf(k, fps, SR)[0];
				const src = c.data.get(id)![ch]!;
				for (let i = from * 1600; i < to * 1600; i++)
					envelope = Math.max(
						envelope,
						Math.abs(e[ch]![i]! - audioFadeGain(k.fades, i / 1600) * src[i - s0]!),
					);
			};
			check(c.ids.a, 0, 18, 30);
			check(c.ids.b, 1, 18, 30);
			check(c.ids.c, 0, 30, 50);
			// …and the fades are the ones asked for (midpoint of the crossfade: frame 24; C's fades).
			const a = clip(c.ids.a);
			const b = clip(c.ids.b);
			const cc = clip(c.ids.c);
			expect(audioFadeGain(a.fades, 24)).toBeCloseTo(fadeShapeGain({ type: 'linear', value: -10 }, 0.5), 12);
			expect(audioFadeGain(b.fades, 24)).toBeCloseTo(fadeShapeGain({ type: 'cosine', value: 30 }, 0.5), 12);
			expect(audioFadeGain(a.fades, 18)).toBe(1);
			expect(audioFadeGain(b.fades, 30)).toBe(1);
			expect(audioFadeGain(cc.fades, 33)).toBeCloseTo(fadeCurve('exponential', 0.5), 12);
			expect(audioFadeGain(cc.fades, 47)).toBeCloseTo(fadeCurve('equal-power', 0.5), 12);
			console.log(JSON.stringify({ crossfades: { all, span, fades, envelope, latency: p.latency } }));
			expect(all.peak).toBeGreaterThan(0.1);
			expect(envelope).toBeLessThan(1e-6);
			// preview while playing = export, float32 against float32 (as the other scenes)
			expect(span.worst).toBeLessThan(1e-4);
			expect(fades.worst).toBeLessThan(1e-4);
			expect(all.worst).toBeLessThan(1e-4);
		});

		it('pan sweeps: strip pan, clip pan, the 5.1 puck of a track and of a send, a 5.1 submix pan', async () => {
			const c = panScene();
			const e = await exported(c);
			const p = await preview(c);
			const all = worst(p.channels, e, 0, LEN);
			const sweep = worst(p.channels, e, 0.2 * SR, 0.95 * SR);
			console.log(JSON.stringify({ pan: { all, sweep, latency: p.latency } }));
			expect(all.peak).toBeGreaterThan(0.1);
			// Measured 1.8e-5. Before (pan, puck and send pans set once per picture frame with the 8 ms glide; the export's
			// puck held for 32 samples): 0.34. Fixed on the way: a curve started right after a set glided from the param's
			// stale value (1.1e-2), cancelling the ramp in progress made Chrome play one frame at the previous point's value
			// (7.5e-4), and the 5.1 panner's square-root centre gain needs one-sample pieces at x = 0 (4.6e-4).
			expect(sweep.worst).toBeLessThan(1e-4);
			expect(all.worst).toBeLessThan(1e-4);
		});
	},
);
