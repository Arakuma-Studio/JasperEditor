// @vitest-environment node
// Sound design Phase 0 close-out: the preview mix graph at transport events, in Chrome's Web Audio (the real
// AudioWorklet effect slots), rendered offline and suspended at the event:
// - a seek: the graph's delay lines and effects are reset (`MixGraph.flush`), so nothing from before the seek is heard
//   after it (before: up to the read-ahead of old audio, and effect tails);
// - an edit that changes the latency during playback: the read-ahead is held, the audio in flight is kept (a longer
//   route delay inserts silence, a shorter one is padded at the Mix), and slots of unchanged effects keep running —
//   one gap of the added latency, then the new mix exactly, late by it (before: every clip's media player was
//   re-created; measured in the real app, e2e/sound-p0-transport.spec.ts, a gap of twice the added latency).
// The real-app counterpart, with Remotion's players and the primed start, is e2e/sound-p0-transport.spec.ts.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installAudioFxProcessors } from '@jasper/audio-fx';
import {
	AUDIO_EFFECTS,
	buildRenderSnapshot,
	type ClipReader,
	type EffectInstance,
	type RenderAudioClip,
	type RenderAudioMix,
	type RenderSnapshot,
	renderMixToBuffers,
	spanOf,
} from '@jasper/project';
import { bundleForBrowser, findChrome } from '@jasper/testkit/browser';
import { type Browser, chromium, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Harness } from '../../project/test/helpers.ts';

const here = dirname(fileURLToPath(import.meta.url));
const CHROME = findChrome();
const SR = 48000;
const LEN = Math.round(0.6 * SR);
/** The event: 0.3 s, on a render quantum. */
const AT = 112 * 128;
/** Hard Limiter latency at its defaults (look-ahead 7 ms + the true-peak oversampler). */
const HL = 374;

function noise(seed: number, n: number, amp = 0.25): number[] {
	let x = seed >>> 0 || 1;
	const out = new Array<number>(n);
	for (let i = 0; i < n; i++) {
		x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
		out[i] = ((x >>> 8) / (1 << 24) - 0.5) * 2 * amp;
	}
	return out;
}

function fx(effectId: string, id: string): EffectInstance {
	const spec = AUDIO_EFFECTS.find((s) => s.id === effectId)!;
	const params: EffectInstance['params'] = {};
	for (const p of spec.params) params[p.name] = { value: p.default, keyframes: [] };
	return { id, effectId, effectVersion: 1, enabled: true, params };
}
const limiter = (id: string) => fx('jasper.audio.hard-limiter', id);

type Case = { snapshot: RenderSnapshot; data: Map<string, number[][]> };

/** Two tracks of noise from frame 3 (0.1 s); `a1` / `mix`: the A1 and Mix inserts. */
function scene(a1: EffectInstance[], mix: EffectInstance[] = []): Case {
	const h = new Harness();
	const media = [0, 1].map(() => h.registerVideo({ kind: 'audio', seconds: 4 }));
	while (h.seq.audioTracks.length < 2) h.ok([{ type: 'track.add', kind: 'audio' }]);
	h.ok(
		media.map((m, i) => ({
			type: 'clip.place',
			source: { mediaId: m },
			at: 3,
			tracks: { audio: `A${i + 1}` },
		})),
	);
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
	withInserts(snapshot.audioMix!, a1, mix);
	const data = new Map<string, number[][]>();
	snapshot.audioClips.forEach((c, i) => {
		const [s0, s1] = spanOf(c, snapshot.settings.fps, SR);
		const n = Math.min(s1 - s0, 2 * LEN);
		data.set(c.clipId, [noise(10 + i, n), noise(20 + i, n)]);
	});
	return { snapshot, data };
}

function withInserts(
	mix: RenderAudioMix,
	a1: EffectInstance[],
	master: EffectInstance[] = [],
): RenderAudioMix {
	mix.strips.find((s) => s.label === 'A1')!.inserts = a1;
	mix.strips.find((s) => s.label === 'Mix')!.inserts = master;
	return mix;
}

/** The same mix with other inserts (a new object, as an edit produces). */
function edited(mix: RenderAudioMix, a1: EffectInstance[], master: EffectInstance[] = []): RenderAudioMix {
	return withInserts(JSON.parse(JSON.stringify(mix)) as RenderAudioMix, a1, master);
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

/** Longest run of exact zeros (both channels) in [from, to): a gap in noise. */
function longestGap(p: number[][], from: number, to: number): number {
	let best = 0;
	let run = 0;
	for (let i = from; i < to; i++) {
		if (p[0]![i] === 0 && p[1]![i] === 0) best = Math.max(best, ++run);
		else run = 0;
	}
	return best;
}

function peak(p: number[][], from: number, to: number): number {
	let m = 0;
	for (const ch of p) for (let i = from; i < to; i++) m = Math.max(m, Math.abs(ch[i]!));
	return m;
}

describe.runIf(!!CHROME)(
	'preview mix graph at transport events (headless Chrome)',
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

		type Result = {
			channels: number[][];
			readAhead: { before: number; after: number; paused: number };
		};

		async function run(c: Case, action: 'flush' | 'none' | 'live', next?: RenderAudioMix): Promise<Result> {
			const fps = c.snapshot.settings.fps;
			return page.evaluate(
				(spec) =>
					(window as unknown as { __mix: { transport: (s: unknown) => Promise<unknown> } }).__mix.transport(
						spec,
					),
				{
					workletUrl,
					mix: c.snapshot.audioMix,
					...(next ? { next } : {}),
					clips: c.snapshot.audioClips.map((clip) => ({
						clip,
						data: c.data.get(clip.clipId)!,
						s0: spanOf(clip, fps, SR)[0],
						volume: 1,
					})),
					fps,
					length: LEN,
					at: AT,
					action,
				},
			) as Promise<Result>;
		}

		async function exported(c: Case, mix: RenderAudioMix) {
			return renderMixToBuffers({
				snapshot: { ...c.snapshot, audioMix: mix },
				openClip: reader(c.data),
				startSample: 0,
				length: LEN,
				outputLayout: 'stereo',
			});
		}

		/** Worst |preview[i] − export[i − lag]| over [from, LEN). */
		function worst(p: number[][], e: Float32Array[], from: number, lag = 0): number {
			let w = 0;
			for (let c = 0; c < 2; c++)
				for (let i = from; i < LEN; i++) w = Math.max(w, Math.abs(p[c]![i]! - e[c]![i - lag]!));
			return w;
		}

		it('a seek flushes what the graph holds: nothing of the old position after it (delay lines and a reverb tail)', async () => {
			// A1: Hard Limiter; Mix: Hard Limiter + Convolution Reverb (a tail of its impulse)
			const c = scene([limiter('fx_a')], [limiter('fx_m'), fx('jasper.audio.convolution-reverb', 'fx_r')]);
			const [stale, flushed] = await Promise.all([run(c, 'none'), run(c, 'flush')]);
			expect(stale.readAhead.before).toBe(2 * HL + 256);
			// the sources stop at the seek: without the flush the graph plays on (the read-ahead, then the reverb tail)
			expect(peak(stale.channels, AT + 128, AT + 1004)).toBeGreaterThan(0.01);
			expect(peak(stale.channels, AT + 1004 + 128, LEN)).toBeGreaterThan(1e-4);
			// flushed: silence from the next render quantum on
			expect(peak(flushed.channels, AT + 128, LEN)).toBe(0);
			// and the graph was playing up to the seek
			expect(peak(flushed.channels, AT - 4800, AT)).toBeGreaterThan(0.05);
		});

		it('an insert added during playback: one gap of its latency, the read-ahead held, then the new mix late by it', async () => {
			const c = scene([limiter('fx_a')]);
			const next = edited(c.snapshot.audioMix!, [limiter('fx_a'), limiter('fx_b')]);
			const [p, e1] = await Promise.all([run(c, 'live', next), exported(c, next)]);
			// held while playing; the plan's once paused
			expect(p.readAhead).toEqual({ before: HL, after: HL, paused: 2 * HL });
			// the limiter already in A1 keeps running and A2's delay line keeps its audio: the gap is the added latency
			// (re-created slots and delay lines would give twice that)
			const gap = longestGap(p.channels, AT, AT + 4 * HL);
			expect(gap).toBeGreaterThanOrEqual(HL - 128);
			expect(gap).toBeLessThanOrEqual(HL + 128);
			// right after it: the new mix exactly, `HL` samples late (the picture is not followed until playback stops).
			// Exact from the end of the gap only because nothing in flight was dropped.
			expect(worst(p.channels, e1, AT + HL + 128, HL)).toBeLessThan(1e-4);
		});

		it('a track added during playback (Hear proposal, an agent): every strip keeps its state, nothing is lost', async () => {
			// Sound design Phase 6: a new strip changed the graph's topology, which rebuilt every strip — the audio in
			// A1's and the Mix's limiters and in the route delays was dropped (a gap of up to the read-ahead).
			const c = scene([limiter('fx_a')], [limiter('fx_m')]);
			const next = JSON.parse(JSON.stringify(c.snapshot.audioMix)) as RenderAudioMix;
			const a2 = next.strips.find((x) => x.label === 'A2')!;
			next.strips.splice(next.strips.indexOf(a2) + 1, 0, {
				...a2,
				id: 'trk_new',
				label: 'A3',
				name: 'A3',
				inserts: [],
			});
			const [p, e] = await Promise.all([run(c, 'live', next), exported(c, c.snapshot.audioMix!)]);
			expect(longestGap(p.channels, AT, AT + 8 * HL)).toBe(0);
			expect(worst(p.channels, e, 0)).toBeLessThan(1e-4);
		});

		it('an insert removed during playback: the Mix is padded to the held read-ahead and stays aligned', async () => {
			const c = scene([limiter('fx_a'), limiter('fx_b')]);
			const next = edited(c.snapshot.audioMix!, [limiter('fx_a')]);
			const [p, e1] = await Promise.all([run(c, 'live', next), exported(c, next)]);
			expect(p.readAhead).toEqual({ before: 2 * HL, after: 2 * HL, paused: HL });
			// what the removed limiter held is gone (one gap of it), then the new mix, aligned with the picture
			expect(longestGap(p.channels, AT, AT + 4 * HL)).toBeLessThanOrEqual(HL + 128);
			expect(worst(p.channels, e1, AT + HL + 128)).toBeLessThan(1e-4);
		});
	},
);
