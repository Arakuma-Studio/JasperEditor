// @vitest-environment node
// WP0.1 (spec 12 Phase 0) oracle: the preview mix (MixGraph + AudioWorklet effect slots in Chrome's Web Audio,
// rendered offline) must equal the export mixer (OfflineMixer, every export path) sample by sample when track,
// submix, Mix and clip effects add latency. Before the fix the preview did not delay the other paths nor read ahead,
// so a 2048-sample track insert put that track 43 ms late against the rest of the mix and the picture.
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
import { clipHasEffects } from '../src/audio/graph.ts';
import { MAX_PREVIEW_GAIN } from '../src/pipeline.ts';

const here = dirname(fileURLToPath(import.meta.url));
const CHROME = findChrome();
const SR = 48000;
const LEN = Math.round(0.6 * SR);
/** Clips start after the playback start (frame 3 = 0.1 s), so the early-scheduled sources play whole. */
const AT = 3;

function noise(seed: number, n: number, amp = 0.25): number[] {
	let x = seed >>> 0 || 1;
	const out = new Array<number>(n);
	for (let i = 0; i < n; i++) {
		x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
		out[i] = ((x >>> 8) / (1 << 24) - 0.5) * 2 * amp;
	}
	return out;
}

function fx(effectId: string, id: string, postFader = false): EffectInstance {
	const spec = AUDIO_EFFECTS.find((s) => s.id === effectId)!;
	const params: EffectInstance['params'] = {};
	for (const p of spec.params) params[p.name] = { value: p.default, keyframes: [] };
	return { id, effectId, effectVersion: 1, enabled: true, params, ...(postFader ? { postFader: true } : {}) };
}

type Case = { snapshot: RenderSnapshot; data: Map<string, number[][]> };

/** Three tracks of noise, a stereo and a 5.1 submix, sends, and inserts / clip effects with latency. */
/**
 * `exact`: sample-based latency effects (Hard Limiter 374, Convolution Reverb 256 — the output does not depend on where
 * the stream started). `stft`: frame-based ones (FFT Filter 2048, Click Remover 640): their output near an onset
 * depends on the STFT frame phase, i.e. on where processing started (the same holds between two exports with
 * different range starts), so only the steady state is sample-identical.
 */
function scene(opts: { set: 'exact' | 'stft'; loudness?: boolean }): Case {
	const h = new Harness();
	const media = [0, 1, 2].map(() => h.registerVideo({ kind: 'audio', seconds: 4 }));
	while (h.seq.audioTracks.length < 3) h.ok([{ type: 'track.add', kind: 'audio' }]);
	h.ok(
		media.map((m, i) => ({
			type: 'clip.place',
			source: { mediaId: m },
			at: AT,
			tracks: { audio: `A${i + 1}` },
		})),
	);
	h.ok([{ type: 'mixer.addSubmix' }, { type: 'mixer.addSubmix' }]);
	const [s1, s2] = h.seq.submixTracks!.map((t) => t.id);
	h.ok([
		{ type: 'mixer.updateStrip', stripId: 'S2', patch: { channelFormat: '5.1' } },
		{ type: 'mixer.updateStrip', stripId: 'A1', patch: { output: 'S1' } },
		{ type: 'mixer.updateStrip', stripId: 'S1', patch: { volumeDb: -3 } },
		{ type: 'mixer.addSend', stripId: 'A2', target: s1, preFader: true, levelDb: -6 },
		{ type: 'mixer.addSend', stripId: 'A2', target: s2, preFader: false, levelDb: -4 },
		{ type: 'mixer.setLane', stripId: 'A2', lane: 'pan51.x', value: -80 },
		{ type: 'mixer.setLane', stripId: 'A2', lane: 'pan51.y', value: -60 },
		{ type: 'mixer.updateStrip', stripId: 'A3', patch: { pan: 40 } },
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
	const byLabel = (l: string) => mix.strips.find((s) => s.label === l)!;
	// A1: a pre-fader insert; S1: Hard Limiter (374) post-fader; Mix: Convolution Reverb (256).
	const a1 = opts.set === 'exact' ? 'jasper.audio.hard-limiter' : 'jasper.audio.fft-filter';
	byLabel('A1').inserts = [fx(a1, 'fx_a1')];
	byLabel('S1').inserts = [fx('jasper.audio.hard-limiter', 'fx_s1', true)];
	byLabel('Mix').inserts = [fx('jasper.audio.convolution-reverb', 'fx_mix')];
	// A3's clip: a clip effect (clip effect latency was compensated before this fix too).
	const a3 = byLabel('A3').id;
	const clip3 = snapshot.audioClips.find((c) => c.trackId === a3)!;
	const c3 = opts.set === 'exact' ? 'jasper.audio.hard-limiter' : 'jasper.audio.click-remover';
	clip3.effects = [fx(c3, 'fx_c3')];
	// A2 and A3: +30 dB Audio Gain on quiet sources (above Remotion's +24 dB volume limit; A3 with a clip effect)
	const quiet = new Set<string>();
	for (const label of ['A2', 'A3']) {
		const clip = snapshot.audioClips.find((c) => c.trackId === byLabel(label).id)!;
		clip.gainDb = 30;
		quiet.add(clip.clipId);
	}
	if (opts.loudness)
		(mix as { loudness: RenderAudioMix['loudness'] }).loudness = { gainDb: -6, truePeakDb: -1 };
	const data = new Map<string, number[][]>();
	snapshot.audioClips.forEach((c, i) => {
		const [s0, s1end] = spanOf(c, snapshot.settings.fps, SR);
		const n = Math.min(s1end - s0, 2 * LEN);
		const amp = quiet.has(c.clipId) ? 0.25 * 10 ** (-30 / 20) : 0.25;
		data.set(c.clipId, [noise(10 + i, n, amp), noise(20 + i, n, amp)]);
	});
	return { snapshot, data };
}

/**
 * Two mono clips on stereo tracks (Modify ▸ Audio Channels: one channel each) of a sequence at the −3 dB mono clip pan
 * law: one centred, one panned 40 right. The preview and the export both pan them with the constant-power law.
 */
function monoScene(): Case {
	const h = new Harness();
	const m = h.registerVideo({ kind: 'audio', seconds: 4 });
	h.ok([
		{
			type: 'clip.place',
			source: { mediaId: m },
			at: AT,
			tracks: { audio: 'A1' },
			audioMapping: 'mono-per-channel',
		},
	]);
	const right = Object.values(h.seq.clips).find((c) => c.trackId === h.seq.audioTracks[1]!.id)!;
	h.ok([{ type: 'param.set', target: ['clip', right.id, 'pan'], value: 40 }]);
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
		// each clip reads a mono stream of its own (the preview selects from the stream, the export reads it mapped)
		Object.assign(c, { channels: { streamIndex: 0, map: [0] }, streamChannels: 1 });
		const [s0, s1end] = spanOf(c, snapshot.settings.fps, SR);
		data.set(c.clipId, [noise(30 + i, Math.min(s1end - s0, 2 * LEN))]);
	});
	return { snapshot, data };
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

describe.runIf(!!CHROME)(
	'preview mix = export mix with latency (headless Chrome, Web Audio)',
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
			// a secure origin for AudioWorklet
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

		async function preview(c: Case, before?: RenderAudioMix) {
			const fps = c.snapshot.settings.fps;
			return page.evaluate(
				(spec) =>
					(window as unknown as { __mix: { render: (s: unknown) => Promise<unknown> } }).__mix.render(spec),
				{
					workletUrl,
					mix: c.snapshot.audioMix,
					...(before ? { before } : {}),
					clips: c.snapshot.audioClips.map((clip) => ({
						clip,
						data: c.data.get(clip.clipId)!,
						s0: spanOf(clip, fps, SR)[0],
						// AudioLayer's volume callback: gain + Volume (clamped to Remotion's limit), unity with effects
						volume: clipHasEffects(clip)
							? 1
							: Math.min(MAX_PREVIEW_GAIN, 10 ** ((clip.gainDb + clip.volumeDb.value) / 20)),
					})),
					fps,
					length: LEN,
				},
			) as Promise<{ channels: number[][]; latency: number }>;
		}

		async function exported(c: Case) {
			return renderMixToBuffers({
				snapshot: c.snapshot,
				openClip: reader(c.data),
				startSample: 0,
				length: LEN,
				outputLayout: 'stereo',
			});
		}

		/** Worst |preview − export| (both channels) over `[from, to)` and the signal peak. */
		function compare(p: number[][], e: Float32Array[], from = 0, to = LEN) {
			let worst = 0;
			let peak = 0;
			for (let c = 0; c < 2; c++)
				for (let i = from; i < to; i++) {
					worst = Math.max(worst, Math.abs(p[c]![i]! - e[c]![i]!));
					peak = Math.max(peak, Math.abs(e[c]![i]!));
				}
			return { worst, peak };
		}

		it('track, submix, Mix and clip effect latency: identical to the export, sample for sample', async () => {
			const c = scene({ set: 'exact' });
			const [p, e] = await Promise.all([preview(c), exported(c)]);
			// A1 374 → S1 (+374 post-fader) → Mix (+256): read-ahead 1004 samples
			expect(p.latency).toBe(1004);
			const r = compare(p.channels, e);
			expect(r.peak).toBeGreaterThan(0.05);
			// float32 Web Audio vs the float32 mixer (summation order, DelayNode on float32 delay times)
			expect(r.worst).toBeLessThan(1e-4);
		});

		it('edits after the graph is built are heard: inserts, faders, pan (same topology)', async () => {
			const c = scene({ set: 'exact' });
			// the graph first sees the mix without inserts, at unity and centred; then the edited mix arrives
			const mix = c.snapshot.audioMix!;
			const before: RenderAudioMix = {
				...mix,
				strips: mix.strips.map((s) => ({
					...s,
					inserts: [],
					volumeDb: { value: 0, keyframes: [] },
					pan: { value: 0, keyframes: [] },
				})),
			};
			const [p, e] = await Promise.all([preview(c, before), exported(c)]);
			expect(p.latency).toBe(1004);
			const r = compare(p.channels, e);
			expect(r.worst).toBeLessThan(1e-4);
		});

		it('frame-based (STFT) inserts: aligned; identical once past the onset transient', async () => {
			const c = scene({ set: 'stft' });
			const [p, e] = await Promise.all([preview(c), exported(c)]);
			// A1 2048 → S1 (+374) → Mix (+256)
			expect(p.latency).toBe(2678);
			const onset = AT * 1600;
			// the STFT frame phase only shows at the onset (−43 dB here), never as a delay
			expect(compare(p.channels, e, 0, onset + 9600).worst).toBeLessThan(0.01);
			expect(compare(p.channels, e, onset + 9600).worst).toBeLessThan(3e-4);
		});

		it('mono clips on stereo tracks: the −3 dB pan law, as the export', async () => {
			const c = monoScene();
			expect(c.snapshot.audioClips.map((x) => x.monoPanLaw)).toEqual(['-3dB', '-3dB']);
			const [p, e] = await Promise.all([preview(c), exported(c)]);
			const r = compare(p.channels, e);
			expect(r.peak).toBeGreaterThan(0.1);
			expect(r.worst).toBeLessThan(1e-4);
		});

		it('loudness normalisation: the preview limiter latency is part of the read-ahead', async () => {
			const c = scene({ set: 'exact', loudness: true });
			const [p, e] = await Promise.all([preview(c), exported(c)]);
			expect(p.latency).toBeGreaterThan(1004);
			// the export applies the normalisation gain after the mixer (engine); below the ceiling the limiter is a delay
			const g = 10 ** (-6 / 20);
			const scaled = e.map((ch) => ch.map((v) => v * g));
			const r = compare(p.channels, scaled);
			expect(r.worst).toBeLessThan(1e-4);
		});
	},
);
