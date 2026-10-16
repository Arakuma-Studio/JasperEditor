import { balanceGains } from '@jasper/audio-dsp';
import { describe, expect, it } from 'vitest';
import { repairAudioMix } from '../src/audio/invariants.ts';
import { contentTimeAt } from '../src/derive/index.ts';
import {
	buildAudioMix,
	buildRenderSnapshot,
	type ClipReader,
	checkInvariants,
	createCounterIdSource,
	generatorReader,
	listStrips,
	mixFingerprint,
	OfflineMixer,
	type ProjectDocument,
	type RenderAudioClip,
	type RenderSnapshot,
	registerAudioProcessor,
	renderMixToBuffers,
	repairDocument,
	resolveStripRef,
	soloAudible,
	thinPoints,
} from '../src/index.ts';
import { evaluate } from '../src/keyframes.ts';
import type { Sequence } from '../src/schema/sequence.ts';
import { Harness } from './helpers.ts';

const F30 = 705_600_000 / 30;
const K = Math.SQRT1_2;

function snapOf(h: Harness): RenderSnapshot {
	return buildRenderSnapshot(h.doc, h.seqId, {
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
}

/** Constant sources: channel c of every clip reads `levels[c]` (by media id). */
function constReader(levels: Record<string, number[]>) {
	return (clip: RenderAudioClip, at: { length: number }): ClipReader => {
		const lv = levels[clip.mediaId] ?? [0.5, 0.5];
		const ch = clip.channels.map.length || lv.length;
		let left = at.length;
		return {
			channels: ch,
			read(out, frames) {
				const n = Math.min(frames, left);
				for (let c = 0; c < ch; c++) out[c]!.fill(lv[clip.channels.map[c] ?? c] ?? 0, 0, n);
				left -= n;
				return n;
			},
			close() {},
		};
	};
}

async function render(
	h: Harness,
	levels: Record<string, number[]>,
	frames = 10,
	start = 0,
	layout?: 'mono' | 'stereo' | '5.1',
) {
	const snapshot = snapOf(h);
	return renderMixToBuffers({
		snapshot,
		openClip: constReader(levels),
		startSample: start,
		length: frames * 1600,
		...(layout ? { outputLayout: layout } : {}),
	});
}

function audioHarness(): { h: Harness; a: string; b: string } {
	const h = new Harness();
	const a = h.registerVideo({ kind: 'audio', seconds: 20 });
	const b = h.registerVideo({ kind: 'audio', seconds: 20 });
	h.ok([
		{ type: 'clip.place', source: { mediaId: a }, at: 0, tracks: { audio: 'A1' } },
		{ type: 'clip.place', source: { mediaId: b }, at: 0, tracks: { audio: 'A2' } },
	]);
	return { h, a, b };
}

const close = (x: number, y: number, eps = 1e-5) => Math.abs(x - y) <= eps;

describe('mix plan', () => {
	it('lists strips A1…, S1…, Mix and resolves strip refs', () => {
		const h = new Harness();
		h.ok([{ type: 'mixer.addSubmix', name: 'Dialogue' }]);
		const strips = listStrips(h.seq);
		expect(strips.map((s) => s.label)).toEqual(['A1', 'A2', 'A3', 'S1', 'Mix']);
		expect(resolveStripRef(h.seq, 'S1')).toBe(strips[3]!.id);
		expect(resolveStripRef(h.seq, 'dialogue')).toBe(strips[3]!.id);
		expect(resolveStripRef(h.seq, 'Mix')).toBe('master');
		expect(resolveStripRef(h.seq, 'A9')).toBeNull();
	});

	it('solo keeps soloed strips, what feeds them and what they feed; solo-safe stays', () => {
		const h = new Harness();
		h.ok([{ type: 'mixer.addSubmix' }]);
		h.ok([
			{ type: 'mixer.updateStrip', stripId: 'A1', patch: { output: 'S1' } },
			{ type: 'mixer.updateStrip', stripId: 'S1', patch: { solo: true } },
			{ type: 'mixer.updateStrip', stripId: 'A3', patch: { soloSafe: true } },
		]);
		const ids = listStrips(h.seq).map((s) => s.id);
		const keep = soloAudible(listStrips(h.seq));
		expect(keep.has(ids[0]!)).toBe(true);
		expect(keep.has(ids[1]!)).toBe(false);
		expect(keep.has(ids[2]!)).toBe(true);
		expect(keep.has('master')).toBe(true);
		const mix = buildAudioMix(h.seq);
		expect(mix.strips.find((s) => s.label === 'A2')!.silent).toBe(true);
	});

	it('solo: a strip reached from one soloed strip still lets the other soloed strip walk through it', () => {
		const h = new Harness();
		h.ok([{ type: 'mixer.addSubmix' }, { type: 'mixer.addSubmix' }, { type: 'mixer.addSubmix' }]);
		// A1 (solo) → S1 → S2 (solo); A3 → S1 also feeds the soloed S2. S1 sends to S3: fed by the soloed A1.
		h.ok([
			{ type: 'mixer.updateStrip', stripId: 'A1', patch: { output: 'S1', solo: true } },
			{ type: 'mixer.updateStrip', stripId: 'A3', patch: { output: 'S1' } },
			{ type: 'mixer.updateStrip', stripId: 'S1', patch: { output: 'S2' } },
			{ type: 'mixer.updateStrip', stripId: 'S2', patch: { solo: true } },
		]);
		const label = (l: string) => resolveStripRef(h.seq, l)!;
		const keep = soloAudible(listStrips(h.seq));
		expect(keep.has(label('A3')), 'A3 feeds the soloed S2 through S1').toBe(true);
		expect(keep.has(label('A2'))).toBe(false);
		// The other direction: S3 is fed by the soloed A1 through S1 (a send), whatever order the seeds are walked in.
		const h2 = new Harness();
		h2.ok([{ type: 'mixer.addSubmix' }, { type: 'mixer.addSubmix' }]);
		h2.ok([
			{ type: 'mixer.updateStrip', stripId: 'A1', patch: { output: 'S1' } },
			{ type: 'mixer.updateStrip', stripId: 'A2', patch: { output: 'S1', solo: true } },
			{ type: 'mixer.updateStrip', stripId: 'S1', patch: { solo: true } },
			{ type: 'mixer.addSend', stripId: 'S1', target: 'S2' },
		]);
		const keep2 = soloAudible(listStrips(h2.seq));
		expect(keep2.has(resolveStripRef(h2.seq, 'S2')!), 'S2 is fed by the soloed S1').toBe(true);
		expect(keep2.has(resolveStripRef(h2.seq, 'A1')!), 'A1 feeds the soloed S1').toBe(true);
		expect(keep2.has(resolveStripRef(h2.seq, 'A3')!)).toBe(false);
	});
});

describe('offline mixer', () => {
	it('stereo clip at unity, balance hard left keeps L only', async () => {
		const { h, a } = audioHarness();
		h.ok([{ type: 'mixer.updateStrip', stripId: 'A2', patch: { mute: true } }]);
		let [l, r] = await render(h, { [a]: [0.5, 0.25] });
		expect(close(l![100]!, 0.5) && close(r![100]!, 0.25)).toBe(true);
		h.ok([{ type: 'mixer.updateStrip', stripId: 'A1', patch: { pan: -100 } }]);
		[l, r] = await render(h, { [a]: [0.5, 0.25] });
		expect(close(l![100]!, 0.5)).toBe(true);
		expect(close(r![100]!, 0)).toBe(true);
	});

	it('mono track pans with the −3 dB constant-power law', async () => {
		const { h, a } = audioHarness();
		h.ok([
			{ type: 'mixer.updateStrip', stripId: 'A2', patch: { mute: true } },
			{ type: 'mixer.updateStrip', stripId: 'A1', patch: { channelFormat: 'mono' } },
		]);
		const [l, r] = await render(h, { [a]: [0.5, 0.5] });
		// stereo → mono fold (BS.775, k·L + k·R) then the −3 dB centre
		expect(close(l![10]!, 0.5 * 2 * K * K)).toBe(true);
		expect(close(r![10]!, 0.5 * 2 * K * K)).toBe(true);
	});

	it('track fader, Mix fader and mute', async () => {
		const { h, a, b } = audioHarness();
		h.ok([
			{ type: 'mixer.updateStrip', stripId: 'A1', patch: { volumeDb: -6 } },
			{ type: 'mixer.updateStrip', stripId: 'Mix', patch: { volumeDb: -6 } },
			{ type: 'mixer.updateStrip', stripId: 'A2', patch: { mute: true } },
		]);
		const [l] = await render(h, { [a]: [0.5, 0.5], [b]: [0.3, 0.3] });
		expect(close(l![50]!, 0.5 * 10 ** (-12 / 20))).toBe(true);
	});

	it('submix routing, pre-fader sends from a muted track, post-fader sends follow the fader', async () => {
		const { h, a, b } = audioHarness();
		const r0 = h.ok([{ type: 'mixer.addSubmix', ref: '$s' }]);
		const s1 = (r0.results[0] as { stripId: string }).stripId;
		h.ok([
			{ type: 'mixer.updateStrip', stripId: 'A1', patch: { output: 'S1' } },
			{ type: 'mixer.updateStrip', stripId: 'S1', patch: { volumeDb: -6 } },
			{ type: 'mixer.updateStrip', stripId: 'A2', patch: { mute: true } },
			{ type: 'mixer.addSend', stripId: 'A2', target: s1, preFader: true, levelDb: 0 },
		]);
		const [l] = await render(h, { [a]: [0.5, 0.5], [b]: [0.2, 0.2] });
		const g = 10 ** (-6 / 20);
		expect(close(l![50]!, (0.5 + 0.2) * g)).toBe(true);
		const send = h.seq.audioTracks[1]!.mixer!.sends![0]!.id;
		h.ok([{ type: 'mixer.updateSend', stripId: 'A2', sendId: send, patch: { preFader: false } }]);
		const [l2] = await render(h, { [a]: [0.5, 0.5], [b]: [0.2, 0.2] });
		expect(close(l2![50]!, 0.5 * g)).toBe(true);
	});

	it('solo silences the other tracks', async () => {
		const { h, a, b } = audioHarness();
		h.ok([{ type: 'mixer.updateStrip', stripId: 'A2', patch: { solo: true } }]);
		const [l] = await render(h, { [a]: [0.5, 0.5], [b]: [0.2, 0.2] });
		expect(close(l![50]!, 0.2)).toBe(true);
	});

	it('volume automation is sample accurate and Off ignores it', async () => {
		const { h, a } = audioHarness();
		h.ok([
			{ type: 'mixer.updateStrip', stripId: 'A2', patch: { mute: true } },
			{
				type: 'mixer.writeAutomation',
				stripId: 'A1',
				lane: 'volume',
				points: [
					[0, 0],
					[10 * F30, -20],
				],
				thinning: { tolerance: 0 },
			},
		]);
		const [l] = await render(h, { [a]: [0.5, 0.5] });
		for (const i of [0, 4000, 8000, 15999]) {
			const t = (i / 48000) * 705_600_000;
			const db = -20 * Math.min(1, t / (10 * F30));
			expect(Math.abs(l![i]! - 0.5 * 10 ** (db / 20))).toBeLessThan(1e-5);
		}
		h.ok([{ type: 'mixer.updateStrip', stripId: 'A1', patch: { automation: 'off' } }]);
		const [l2] = await render(h, { [a]: [0.5, 0.5] });
		expect(close(l2![8000]!, 0.5)).toBe(true);
	});

	it('5.1 Mix: a stereo track sits on L/R; exports fold to stereo with BS.775', async () => {
		const { h, a } = audioHarness();
		h.ok([
			{ type: 'mixer.updateStrip', stripId: 'A2', patch: { mute: true } },
			{ type: 'mixer.updateStrip', stripId: 'Mix', patch: { channelFormat: '5.1' } },
		]);
		const out = await render(h, { [a]: [0.5, 0.25] }, 2, 0, '5.1');
		expect(out.length).toBe(6);
		expect(close(out[0]![10]!, 0.5)).toBe(true);
		expect(close(out[1]![10]!, 0.25)).toBe(true);
		expect(close(out[2]![10]!, 0)).toBe(true);
		// puck centred at the front with Center 100 %: a mono track goes to C
		h.ok([{ type: 'mixer.updateStrip', stripId: 'A1', patch: { channelFormat: 'mono' } }]);
		const m = await render(h, { [a]: [0.5, 0.5] }, 2, 0, '5.1');
		expect(close(m[2]![10]!, 0.5 * 2 * K)).toBe(true);
		expect(close(m[0]![10]!, 0)).toBe(true);
		h.ok([{ type: 'mixer.setLane', stripId: 'A1', lane: 'pan51.x', value: -100 }]);
		const left = await render(h, { [a]: [0.5, 0.5] }, 2, 0, '5.1');
		expect(close(left[0]![10]!, 0.5 * 2 * K, 1e-4)).toBe(true);
		// stereo export of the 5.1 Mix: Lo = L + k·C
		const st = await render(h, { [a]: [0.5, 0.5] }, 2, 0, 'stereo');
		expect(close(st[0]![10]!, 0.5 * 2 * K, 1e-4)).toBe(true);
	});

	it('clip pan is a balance on stereo tracks; clip volume keyframes apply per sample', async () => {
		const { h, a } = audioHarness();
		h.ok([{ type: 'mixer.updateStrip', stripId: 'A2', patch: { mute: true } }]);
		const clip = h.clips('A1')[0]!.id;
		h.ok([{ type: 'param.set', target: ['clip', clip, 'pan'], value: 100 }]);
		const [l, r] = await render(h, { [a]: [0.5, 0.5] });
		expect(close(l![10]!, 0)).toBe(true);
		expect(close(r![10]!, 0.5)).toBe(true);
	});

	it('reversed clips: export volume and pan follow the preview content time (no one-frame shift)', async () => {
		const { h, a } = audioHarness();
		h.ok([{ type: 'mixer.updateStrip', stripId: 'A2', patch: { mute: true } }]);
		const clip = h.clips('A1')[0]!.id;
		h.ok([{ type: 'clip.setSpeed', clipIds: [clip], reverse: true, ripple: false }]);
		// Clip Mixer keyframes written in sequence time (content time through `contentTimeAt`, as the preview reads them).
		h.ok([
			{
				type: 'clipMixer.write',
				trackId: 'A1',
				lane: 'volume',
				points: [
					[10 * F30, 0],
					[20 * F30, -20],
				],
				thinning: { tolerance: 0 },
			},
			{
				type: 'clipMixer.write',
				trackId: 'A1',
				lane: 'pan',
				points: [
					[10 * F30, 0],
					[20 * F30, 100],
				],
				thinning: { tolerance: 0 },
			},
		]);
		const c = h.seq.clips[clip] as unknown as RenderAudioClip;
		const [l, r] = await render(h, { [a]: [0.5, 0.5] }, 25);
		for (const f of [12, 15, 18]) {
			const i = f * 1600;
			const content = contentTimeAt(c, f, { num: 30, den: 1 });
			const g = 0.5 * 10 ** (evaluate(c.volumeDb, content) / 20);
			const [gl, gr] = balanceGains(evaluate(c.pan, content) / 100);
			expect(Math.abs(l![i]! - g * gl), `L at frame ${f}`).toBeLessThan(1e-5);
			expect(Math.abs(r![i]! - g * gr), `R at frame ${f}`).toBeLessThan(1e-5);
		}
		// frame 15 is half way: −10 dB, pan 50
		expect(Math.abs(r![15 * 1600]! - 0.5 * 10 ** (-10 / 20))).toBeLessThan(1e-4);
	});

	it('inserts run registered processors (latency compensated) and report missing ones', async () => {
		const { h, a } = audioHarness();
		h.ok([{ type: 'mixer.updateStrip', stripId: 'A2', patch: { mute: true } }]);
		const snapshot = snapOf(h);
		const strip = snapshot.audioMix!.strips.find((s) => s.label === 'A1')!;
		strip.inserts = [{ id: 'fx_test', effectId: 'test.half', effectVersion: 1, enabled: true, params: {} }];
		const missing: string[] = [];
		const m0 = new OfflineMixer({
			snapshot,
			openClip: constReader({ [a]: [0.5, 0.5] }),
			startSample: 0,
			onMissingProcessor: (e) => missing.push(e.effectId),
		});
		m0.close();
		expect(missing).toEqual(['test.half']);
		const off = registerAudioProcessor('test.half', () => {
			// halves the signal with a 64-sample delay
			const buf: number[][] = [];
			return {
				latency: 64,
				reset() {},
				process(ch, n) {
					for (let c = 0; c < ch.length; c++) {
						buf[c] ??= Array(64).fill(0);
						for (let i = 0; i < n; i++) {
							buf[c]!.push(ch[c]![i]! * 0.5);
							ch[c]![i] = buf[c]!.shift()!;
						}
					}
				},
			};
		});
		try {
			const out = await renderMixToBuffers({
				snapshot,
				openClip: constReader({ [a]: [0.5, 0.5] }),
				startSample: 0,
				length: 3200,
			});
			expect(close(out[0]![1]!, 0.25)).toBe(true);
			expect(close(out[0]![3000]!, 0.25)).toBe(true);
		} finally {
			off();
		}
	});

	it('a synthetic tone sped up past Nyquist is silent instead of aliasing', () => {
		const clip = {
			start: 0,
			duration: 30,
			sourceIn: 0,
			speed: { rate: 30, reverse: false, maintainPitch: false },
			channels: { streamIndex: 0, map: [] },
			generator: { kind: 'tone', hz: 1000, db: -20 },
		} as unknown as RenderAudioClip;
		const read = (c: RenderAudioClip) => {
			const r = generatorReader(c, { offset: 0, length: 4800, sampleRate: 48000 }, { num: 30, den: 1 })!;
			const out = [new Float32Array(4800), new Float32Array(4800)];
			r.read(out, 4800);
			return Math.max(...out[0]!.map(Math.abs));
		};
		// 1 kHz × 30 = 30 kHz > 24 kHz: a band-limited resampler removes it (it would alias to 18 kHz)
		expect(read(clip)).toBe(0);
		// 1 kHz × 20 = 20 kHz stays
		expect(read({ ...clip, speed: { ...clip.speed, rate: 20 } })).toBeGreaterThan(0.09);
	});

	it('block size does not change the output', async () => {
		const { h, a } = audioHarness();
		h.ok([
			{
				type: 'mixer.writeAutomation',
				stripId: 'A1',
				lane: 'pan',
				points: [
					[0, -100],
					[5 * F30, 100],
				],
				thinning: { tolerance: 0 },
			},
		]);
		const snapshot = snapOf(h);
		const whole = await renderMixToBuffers({
			snapshot,
			openClip: constReader({ [a]: [0.5, 0.3] }),
			startSample: 0,
			length: 8000,
		});
		const m = new OfflineMixer({ snapshot, openClip: constReader({ [a]: [0.5, 0.3] }), startSample: 0 });
		const parts = [new Float32Array(8000), new Float32Array(8000)];
		let pos = 0;
		for (const n of [1, 77, 1024, 3000, 3898]) {
			const view = parts.map((p) => p.subarray(pos, pos + n));
			await m.render(view, n);
			pos += n;
		}
		m.close();
		for (let i = 0; i < 8000; i += 97) expect(Math.abs(parts[0]![i]! - whole[0]![i]!)).toBeLessThan(1e-6);
	});
});

describe('mixer commands', () => {
	it('refuses feedback routes, reroutes on submix removal, undo restores', () => {
		const h = new Harness();
		h.ok([{ type: 'mixer.addSubmix' }, { type: 'mixer.addSubmix' }]);
		h.ok([{ type: 'mixer.updateStrip', stripId: 'S1', patch: { output: 'S2' } }]);
		const bad = h.tx([{ type: 'mixer.updateStrip', stripId: 'S2', patch: { output: 'S1' } }]);
		expect(bad.ok).toBe(false);
		h.ok([{ type: 'mixer.updateStrip', stripId: 'A1', patch: { output: 'S1' } }]);
		const before = h.doc;
		h.ok([{ type: 'mixer.removeSubmix', stripId: 'S1' }]);
		expect(h.seq.audioTracks[0]!.mixer!.output).toBe(h.seq.submixTracks![0]!.id);
		expect(checkInvariants(h.doc)).toEqual([]);
		h.doc = before;
		expect(checkInvariants(h.doc)).toEqual([]);
	});

	it('at most 5 sends; sends need a later submix', () => {
		const h = new Harness();
		h.ok([{ type: 'mixer.addSubmix' }]);
		for (let i = 0; i < 5; i++) h.ok([{ type: 'mixer.addSend', stripId: 'A1', target: 'S1' }]);
		expect(h.tx([{ type: 'mixer.addSend', stripId: 'A1', target: 'S1' }]).ok).toBe(false);
		expect(h.tx([{ type: 'mixer.addSend', stripId: 'S1', target: 'S1' }]).ok).toBe(false);
		expect(h.tx([{ type: 'mixer.addSend', stripId: 'Mix', target: 'S1' }]).ok).toBe(false);
	});

	it('writeAutomation thins a gesture and keeps automation outside the pass', () => {
		const h = new Harness();
		const pts: [number, number][] = [];
		for (let i = 0; i <= 100; i++) pts.push([i * F30, i <= 50 ? -i * 0.2 : -10 + (i - 50) * 0.2]);
		h.ok([{ type: 'mixer.writeAutomation', stripId: 'A1', lane: 'volume', points: pts }]);
		expect(h.seq.audioTracks[0]!.volumeDb!.keyframes.map((k) => [k.time / F30, k.value])).toEqual([
			[0, 0],
			[50, -10],
			[100, 0],
		]);
		h.ok([
			{
				type: 'mixer.writeAutomation',
				stripId: 'A1',
				lane: 'volume',
				points: [
					[40 * F30, -20],
					[60 * F30, -20],
				],
			},
		]);
		const kf = h.seq.audioTracks[0]!.volumeDb!.keyframes;
		expect(kf[0]).toMatchObject({ time: 0, value: 0 });
		expect(kf[kf.length - 1]).toMatchObject({ time: 100 * F30, value: 0 });
		expect(checkInvariants(h.doc)).toEqual([]);
	});

	it('thinPoints: hold lanes keep change points only', () => {
		expect(
			thinPoints(
				[
					[0, 0],
					[10, 0],
					[20, 1],
					[30, 1],
					[40, 0],
				],
				0,
				0,
				true,
			),
		).toEqual([
			[0, 0],
			[20, 1],
			[40, 0],
		]);
	});

	it('clipMixer.write writes clip volume keyframes in content time', () => {
		const { h } = audioHarness();
		h.ok([
			{
				type: 'clipMixer.write',
				trackId: 'A1',
				lane: 'volume',
				points: [
					[F30 * 10, -6],
					[F30 * 20, -12],
				],
				thinning: { tolerance: 0 },
			},
		]);
		const c = h.clips('A1')[0]! as { volumeDb: { keyframes: { time: number; value: number }[] } };
		expect(c.volumeDb.keyframes.length).toBeGreaterThanOrEqual(2);
		expect(c.volumeDb.keyframes.some((k) => k.value === -6)).toBe(true);
		expect(c.volumeDb.keyframes.some((k) => k.value === -12)).toBe(true);
	});

	it('audio.setGain: set, adjust, normalise max and all peaks', () => {
		const { h } = audioHarness();
		const [x, y] = [h.clips('A1')[0]!.id, h.clips('A2')[0]!.id];
		const gain = (id: string) => (h.seq.clips[id] as { gainDb: number }).gainDb;
		h.ok([{ type: 'audio.setGain', clipIds: [x, y], mode: 'set', db: 3 }]);
		expect([gain(x), gain(y)]).toEqual([3, 3]);
		h.ok([{ type: 'audio.setGain', clipIds: [x], mode: 'adjust', db: -5 }]);
		expect(gain(x)).toBe(-2);
		h.ok([
			{ type: 'audio.setGain', clipIds: [x, y], mode: 'normalizeAll', db: -1, peaks: { [x]: -10, [y]: -4 } },
		]);
		expect([gain(x), gain(y)]).toEqual([9, 3]);
		h.ok([{ type: 'audio.setGain', clipIds: [x, y], mode: 'set', db: 0 }]);
		h.ok([
			{ type: 'audio.setGain', clipIds: [x, y], mode: 'normalizeMax', db: -1, peaks: { [x]: -10, [y]: -4 } },
		]);
		expect([gain(x), gain(y)]).toEqual([3, 3]);
		expect(h.tx([{ type: 'audio.setGain', clipIds: [x], mode: 'normalizeAll', db: -1 }]).ok).toBe(false);
	});

	it('audio.autoDuck writes duck keyframes clamped to the clip', () => {
		const { h } = audioHarness();
		const music = h.clips('A2')[0]!.id;
		const s = 705_600_000;
		h.ok([
			{
				type: 'audio.autoDuck',
				targetClipIds: [music],
				regions: [[2 * s, 4 * s]],
				amountDb: 18,
				fadeMs: 500,
			},
		]);
		const kf = (h.seq.clips[music] as { volumeDb: { keyframes: { time: number; value: number }[] } }).volumeDb
			.keyframes;
		expect(kf.map((k) => [k.time / s, k.value])).toEqual([
			[1.5, 0],
			[2, -18],
			[4, -18],
			[4.5, 0],
		]);
	});

	it('mixer.setLoudness enables normalisation; the plan carries target − measured', () => {
		const h = new Harness();
		const hash = mixFingerprint(h.doc, h.seqId);
		h.ok([
			{
				type: 'mixer.setLoudness',
				enabled: true,
				targetLufs: -16,
				truePeakDb: -1,
				analysis: { integratedLufs: -20, truePeakDbtp: -3, lra: 5, mixHash: hash, analyzedAt: 'now' },
			},
		]);
		expect(buildAudioMix(h.seq).loudness).toEqual({ gainDb: 4, truePeakDb: -1 });
		expect(mixFingerprint(h.doc, h.seqId)).toBe(hash);
		h.ok([{ type: 'mixer.updateStrip', stripId: 'A1', patch: { volumeDb: -3 } }]);
		expect(mixFingerprint(h.doc, h.seqId)).not.toBe(hash);
	});

	it('mixFingerprint ignores keyframe ids (the same curve written again is the same mix)', () => {
		const h = new Harness();
		const m = h.registerVideo({ seconds: 10 });
		h.ok([{ type: 'clip.place', source: { mediaId: m }, at: 0, tracks: { video: 'V1', audio: 'A1' } }]);
		h.ok([{ type: 'mixer.writeAutomation', stripId: 'A1', lane: 'volume', points: [[0, -3], [705_600_000, -9]] }]);
		const fp = mixFingerprint(h.doc, h.seqId);
		const doc = JSON.parse(JSON.stringify(h.doc)) as ProjectDocument;
		for (const k of doc.sequences[h.seqId]!.audioTracks[0]!.volumeDb!.keyframes) k.id = `${k.id}x`;
		expect(mixFingerprint(doc, h.seqId)).toBe(fp);
		doc.sequences[h.seqId]!.audioTracks[0]!.volumeDb!.keyframes[0]!.value = -4;
		expect(mixFingerprint(doc, h.seqId)).not.toBe(fp);
	});

	it("mixFingerprint changes when Interpret Footage changes how a clip's media plays", () => {
		const h = new Harness();
		const m = h.registerVideo({ seconds: 10 });
		h.ok([{ type: 'clip.place', source: { mediaId: m }, at: 0, tracks: { video: 'V1', audio: 'A1' } }]);
		const fp0 = mixFingerprint(h.doc, h.seqId);
		h.ok([{ type: 'media.interpret', mediaIds: [m], interpretation: { frameRate: { num: 15, den: 1 } } }]);
		const fp1 = mixFingerprint(h.doc, h.seqId);
		expect(fp1).not.toBe(fp0);
		h.ok([{ type: 'media.interpret', mediaIds: [m], interpretation: { frameRate: null, loop: 3 } }]);
		expect(mixFingerprint(h.doc, h.seqId)).not.toBe(fp1);
	});

	it('repairDocument drops invalid routes and sends', () => {
		const h = new Harness();
		h.ok([{ type: 'mixer.addSubmix' }]);
		const doc = JSON.parse(JSON.stringify(h.doc)) as ProjectDocument;
		const seq = Object.values(doc.sequences)[0]!;
		seq.audioTracks[0]!.mixer = {
			output: 'trk_missing',
			sends: [{ id: 'snd_0000000000000000', target: 'nope', levelDb: { value: 0, keyframes: [] } }],
		};
		expect(checkInvariants(doc).some((i) => i.invariant === 'INV-MIX')).toBe(true);
		const { document } = repairDocument(doc, createCounterIdSource(99));
		expect(checkInvariants(document).filter((i) => i.invariant === 'INV-MIX')).toEqual([]);
	});

	it('repairDocument keeps a valid send whose id an invalid duplicate used first', () => {
		const h = new Harness();
		h.ok([{ type: 'mixer.addSubmix' }]);
		const doc = JSON.parse(JSON.stringify(h.doc)) as ProjectDocument;
		const seq = Object.values(doc.sequences)[0]!;
		const sub = seq.submixTracks![0]!.id;
		const lv = { value: 0, keyframes: [] };
		seq.audioTracks[0]!.mixer = {
			sends: [
				{ id: 'snd_0000000000000001', target: 'gone', levelDb: lv },
				{ id: 'snd_0000000000000001', target: sub, levelDb: lv },
			],
		};
		const { document } = repairDocument(doc, createCounterIdSource(99));
		const sends = Object.values(document.sequences)[0]!.audioTracks[0]!.mixer!.sends!;
		expect(sends.map((x) => x.target)).toEqual([sub]);
		// The mixer repair on its own (repairDocument may rename duplicate ids before it runs).
		const s2 = JSON.parse(JSON.stringify(seq)) as Sequence;
		const notes: string[] = [];
		repairAudioMix(s2, (a) => notes.push(a));
		expect(s2.audioTracks[0]!.mixer!.sends!.map((x) => x.target)).toEqual([sub]);
		expect(notes).toContain('drop-send');
	});
});
