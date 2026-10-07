// Roto / object matte model (parity workstream `roto`): roto.* commands with refusals and undo (immutable
// transactions), staleness, the snapshot's matte references and frame states, export issues, copies with new ids,
// paste sanitising, source retargeting, invariants and repairs, face trackers.
import { describe, expect, it } from 'vitest';
import {
	buildEffectsPayload,
	buildRenderSnapshot,
	type Clip,
	type ClipRoto,
	type ClipTracker,
	checkInvariants,
	createCounterIdSource,
	defaultEffectRegistry,
	type EffectInstance,
	fnv64,
	OBJECT_BLUR_EFFECT_ID,
	OBJECT_MATTE_EFFECT_ID,
	repairDocument,
	rotoExportIssues,
	rotoFrameState,
	rotoFrameUrl,
	rotoInputsHash,
	rotoIsStale,
	rotoSettingsOf,
} from '../src/index.ts';
import { Harness } from './helpers.ts';

type RClip = Clip & { rotos?: ClipRoto[]; effects?: EffectInstance[]; trackers?: ClipTracker[] };

function setup() {
	const h = new Harness();
	const m = h.registerVideo({ seconds: 4, audio: false });
	h.ok([
		{
			type: 'clip.place',
			source: { mediaId: m },
			at: 0,
			sourceRange: { in: { seconds: 1 }, out: { seconds: 3 } },
		},
	]);
	const clipId = h.clips('V1')[0]!.id;
	return { h, m, clipId, clip: () => h.seq.clips[clipId] as RClip };
}

const result = (r: ClipRoto, start: number, end: number) => ({
	key: '0123456789abcdef0123456789abcdef',
	start,
	end,
	width: 1920,
	height: 1080,
	inputs: rotoInputsHash(r),
	model: 'sam2.1-hiera-tiny',
});

describe('roto commands', () => {
	it('roto.add with a stroke sets the base and the default span (the source frames the clip shows)', () => {
		const { h, m, clip } = setup();
		const before = h.doc;
		const r = h.ok([
			{
				type: 'roto.add',
				clipId: clip().id,
				at: { frames: 10 },
				strokes: [
					{
						kind: 'fg',
						radius: 12,
						points: [
							[900, 500],
							[1000, 520],
						],
					},
				],
				ref: '$r',
			},
		]);
		const out = r.results[0] as { rotoId: string; frame: number; span: number[]; base: number };
		expect(out.frame).toBe(40); // 1 s in + 10 frames at 30 fps
		expect(out.span).toEqual([30, 89]);
		expect(out.base).toBe(40);
		const roto = clip().rotos![0]!;
		expect(roto).toMatchObject({ kind: 'brush', mediaId: m, name: 'Roto 1', base: 40, result: null });
		expect(roto.strokes[0]).toMatchObject({ kind: 'fg', frame: 40, radius: 12 });
		// Undo = the previous immutable document.
		expect((before.sequences[h.seqId]!.clips[clip().id] as RClip).rotos).toBeUndefined();
		expect(checkInvariants(h.doc, { effects: defaultEffectRegistry })).toEqual([]);
	});

	it('points become one-point strokes; a box selects; background strokes do not set the base', () => {
		const { h, clip } = setup();
		h.ok([{ type: 'roto.add', clipId: clip().id, at: { frames: 0 }, points: [{ x: 10, y: 10, fg: false }] }]);
		let roto = clip().rotos![0]!;
		expect(roto.base).toBeNull();
		expect(roto.strokes[0]).toMatchObject({ kind: 'bg', radius: 11, points: [[10, 10]] });
		h.ok([{ type: 'roto.setBox', rotoId: roto.id, at: { frames: 5 }, rect: [100, 100, 600, 500] }]);
		roto = clip().rotos![0]!;
		expect(roto.base).toBe(35);
		expect(roto.boxes).toEqual([{ frame: 35, rect: [100, 100, 600, 500] }]);
		h.ok([{ type: 'roto.setBox', rotoId: roto.id, at: { frames: 5 }, rect: null }]);
		expect(clip().rotos![0]!.base).toBeNull();
		expect(clip().rotos![0]!.boxes).toBeUndefined();
	});

	it('refuses bad input: kinds, empty boxes, spans, frozen edits, unknown rotos', () => {
		const { h, clip } = setup();
		h.ok([{ type: 'clip.addSolid', at: 0, duration: 30, track: 'V2', color: [0, 1, 0, 1] }]);
		const solid = h.clips('V2')[0]!.id;
		const bad = (cmds: unknown[], code: string) => {
			const r = h.tx(cmds);
			expect(r.ok).toBe(false);
			if (!r.ok) expect(r.errors[0]!.code).toBe(code);
		};
		bad([{ type: 'roto.add', clipId: solid }], 'E_INVALID_PARAM');
		bad([{ type: 'roto.add', clipId: clip().id, box: [10, 10, 5, 50] }], 'E_INVALID_PARAM');
		bad([{ type: 'roto.add', clipId: clip().id, span: [10, 5] }], 'E_INVALID_PARAM');
		bad([{ type: 'roto.add', clipId: clip().id, span: [0, 500] }], 'E_OUT_OF_MEDIA');
		bad(
			[{ type: 'roto.add', clipId: clip().id, kind: 'faces', points: [{ x: 1, y: 1 }] }],
			'E_INVALID_PARAM',
		);
		bad(
			[{ type: 'roto.addStrokes', rotoId: 'rto_0000000000000000', points: [{ x: 1, y: 1 }] }],
			'E_NOT_FOUND',
		);
		h.ok([{ type: 'roto.add', clipId: clip().id, points: [{ x: 5, y: 5 }] }]);
		const roto = clip().rotos![0]!;
		bad([{ type: 'roto.freeze', rotoId: roto.id, frozen: true }], 'E_INVALID_PARAM'); // nothing computed
		h.ok([{ type: 'roto.setResult', rotoId: roto.id, result: result(roto, 30, 89) }]);
		h.ok([{ type: 'roto.freeze', rotoId: roto.id, frozen: true }]);
		bad([{ type: 'roto.addStrokes', rotoId: roto.id, points: [{ x: 9, y: 9 }] }], 'E_INVALID_PARAM');
		bad([{ type: 'roto.update', rotoId: roto.id, settings: { searchRadius: 30 } }], 'E_INVALID_PARAM');
		bad([{ type: 'roto.setResult', rotoId: roto.id, result: null }], 'E_INVALID_PARAM');
		h.ok([{ type: 'roto.update', rotoId: roto.id, name: 'Renamed' }]); // names are fine
		h.ok([{ type: 'roto.freeze', rotoId: roto.id, frozen: false }]);
		h.ok([{ type: 'roto.addStrokes', rotoId: roto.id, points: [{ x: 9, y: 9 }] }]);
	});

	it('results go stale when inputs change and fresh again on undo-equivalent inputs', () => {
		const { h, clip } = setup();
		h.ok([{ type: 'roto.add', clipId: clip().id, points: [{ x: 5, y: 5 }] }]);
		const roto = clip().rotos![0]!;
		h.ok([{ type: 'roto.setResult', rotoId: roto.id, result: result(roto, 30, 89) }]);
		expect(rotoIsStale(clip().rotos![0]!)).toBe(false);
		h.ok([
			{
				type: 'roto.addStrokes',
				rotoId: roto.id,
				at: { frames: 20 },
				strokes: [{ kind: 'bg', radius: 4, points: [[1, 1]] }],
			},
		]);
		expect(rotoIsStale(clip().rotos![0]!)).toBe(true);
		h.ok([{ type: 'roto.removeStrokes', rotoId: roto.id, at: { frames: 20 }, last: 1 }]);
		expect(rotoIsStale(clip().rotos![0]!)).toBe(false);
		// Settings are part of the inputs (defaults resolved).
		h.ok([{ type: 'roto.update', rotoId: roto.id, settings: { searchRadius: 15 } }]);
		expect(rotoIsStale(clip().rotos![0]!)).toBe(false); // 15 is the default
		h.ok([{ type: 'roto.update', rotoId: roto.id, settings: { searchRadius: 25 } }]);
		expect(rotoIsStale(clip().rotos![0]!)).toBe(true);
		expect(rotoSettingsOf(clip().rotos![0]!).searchRadius).toBe(25);
	});

	it('roto.apply adds a bound Object Matte / Object Blur once; roto.remove removes them', () => {
		const { h, clip } = setup();
		h.ok([{ type: 'roto.add', clipId: clip().id, points: [{ x: 5, y: 5 }], ref: '$r' }]);
		const id = clip().rotos![0]!.id;
		const a = h.ok([{ type: 'roto.apply', rotoId: id, params: { view: 'overlay' } }]).results[0] as {
			effectInstanceId: string;
			created: boolean;
		};
		expect(a.created).toBe(true);
		const fx = clip().effects!.find((e) => e.id === a.effectInstanceId)!;
		expect(fx.effectId).toBe(OBJECT_MATTE_EFFECT_ID);
		expect(fx.params.object!.value).toBe(id);
		expect(fx.params.view!.value).toBe('overlay');
		const again = h.ok([{ type: 'roto.apply', rotoId: id, params: { feather: 4 } }]).results[0] as {
			effectInstanceId: string;
			created: boolean;
		};
		expect(again).toMatchObject({ effectInstanceId: a.effectInstanceId, created: false });
		h.ok([{ type: 'roto.apply', rotoId: id, effect: 'blur' }]);
		expect(clip().effects!.map((e) => e.effectId)).toEqual([OBJECT_MATTE_EFFECT_ID, OBJECT_BLUR_EFFECT_ID]);
		expect(h.tx([{ type: 'roto.apply', rotoId: id, params: { object: 'x' } }]).ok).toBe(false);
		const rm = h.ok([{ type: 'roto.remove', rotoIds: [id] }]).results[0] as { removedEffects: string[] };
		expect(rm.removedEffects).toHaveLength(2);
		expect(clip().rotos).toBeUndefined();
		expect(clip().effects!.length).toBe(0);
	});

	it('the snapshot carries every roto with its span; frame states', () => {
		const { h, clip } = setup();
		h.ok([{ type: 'roto.add', clipId: clip().id, points: [{ x: 5, y: 5 }] }]);
		const roto = clip().rotos![0]!;
		h.ok([{ type: 'roto.apply', rotoId: roto.id }]);
		const snap0 = buildRenderSnapshot(h.doc, h.seqId, { resolveMedia: () => null, resolveFont: () => null });
		const m0 = snap0.videoTracks[0]!.clips[0]!.rotos![roto.id]!;
		expect(m0).toMatchObject({ key: null, url: null, span: [30, 89] });
		expect(rotoFrameState(m0, 40)).toBe('missing');
		expect(rotoFrameState(m0, 10)).toBe('outside');
		expect(rotoExportIssues(snap0)[0]).toMatchObject({ kind: 'not-computed', frames: [30, 89] });
		h.ok([{ type: 'roto.setResult', rotoId: roto.id, result: result(clip().rotos![0]!, 30, 60) }]);
		const snap = buildRenderSnapshot(h.doc, h.seqId, {
			resolveMedia: () => null,
			resolveFont: () => null,
			resolveRoto: (k) => `http://e/mg/roto/${k}?sig=x`,
		});
		const m = snap.videoTracks[0]!.clips[0]!.rotos![roto.id]!;
		expect(m.url).toBe('http://e/mg/roto/0123456789abcdef0123456789abcdef?sig=x');
		expect(rotoFrameUrl(m, 42)).toBe('http://e/mg/roto/0123456789abcdef0123456789abcdef?sig=x&n=42');
		expect(rotoFrameState(m, 42)).toBe('matte');
		expect(rotoFrameState(m, 70)).toBe('missing');
		expect(rotoExportIssues(snap)[0]).toMatchObject({ kind: 'not-computed', frames: [61, 89] });
		h.ok([{ type: 'roto.setResult', rotoId: roto.id, result: result(clip().rotos![0]!, 30, 89) }]);
		const ok = buildRenderSnapshot(h.doc, h.seqId, { resolveMedia: () => null, resolveFont: () => null });
		expect(rotoExportIssues(ok)).toEqual([]);
		h.ok([{ type: 'roto.addStrokes', rotoId: roto.id, points: [{ x: 50, y: 50 }] }]);
		const stale = buildRenderSnapshot(h.doc, h.seqId, { resolveMedia: () => null, resolveFont: () => null });
		expect(rotoExportIssues(stale)[0]).toMatchObject({ kind: 'stale' });
		// A disabled effect does not matter.
		h.ok([{ type: 'effect.setEnabled', effectInstanceId: clip().effects![0]!.id, enabled: false }]);
		const off = buildRenderSnapshot(h.doc, h.seqId, { resolveMedia: () => null, resolveFont: () => null });
		expect(rotoExportIssues(off)).toEqual([]);
	});

	it('split / duplicate copy rotos with new ids and rebind the copies’ effects', () => {
		const { h, clip } = setup();
		h.ok([{ type: 'roto.add', clipId: clip().id, points: [{ x: 5, y: 5 }] }]);
		const id = clip().rotos![0]!.id;
		h.ok([{ type: 'roto.apply', rotoId: id }]);
		h.ok([{ type: 'clip.split', clipIds: [clip().id], at: 20 }]);
		const [left, right] = h.clips('V1') as RClip[];
		expect(left!.rotos![0]!.id).toBe(id);
		const rid = right!.rotos![0]!.id;
		expect(rid).not.toBe(id);
		expect(right!.effects![0]!.params.object!.value).toBe(rid);
		expect(checkInvariants(h.doc, { effects: defaultEffectRegistry })).toEqual([]);
	});

	it('pasted effects naming a roto the target lacks are reset to none', () => {
		const { h, clip, m } = setup();
		h.ok([{ type: 'roto.add', clipId: clip().id, points: [{ x: 5, y: 5 }] }]);
		h.ok([{ type: 'roto.apply', rotoId: clip().rotos![0]!.id }]);
		h.ok([
			{
				type: 'clip.place',
				source: { mediaId: m },
				at: 100,
				sourceRange: { in: { seconds: 0 }, out: { seconds: 1 } },
			},
		]);
		const other = h.clips('V1')[1]!.id;
		const payload = JSON.parse(JSON.stringify(buildEffectsPayload(h.doc, clip().id)));
		const r = h.tx([{ type: 'effect.paste', clipIds: [other], payload }]);
		expect(r.ok, JSON.stringify(!r.ok && r.errors)).toBe(true);
		{
			const fx = (h.seq.clips[other] as RClip).effects!.find((e) => e.effectId === OBJECT_MATTE_EFFECT_ID);
			expect(fx?.params.object?.value).toBe('');
		}
		expect(checkInvariants(h.doc, { effects: defaultEffectRegistry })).toEqual([]);
	});

	it('invariants catch dangling references; repairs fix them', () => {
		const { h, clip } = setup();
		h.ok([{ type: 'roto.add', clipId: clip().id, points: [{ x: 5, y: 5 }] }]);
		h.ok([{ type: 'roto.apply', rotoId: clip().rotos![0]!.id }]);
		const broken = structuredClone(h.doc);
		const c = broken.sequences[h.seqId]!.clips[clip().id] as RClip;
		c.rotos![0]!.base = 9999;
		(c.effects![0]!.params.object as { value: unknown }).value = 'rto_ffffffffffffffff';
		const issues = checkInvariants(broken, { effects: defaultEffectRegistry }).map((i) => i.invariant);
		expect(issues).toContain('INV-006');
		expect(issues).toContain('INV-012');
		const { document, report } = repairDocument(broken, createCounterIdSource(99));
		expect(report.map((r) => r.action)).toEqual(expect.arrayContaining(['fix-roto', 'drop-reference']));
		expect(checkInvariants(document, { effects: defaultEffectRegistry })).toEqual([]);
	});

	it('roto.faceTracker turns a tracked face into a planar tracker and applies it as transform keys', () => {
		const { h, clip } = setup();
		h.ok([{ type: 'roto.add', clipId: clip().id, kind: 'faces' }]);
		const roto = clip().rotos![0]!;
		expect(roto).toMatchObject({ kind: 'faces', name: 'Faces 1', base: 30 });
		const poses: number[] = [];
		const present: number[] = [];
		for (let i = 0; i < 60; i++) {
			poses.push(900 + 2 * i, 500, 200, 0.01 * i);
			present.push(i === 10 ? 0 : 1);
		}
		h.ok([
			{
				type: 'roto.setResult',
				rotoId: roto.id,
				result: {
					...result(roto, 30, 89),
					model: 'mediapipe-face-landmarker',
					faces: [{ id: 0, startFrame: 30, poses, present }],
				},
			},
		]);
		h.ok([{ type: 'clip.addSolid', at: 0, duration: 60, track: 'V2', color: [0, 0, 0, 1] }]);
		const target = h.clips('V2')[0]!.id;
		const r = h.ok([{ type: 'roto.faceTracker', rotoId: roto.id, faceId: 0, targetClipId: target }])
			.results[0] as {
			trackerId: string;
			frames: number;
		};
		expect(r.frames).toBe(60);
		const tr = clip().trackers!.find((t) => t.id === r.trackerId)!;
		expect(tr.kind).toBe('planar');
		expect(tr.samples!.confidence[10]).toBe(0);
		expect(tr.samples!.data.length).toBe(60 * 8);
		const pos = (h.seq.clips[target] as Clip & { transform: { position: { keyframes: unknown[] } } })
			.transform.position;
		expect(pos.keyframes.length).toBeGreaterThan(10);
		expect(h.tx([{ type: 'roto.faceTracker', rotoId: roto.id, faceId: 7 }]).ok).toBe(false);
	});

	it('fnv64 is stable', () => {
		expect(fnv64('')).toBe('cbf29ce484222325');
		expect(fnv64('a')).toBe('af63dc4c8601ec8c');
	});
});

describe('roto × Time Remapping (workstream `time`)', () => {
	it('export checks the media frames the remapped picture shows, not the linear content frames', () => {
		const { h, clip } = setup();
		h.ok([{ type: 'roto.add', clipId: clip().id, points: [{ x: 5, y: 5 }] }]);
		const roto = clip().rotos![0]!;
		h.ok([{ type: 'roto.apply', rotoId: roto.id }]);
		h.ok([{ type: 'roto.setResult', rotoId: roto.id, result: result(clip().rotos![0]!, 30, 60) }]);
		const snap = () =>
			buildRenderSnapshot(h.doc, h.seqId, { resolveMedia: () => null, resolveFont: () => null });
		expect(rotoExportIssues(snap())[0]).toMatchObject({ kind: 'not-computed', frames: [61, 89] });
		// 50 % over the whole clip, then keep its first 60 frames: the picture shows media frames 30–59 only.
		h.ok([{ type: 'timeRemap.setSpeed', clipId: clip().id, at: 0, speedPercent: 50 }]);
		expect(clip().duration).toBe(120);
		h.ok([{ type: 'clip.trim', clipId: clip().id, edge: 'out', deltaFrames: -60 }]);
		expect(rotoExportIssues(snap())).toEqual([]);
		// Back to the full slowed clip: media frames 61–89 are shown again and missing.
		h.ok([{ type: 'clip.trim', clipId: clip().id, edge: 'out', deltaFrames: 60 }]);
		expect(rotoExportIssues(snap())[0]).toMatchObject({ kind: 'not-computed', frames: [61, 89] });
	});
});
