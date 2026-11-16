// @vitest-environment node
// Pitch Shifter engines end to end: the preview's effect slot (FxSlotCore, the AudioWorklet's code, given the Rubber
// Band module the way the worklet is) renders sample for sample what the export's EffectSlot renders, for every
// engine; and on A1 as a track effect the offline mixer (every export path) shifts the track continuously across
// butt cuts: a sequence of butt-cut clips of one take renders exactly as the uncut take through one processor, so
// edit points neither restart the shifter nor click, and the output keeps the timeline's length and alignment.
import { readFileSync } from 'node:fs';
import { EffectSlot, installAudioFxProcessors, rubberBandStatus } from '@jasper/audio-fx';
import {
	buildRenderSnapshot,
	type ClipReader,
	type EffectInstance,
	FLICKS_PER_SECOND,
	type RenderAudioClip,
	renderMixToBuffers,
} from '@jasper/project';
import { beforeAll, describe, expect, it } from 'vitest';
import { Harness } from '../../project/test/helpers.ts';
import { FxSlotCore } from '../src/audio/fx-processor.ts';

const SR = 48000;
const S = FLICKS_PER_SECOND;
const WASM = new URL('../../audio-fx/wasm/rubberband.wasm', import.meta.url);

/** A take: a voiced, gliding harmonic tone with a syllable-rate envelope (continuous across any cut). */
function take(i: number): number {
	const t = i / SR;
	const f0 = 140 + 25 * Math.sin(2 * Math.PI * 0.7 * t);
	const ph = 2 * Math.PI * (140 * t - (25 / (2 * Math.PI * 0.7)) * Math.cos(2 * Math.PI * 0.7 * t));
	let v = 0;
	for (let h = 1; h <= 12; h++) v += Math.sin(h * ph) / h;
	void f0;
	return 0.25 * v * (0.6 + 0.4 * Math.sin(2 * Math.PI * 3 * t));
}

function pitch(engine: string, quality = 'best'): EffectInstance {
	const v = <T>(value: T) => ({ value, keyframes: [] });
	return {
		id: 'fx_pitch',
		effectId: 'jasper.audio.pitch-shifter',
		effectVersion: 1,
		enabled: true,
		params: {
			semitones: v(-1),
			cents: v(-50),
			engine: v(engine),
			quality: v(quality),
			preserveFormants: v(true),
		},
	};
}

const ENGINES: [string, string][] = [
	['legacy', 'best'],
	['signalsmith', 'best'],
	['signalsmith', 'fast'],
	['rubberband-r3', 'best'],
	['rubberband-r3', 'fast'],
];

beforeAll(() => {
	installAudioFxProcessors();
	// the preview hands the module to its worklet scope with a message; this process is that scope here
	new FxSlotCore(SR, 1, null).message({
		type: 'rubberband',
		module: new WebAssembly.Module(readFileSync(WASM)),
	});
});

describe('Pitch Shifter: preview slot = export slot', () => {
	it.each(ENGINES)('%s %s: identical sample for sample', (engine, quality) => {
		expect(rubberBandStatus().available).toBe(true);
		const N = Math.round(0.6 * SR);
		const src = Float32Array.from({ length: N }, (_, i) => take(i));
		const exp = new EffectSlot(pitch(engine, quality), SR, 1);
		const e = src.slice();
		for (let a = 0; a < N; a += 1000) {
			const k = Math.min(1000, N - a);
			exp.process([e.subarray(a, a + k)], k, { sampleRate: SR, time: (a * S) / SR, flicksPerSample: S / SR });
		}
		const core = new FxSlotCore(SR, 1, null);
		core.message({ type: 'effect', effect: pitch(engine, quality), time: 0 });
		const p = new Float32Array(N);
		for (let q = 0; q < N; q += 128) {
			const n = Math.min(128, N - q);
			const out = [new Float32Array(n)];
			core.render([src.subarray(q, q + n)], out);
			p.set(out[0]!, q);
		}
		let worst = 0;
		for (let i = 0; i < N; i++) worst = Math.max(worst, Math.abs(p[i]! - e[i]!));
		expect(worst).toBe(0);
	});
});

describe('Pitch Shifter as a track effect across butt cuts (offline mixer)', () => {
	it('new instances get Signalsmith Stretch (stored ones without the param read legacy)', () => {
		const h = new Harness();
		h.ok([{ type: 'effect.add', target: { trackId: 'A1' }, effectId: 'jasper.audio.pitch-shifter' }]);
		expect(h.seq.audioTracks[0]!.effects![0]!.params.engine?.value).toBe('signalsmith');
	});

	it('a stored legacy track instance switches in place to Rubber Band R3 with formants (set_effect_param → param.set)', () => {
		const h = new Harness();
		h.ok([
			{
				type: 'effect.add',
				target: { trackId: 'A1' },
				effectId: 'jasper.audio.pitch-shifter',
				params: { engine: 'legacy', semitones: -1, cents: -50 },
			},
		]);
		const id = h.seq.audioTracks[0]!.effects![0]!.id;
		h.ok([
			{ type: 'param.set', target: ['effect', id, 'engine'], value: 'rubberband-r3' },
			{ type: 'param.set', target: ['effect', id, 'preserveFormants'], value: true },
		]);
		const p = h.seq.audioTracks[0]!.effects![0]!.params;
		expect([p.engine?.value, p.preserveFormants?.value, p.semitones?.value, p.cents?.value]).toEqual([
			'rubberband-r3',
			true,
			-1,
			-50,
		]);
		expect(h.tx([{ type: 'param.set', target: ['effect', id, 'engine'], value: 'rubberband' }]).ok).toBe(false);
	});

	/** A1 with the take, optionally cut at `cuts` (frames), and a Pitch Shifter track effect on A1; the mono mix. */
	async function renderA1(engine: string, cuts: number[], length: number) {
		const h = new Harness();
		const media = h.registerVideo({ kind: 'audio', seconds: 10 });
		h.ok([{ type: 'clip.place', source: { mediaId: media }, at: 0, tracks: { audio: 'A1' } }]);
		if (cuts.length) h.ok(cuts.map((at) => ({ type: 'clip.split', at, tracks: ['A1'] })));
		h.ok([
			{
				type: 'effect.add',
				target: { trackId: 'A1' },
				effectId: 'jasper.audio.pitch-shifter',
				params: { engine, semitones: -1, cents: -50, preserveFormants: true },
			},
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
		const a1 = h.seq.audioTracks[0]!.id;
		const spf = SR / 30;
		// every clip reads the take at its source position, on each of its channels
		const openClip = (clip: RenderAudioClip, at: { offset: number; length: number }): ClipReader => {
			// sourceIn in flicks, handles in frames
			let pos = Math.round((clip.sourceIn * SR) / S - (clip.headHandle ?? 0) * spf) + at.offset;
			let left = at.length;
			const ch = clip.channels.map.length || 2;
			return {
				channels: ch,
				read(out, frames) {
					const n = Math.min(frames, left);
					for (let i = 0; i < n; i++) {
						const v = take(pos + i);
						for (let c = 0; c < ch; c++) out[c]![i] = v;
					}
					pos += n;
					left -= n;
					return n;
				},
				close() {},
			};
		};
		const [mix] = await renderMixToBuffers({
			snapshot,
			openClip,
			startSample: 0,
			length,
			outputLayout: 'mono',
		});
		return {
			mix: mix!,
			cuts: snapshot.audioClips.filter((c) => c.trackId === a1).map((c) => Math.round(c.start * spf)),
		};
	}

	it.each(ENGINES.filter(([, q]) => q === 'best'))(
		'%s: five butt cuts of one take render exactly as the uncut take (no restart, no click at the edit points)',
		async (engine) => {
			const length = 42 * (SR / 30);
			// cuts every 7 frames (≈ 233 ms): shorter than every engine's window, as on the A1 voice track
			const cut = await renderA1(engine, [7, 14, 21, 28, 35], length);
			const whole = await renderA1(engine, [], length);
			expect(cut.cuts.length).toBe(6);
			expect(cut.mix.length).toBe(length);
			let worst = 0;
			let peak = 0;
			for (let i = 0; i < length; i++) {
				worst = Math.max(worst, Math.abs(cut.mix[i]! - whole.mix[i]!));
				peak = Math.max(peak, Math.abs(whole.mix[i]!));
			}
			expect(peak).toBeGreaterThan(0.1);
			expect(worst).toBeLessThan(1e-6);
			// no step at the edit points: the largest sample step within ±8 samples of a cut stays within the largest
			// step of the surrounding 20 ms (the signal's own slope)
			for (const at of cut.cuts.slice(1)) {
				let atCut = 0;
				let around = 0;
				for (let i = at - 960; i <= at + 960; i++) {
					const step = Math.abs(cut.mix[i]! - cut.mix[i - 1]!);
					if (Math.abs(i - at) <= 8) atCut = Math.max(atCut, step);
					else around = Math.max(around, step);
				}
				expect(atCut, `cut at ${at}`).toBeLessThanOrEqual(around * 1.05);
			}
		},
	);
});
