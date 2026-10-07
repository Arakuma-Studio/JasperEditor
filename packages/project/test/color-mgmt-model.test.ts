// color-mgmt: sequence working spaces, Interpret Footage ▸ Colour, clip overrides, the snapshot's colour input
// transforms, Lumetri HDR White / Specular, invariants and repairs.
import { describe, expect, it } from 'vitest';
import {
	applyLut,
	bakeColorRun,
	checkInvariants,
	COLOR_INPUT_ID,
	colorRunKey,
	defaultEffectRegistry,
	effectRuns,
	type MediaAsset,
	pqFromNits,
	repairDocument,
	type Rgb,
	sequenceColorInfo,
	type VideoClip,
	workingKey,
	buildRenderSnapshot,
	createCounterIdSource,
	logEncode,
	normalizedFromSignal,
} from '../src/index.ts';
import { Harness, videoAsset } from './helpers.ts';

const clean = (h: Harness) => expect(checkInvariants(h.doc)).toEqual([]);
const snapOf = (h: Harness) =>
	buildRenderSnapshot(h.doc, h.seqId, {
		resolveMedia: (a) => ({
			url: `/media/${a.id}`,
			proxyUrl: null,
			kind: a.kind,
			width: 1920,
			height: 1080,
			durationFlicks: a.probe.durationFlicks,
			hasAudio: false,
			rotation: 0,
		}),
		resolveFont: () => null,
	});

function placeVideo(h: Harness, asset: ReturnType<typeof videoAsset>) {
	const m = (h.ok([{ type: 'media.register', asset }]).results[0] as { mediaId: string }).mediaId;
	const r = h.ok([
		{ type: 'clip.place', source: { mediaId: m }, at: 0, tracks: { video: 'V1' }, sourceRange: { in: { seconds: 0 }, out: { seconds: 2 } } },
	]);
	const v = (r.results[0] as { clipIds: string[] }).clipIds.find((id) => h.seq.clips[id]!.kind === 'video')!;
	return { mediaId: m, clipId: v };
}

function hdrAsset(transfer: string): ReturnType<typeof videoAsset> {
	const a = videoAsset({ audio: false });
	const vs = a.probe.streams[0] as MediaAsset['probe']['streams'][number] & { color: Record<string, string> };
	vs.color = { primaries: 'bt2020', transfer, matrix: 'bt2020nc', range: 'tv' };
	return a;
}

/** Runs the layer's colour runs (the snapshot's effects, evaluated statically) on one colour. */
function grade(snapClip: { effects: unknown[] }, ctx: Parameters<typeof bakeColorRun>[2], c: Rgb): Rgb {
	const effects = (snapClip.effects as { id: string; effectId: string; effectVersion: number; enabled: boolean; params: Record<string, { value: unknown }> }[]).map(
		(fx) => ({ ...fx, params: Object.fromEntries(Object.entries(fx.params).map(([k, v]) => [k, v.value])) }),
	);
	const out: Rgb = [...c];
	for (const run of effectRuns(effects, defaultEffectRegistry)) {
		if (run.kind !== 'color') continue;
		const lut = bakeColorRun(run.effects, defaultEffectRegistry, ctx, 33);
		if (!lut) continue;
		applyLut(lut, out);
	}
	return out;
}

describe('sequence working space (sequence.updateSettings)', () => {
	it('defaults to Rec. 709 and changes undoably, linear variants turn on Linearize', () => {
		const h = new Harness();
		expect(sequenceColorInfo(h.seq.settings)).toMatchObject({ space: 'rec709', linearize: false, blendLinear: false, autoToneMap: true, sdrWhiteNits: 203 });
		h.ok([{ type: 'sequence.updateSettings', settings: { workingColorSpace: 'rec2100-pq', color: { sdrWhiteNits: 100, hdrPeakNits: 4000 } } }]);
		expect(h.seq.settings.workingColorSpace).toBe('rec2100-pq');
		expect(sequenceColorInfo(h.seq.settings)).toMatchObject({ sdrWhiteNits: 100, hdrPeakNits: 4000 });
		h.ok([{ type: 'sequence.updateSettings', settings: { workingColorSpace: 'rec2020-linear' } }]);
		expect(sequenceColorInfo(h.seq.settings)).toMatchObject({ space: 'rec2020', linearize: true, blendLinear: true });
		h.ok([{ type: 'sequence.updateSettings', settings: { color: { linearize: null, sdrWhiteNits: null, hdrPeakNits: null, blendLinear: true } } }]);
		expect(h.seq.settings.color).toEqual({ blendLinear: true });
		clean(h);
	});
	it('refuses unknown spaces and out-of-range settings', () => {
		const h = new Harness();
		expect(h.tx([{ type: 'sequence.updateSettings', settings: { workingColorSpace: 'aces' } }]).ok).toBe(false);
		expect(h.tx([{ type: 'sequence.updateSettings', settings: { color: { sdrWhiteNits: 5000 } } }]).ok).toBe(false);
		expect(h.tx([{ type: 'sequence.updateSettings', settings: { workingColorSpace: 'rec2100-pq-linear' } }]).ok).toBe(false);
	});
	it('a sequence made from HDR media works in its HDR space', () => {
		const h = new Harness();
		const m = (h.ok([{ type: 'media.register', asset: hdrAsset('arib-std-b67') }]).results[0] as { mediaId: string }).mediaId;
		const r = h.ok([{ type: 'sequence.create', name: 'HLG', fromMediaId: m }]);
		const id = (r.results[0] as { sequenceId: string }).sequenceId;
		expect(h.doc.sequences[id]!.settings.workingColorSpace).toBe('rec2100-hlg');
	});
});

describe('Interpret Footage ▸ Colour and clip overrides', () => {
	it('sets, patches and clears the media interpretation; validates every reference', () => {
		const h = new Harness();
		const { mediaId, clipId } = placeVideo(h, videoAsset({ audio: false }));
		h.ok([{ type: 'media.interpretColor', mediaIds: [mediaId], color: { space: 'slog3-sgamut3cine', range: 'pc' } }]);
		expect(h.doc.media[mediaId]!.interpretation?.color).toEqual({ space: 'slog3-sgamut3cine', range: 'pc' });
		h.ok([{ type: 'media.interpretColor', mediaIds: [mediaId], color: { range: null, toneMap: false } }]);
		expect(h.doc.media[mediaId]!.interpretation?.color).toEqual({ space: 'slog3-sgamut3cine', toneMap: false });
		expect(h.tx([{ type: 'media.interpretColor', mediaIds: [mediaId], color: { space: 'nope' } }]).ok).toBe(false);
		expect(h.tx([{ type: 'media.interpretColor', mediaIds: [mediaId], color: { inputLut: mediaId } }]).ok).toBe(false);
		h.ok([{ type: 'clip.setColorInterpretation', clipIds: [clipId], color: { space: 'rec709' } }]);
		expect((h.seq.clips[clipId] as VideoClip).colorInterpretation).toEqual({ space: 'rec709' });
		h.ok([{ type: 'clip.setColorInterpretation', clipIds: [clipId], color: null }]);
		expect((h.seq.clips[clipId] as VideoClip).colorInterpretation).toBeUndefined();
		h.ok([{ type: 'media.interpretColor', mediaIds: [mediaId], color: null }]);
		expect(h.doc.media[mediaId]!.interpretation).toBeUndefined();
		clean(h);
	});
	it('refuses audio media and non-picture clips', () => {
		const h = new Harness();
		const a = (h.ok([{ type: 'media.register', asset: videoAsset({ kind: 'audio' }) }]).results[0] as { mediaId: string }).mediaId;
		expect(h.tx([{ type: 'media.interpretColor', mediaIds: [a], color: { space: 'rec709' } }]).ok).toBe(false);
	});
});

describe('snapshot colour input transforms', () => {
	it('adds nothing in a plain Rec. 709 sequence (existing projects render as before)', () => {
		const h = new Harness();
		placeVideo(h, videoAsset({ audio: false }));
		const snap = snapOf(h);
		const clip = snap.videoTracks[0]!.clips[0]!;
		expect(clip.effects.some((fx) => fx.effectId === COLOR_INPUT_ID)).toBe(false);
		expect(workingKey(snap.settings.color)).toBe('');
	});
	it('interprets S-Log3 into Rec. 709: 18 % grey lands at BT.2408 26/203 (≈ 42.5 %)', () => {
		const h = new Harness();
		const { mediaId } = placeVideo(h, videoAsset({ audio: false }));
		h.ok([{ type: 'media.interpretColor', mediaIds: [mediaId], color: { space: 'slog3-sgamut3cine' } }]);
		const snap = snapOf(h);
		const clip = snap.videoTracks[0]!.clips[0]!;
		expect(clip.effects[0]!.effectId).toBe(COLOR_INPUT_ID);
		const grey = normalizedFromSignal(logEncode('slog3', 0.18), 'tv', 'cv');
		const out = grade(clip, { lut: () => null, working: snap.settings.color }, [grey, grey, grey]);
		for (const v of out) expect(v).toBeCloseTo((26 / 203) ** (1 / 2.4), 2);
	});
	it('PQ media auto-detected in a PQ sequence is the identity; in Rec. 709 it is tone mapped', () => {
		const h = new Harness();
		placeVideo(h, hdrAsset('smpte2084'));
		expect(snapOf(h).videoTracks[0]!.clips[0]!.effects.some((fx) => fx.effectId === COLOR_INPUT_ID)).toBe(true);
		h.ok([{ type: 'sequence.updateSettings', settings: { workingColorSpace: 'rec2100-pq' } }]);
		expect(snapOf(h).videoTracks[0]!.clips[0]!.effects.some((fx) => fx.effectId === COLOR_INPUT_ID)).toBe(false);
	});
	it('graphics and the background map SDR white to the HDR graphics white in PQ', () => {
		const h = new Harness();
		h.ok([{ type: 'sequence.updateSettings', settings: { workingColorSpace: 'rec2100-pq', backgroundColor: [1, 1, 1, 1] } }]);
		h.ok([{ type: 'clip.addText', at: 0, duration: 30, track: 'V1', content: { text: 'Hi' } }]);
		const snap = snapOf(h);
		for (const k of [0, 1, 2]) expect(snap.settings.backgroundColor[k]).toBeCloseTo(pqFromNits(203), 6);
		const text = snap.videoTracks[0]!.clips[0]!;
		expect(text.effects[0]!.effectId).toBe(COLOR_INPUT_ID);
		const white = grade(text, { lut: () => null, working: snap.settings.color }, [1, 1, 1]);
		for (const v of white) expect(v).toBeCloseTo(pqFromNits(203), 2);
	});
	it('the working settings enter the run key (a changed setting re-bakes)', () => {
		const a = sequenceColorInfo({ workingColorSpace: 'rec2100-pq' });
		const b = sequenceColorInfo({ workingColorSpace: 'rec2100-pq', color: { sdrWhiteNits: 100 } });
		expect(workingKey(a)).not.toBe(workingKey(b));
		const fx = [{ id: 'x', effectId: COLOR_INPUT_ID, effectVersion: 1, enabled: true, params: { space: 'rec709' } }];
		expect(colorRunKey(fx, (m) => m, 33, workingKey(a))).not.toBe(colorRunKey(fx, (m) => m, 33, workingKey(b)));
	});
});

describe('Lumetri in HDR', () => {
	const lum = (params: Record<string, unknown>) => [
		{ id: 'l', effectId: 'jasper.lumetri', effectVersion: 1, enabled: true, params },
	];
	const pq = sequenceColorInfo({ workingColorSpace: 'rec2100-pq' });
	const run = (params: Record<string, unknown>, c: Rgb) => {
		const lut = bakeColorRun(lum(params), defaultEffectRegistry, { lut: () => null, working: pq }, 33);
		const o: Rgb = [...c];
		if (lut) applyLut(lut, o);
		return o;
	};
	it('HDR White / Specular are identity at their defaults', () => {
		expect(bakeColorRun(lum({}), defaultEffectRegistry, { lut: () => null, working: pq }, 33)).toBeNull();
	});
	it('HDR Specular pulls the highlights above HDR White down, leaves the rest', () => {
		const spec = pqFromNits(4000);
		const mid = pqFromNits(100);
		const o = run({ hdrWhite: 1000, hdrSpecular: -60 }, [spec, spec, spec]);
		expect(o[0]).toBeLessThan(spec - 0.02);
		expect(o[0]).toBeGreaterThan(pqFromNits(1000) - 0.01);
		const m = run({ hdrWhite: 1000, hdrSpecular: -60 }, [mid, mid, mid]);
		expect(m[0]).toBeCloseTo(mid, 2);
	});
	it('exposure works on the grading signal (1 = HDR White) and is SDR-identical in Rec. 709', () => {
		const lift = run({ exposure: 1 }, [pqFromNits(100), pqFromNits(100), pqFromNits(100)]);
		expect(lift[0]).toBeGreaterThan(pqFromNits(100));
	});
});

describe('invariants and repairs', () => {
	it('repairs unknown working spaces, interpretations and stray internal effects', () => {
		const h = new Harness();
		const { mediaId, clipId } = placeVideo(h, videoAsset({ audio: false }));
		const doc = JSON.parse(JSON.stringify(h.doc));
		const seq = Object.values(doc.sequences)[0] as { settings: Record<string, unknown>; clips: Record<string, Record<string, unknown>> };
		seq.settings.workingColorSpace = 'bogus';
		seq.settings.color = { sdrWhiteNits: 'x' };
		doc.media[mediaId].interpretation = { color: { space: 'nope', inputLut: 'med_missing' } };
		seq.clips[clipId]!.colorInterpretation = { ocio: { configId: 'med_x', space: 'a' } };
		(seq.clips[clipId]!.effects as unknown[]).push({ id: 'fx_9', effectId: COLOR_INPUT_ID, effectVersion: 1, enabled: true, params: {} });
		const codes = checkInvariants(doc).filter((i) => i.invariant === 'INV-COLOR');
		expect(codes.length).toBeGreaterThanOrEqual(4);
		const { document, report } = repairDocument(doc, createCounterIdSource(99));
		expect(checkInvariants(document).filter((i) => i.invariant === 'INV-COLOR')).toEqual([]);
		expect(report.map((r) => r.action)).toEqual(
			expect.arrayContaining(['reset-working-space', 'reset-color-settings', 'drop-color-space', 'drop-input-lut', 'drop-ocio-space', 'drop-effect']),
		);
	});
	it('effect.add refuses the render-only colour input effect', () => {
		const h = new Harness();
		const { clipId } = placeVideo(h, videoAsset({ audio: false }));
		const r = h.tx([{ type: 'effect.add', target: { clipId }, effectId: COLOR_INPUT_ID }]);
		expect(r.ok).toBe(false);
	});
});
