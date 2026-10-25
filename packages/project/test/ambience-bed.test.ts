// Ambience and room-tone beds in the model (spec 12 §4 P6-E12; wp-note "Phase 6 → WP-E8"): the scene structure a bed
// follows, the layout of looped pieces (every piece and every crossfade handle inside the loop, every joint the matched
// one), `soundDesign.layBed` (clips, crossfades, fades, Essential Sound type, ducking, replace; undo / redo; refusals),
// dialogue regions and gaps for room tone, the `bed` metadata's invariant and repair, and properties on hostile input.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	type AudioClip,
	applyTransaction,
	bedScenes,
	checkInvariants,
	createCounterIdSource,
	dialogueGaps,
	dialogueRegions,
	evaluate,
	FLICKS_PER_SECOND,
	flicksPerFrame,
	insideDialogueRegion,
	mergeSpans,
	planBedLayout,
	readClipBed,
	repairDocument,
	roomToneGainDb,
	roomToneSpan,
	transitionSpan,
} from '../src/index.ts';
import { Harness } from './helpers.ts';

const S = FLICKS_PER_SECOND;
const R30 = { num: 30, den: 1 };
const F30 = flicksPerFrame(R30);
/** Three scenes on V1 (media A 0–200, B 200–400, C 400–600) and a 4 s ambience. */
function threeScenes(h: Harness) {
	const ids: string[] = [];
	for (let i = 0; i < 3; i++) {
		const m = h.registerVideo({ seconds: 10, audio: false });
		h.ok([
			{ type: 'clip.place', source: { mediaId: m }, at: i * 200, tracks: { video: 'V1' }, audio: false },
		]);
		const c = h.clips('V1').find((x) => x.start === i * 200)!;
		h.ok([{ type: 'clip.trim', clipId: c.id, edge: 'out', deltaFrames: 200 - c.duration }]);
		ids.push(m);
	}
	const amb = h.registerVideo({ kind: 'audio', seconds: 4 });
	return { scenes: ids, amb };
}

const shotsOf = (sc: { start: number; end: number }[]) => sc.map((s) => ({ start: s.start, end: s.end }));

describe('scenes', () => {
	it('a cut to other footage starts a scene; a cut inside one media does not; markers and shot changes do', () => {
		const h = new Harness();
		const { scenes } = threeScenes(h);
		let sc = bedScenes(h.doc, h.seq);
		expect(sc.map((s) => [s.start, s.end, s.reason])).toEqual([
			[0, 200, 'start'],
			[200, 400, 'edit'],
			[400, 600, 'edit'],
		]);
		expect(sc.map((s) => s.mediaId)).toEqual(scenes);
		// split clip B: the same media on both sides, a shot run of one place
		const b = h.clips('V1').find((c) => c.start === 200)!;
		h.ok([{ type: 'clip.split', clipIds: [b.id], at: 300 }]);
		expect(bedScenes(h.doc, h.seq).length).toBe(3);
		// a chapter marker at 500 and a marker named "Scene 5" at 560 (a 40-frame scene: joined to the one before)
		h.ok([{ type: 'marker.add', frame: 500, name: 'Night', markerType: 'chapter' }]);
		h.ok([{ type: 'marker.add', frame: 560, name: 'Scene 5' }]);
		sc = bedScenes(h.doc, h.seq);
		expect(sc.map((s) => [s.start, s.end, s.reason])).toEqual([
			[0, 200, 'start'],
			[200, 400, 'edit'],
			[400, 500, 'edit'],
			[500, 600, 'marker'],
		]);
		expect(sc[3]!.label).toBe('Night');
		// measured shot changes, a range, the edits off
		expect(bedScenes(h.doc, h.seq, { shotCuts: [100] }).map((s) => s.start)).toEqual([0, 100, 200, 400, 500]);
		expect(
			bedScenes(h.doc, h.seq, { range: { start: 150, end: 450 }, minSceneSec: 0 }).map((s) => [
				s.start,
				s.end,
			]),
		).toEqual([
			[150, 200],
			[200, 400],
			[400, 450],
		]);
		// with the 2 s minimum, the 50-frame ends join the middle scene
		expect(bedScenes(h.doc, h.seq, { range: { start: 150, end: 450 } }).map((s) => [s.start, s.end])).toEqual(
			[[150, 450]],
		);
		expect(bedScenes(h.doc, h.seq, { sources: { edits: false, markers: false } })).toHaveLength(1);
		// a scene under 2 s joins a neighbour: here the next one, which only starts at a measured shot change
		expect(bedScenes(h.doc, h.seq, { shotCuts: [420] }).map((s) => [s.start, s.end])).toEqual([
			[0, 200],
			[200, 400],
			[400, 500],
			[500, 600],
		]);
	});

	it('never throws on hostile documents', () => {
		const h = new Harness();
		expect(bedScenes(h.doc, h.seq)).toEqual([]);
		expect(bedScenes(h.doc, { settings: {} } as never)).toEqual([]);
		expect(bedScenes(null as never, null as never)).toEqual([]);
	});
});

describe('layout', () => {
	const shotIn = (start: number, end: number, loopSec: [number, number], mediaSec = 10) => ({
		start,
		end,
		mediaId: 'med_x',
		mediaFlicks: mediaSec * S,
		loop: { inFlicks: Math.round(loopSec[0] * S), outFlicks: Math.round(loopSec[1] * S) },
	});

	it('3 scenes over 20 s of a 4 s loop: pieces of the loop, 1.5 s crossfades at the loop joints, 0.5 s at scene changes', () => {
		const r = planBedLayout(
			[shotIn(0, 200, [0, 4], 4), shotIn(200, 400, [0, 4], 4), shotIn(400, 600, [0, 4], 4)],
			{ fps: R30, crossfadeFrames: 45, sceneCrossfadeFrames: 15, fadeFrames: 30 },
		);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const run = r.layout.runs[0]!;
		expect(r.layout.runs).toHaveLength(1);
		expect(r.layout.shortened).toEqual([]);
		// contiguous, covering 0…600
		let t = 0;
		for (const p of run.pieces) {
			expect(p.start).toBe(t);
			t += p.frames;
		}
		expect(t).toBe(600);
		expect(run.joins.filter((j) => j.kind === 'scene').map((j) => [j.at, j.frames])).toEqual([
			[200, 15],
			[400, 15],
		]);
		expect(run.joins.filter((j) => j.kind === 'loop').every((j) => j.frames === 45)).toBe(true);
		expect(run.joins.filter((j) => j.kind === 'loop').length).toBeGreaterThanOrEqual(3);
		expect([run.fadeIn, run.fadeOut]).toEqual([30, 30]);
	});

	it('property: every piece and every handle stays in its loop; every loop joint is the matched one; crossfades fit', () => {
		fc.assert(
			fc.property(
				fc.array(fc.record({ len: fc.integer({ min: 2, max: 900 }), gap: fc.integer({ min: 0, max: 60 }) }), {
					minLength: 1,
					maxLength: 6,
				}),
				fc.double({ min: 0.2, max: 30, noNaN: true }),
				fc.double({ min: 0, max: 5, noNaN: true }),
				fc.integer({ min: 2, max: 90 }),
				fc.integer({ min: 0, max: 30 }),
				fc.integer({ min: 0, max: 60 }),
				(spec, loopLen, loopIn, X, Sx, fade) => {
					let at = 0;
					const shots = spec.map((s, i) => {
						const start = at + (i ? s.gap : 0);
						at = start + s.len;
						return shotIn(start, at, [loopIn, loopIn + loopLen], loopIn + loopLen + 1);
					});
					const r = planBedLayout(shots, {
						fps: R30,
						crossfadeFrames: X,
						sceneCrossfadeFrames: Sx,
						fadeFrames: fade,
					});
					if (!r.ok) {
						// only a loop under 4 frames is refused
						return Math.floor((loopLen * S) / F30 + 1e-9) < 4;
					}
					const a = Math.round(loopIn * S);
					const W = Math.floor((Math.round((loopIn + loopLen) * S) - a) / F30 + 1e-9);
					const bEnd = a + W * F30;
					for (const run of r.layout.runs) {
						for (const j of run.joins) {
							const span = transitionSpan(j.at, j.frames, 'center');
							const out = run.pieces.find((p) => p.start + p.frames === j.at);
							const inc = run.pieces.find((p) => p.start === j.at);
							if (!out || !inc) return false;
							// inside both clips (positive comparisons also reject NaN)
							if (!(span.start >= out.start && span.end <= inc.start + inc.frames)) return false;
							// the handles: the outgoing piece's source runs on past its Out, the incoming one's before its In
							const outEnd = out.sourceInFlicks + out.frames * F30 + (span.end - j.at) * F30;
							const incStart = inc.sourceInFlicks - (j.at - span.start) * F30;
							if (!(outEnd <= bEnd + 1 && incStart >= a - 1)) return false;
							if (j.kind === 'loop') {
								// the matched joint: the outgoing tail ends at the loop's end, the incoming head starts at its start
								if (!(Math.abs(outEnd - bEnd) <= 1 && Math.abs(incStart - a) <= 1)) return false;
							}
						}
						for (const p of run.pieces) {
							if (!(p.sourceInFlicks >= a - 1 && p.sourceInFlicks + p.frames * F30 <= bEnd + 1)) return false;
						}
						const first = run.pieces[0];
						const last = run.pieces[run.pieces.length - 1];
						if (!first || !last || !(run.fadeIn <= first.frames && run.fadeOut <= last.frames)) return false;
					}
					return true;
				},
			),
			{ numRuns: 250 },
		);
	});

	it('refuses overlapping shots, too-short shots and loops', () => {
		const o = { fps: R30, crossfadeFrames: 45, sceneCrossfadeFrames: 15, fadeFrames: 30 };
		expect(planBedLayout([shotIn(0, 100, [0, 4]), shotIn(50, 150, [0, 4])], o)).toMatchObject({ ok: false });
		expect(planBedLayout([shotIn(0, 1, [0, 4])], o)).toMatchObject({ ok: false });
		expect(planBedLayout([shotIn(0, 100, [0, 0.1])], o)).toMatchObject({
			ok: false,
			code: 'E_INVALID_PARAM',
		});
		// a short loop shortens the crossfade
		const r = planBedLayout([shotIn(0, 300, [0, 1])], o);
		expect(r.ok && r.layout.shortened).toEqual([0]);
	});
});

describe('soundDesign.layBed', () => {
	it('lays the 3-scene bed: Ambience track, crossfades, fades, Essential ambience, grouped', () => {
		const h = new Harness();
		const { amb } = threeScenes(h);
		const shots = shotsOf(bedScenes(h.doc, h.seq));
		const cmd = {
			type: 'soundDesign.layBed',
			shots,
			mediaId: amb,
			loop: { inSec: 0, outSec: 4 },
			gainDb: -18,
		};
		const r = h.ok([cmd]);
		expect(r.warnings.filter((w) => w.code === 'W_TRANSITION_SHORTENED')).toEqual([]);
		const res = r.results[0] as {
			trackId: string;
			trackCreated: boolean;
			clipIds: string[];
			transitionIds: string[];
			beds: { start: number; end: number; pieces: number; crossfadeFrames: number }[];
		};
		expect(res.trackCreated).toBe(true);
		const track = h.seq.audioTracks.find((t) => t.id === res.trackId)!;
		expect(track.name).toBe('Ambience');
		expect(res.beds.map((b) => [b.start, b.end, b.crossfadeFrames])).toEqual([
			[0, 200, 45],
			[200, 400, 45],
			[400, 600, 45],
		]);
		const clips = res.clipIds.map(
			(id) => h.seq.clips[id] as AudioClip & { bed?: unknown; essential?: { type?: string } },
		);
		expect(clips.every((c) => c.essential?.type === 'ambience' && c.gainDb === -18)).toBe(true);
		expect(clips.every((c) => readClipBed(c.bed)?.purpose === 'ambience')).toBe(true);
		expect(clips.every((c) => c.groupId && c.groupId === clips[0]!.groupId)).toBe(true);
		expect(clips[0]!.name).toMatch(/\(Bed 1\/\d\)$/);
		const tr = Object.values(h.seq.transitions);
		const loops = tr.filter((t) => t.outgoingClipId && t.incomingClipId && t.duration === 45);
		const scenes = tr.filter((t) => t.outgoingClipId && t.incomingClipId && t.duration === 15);
		const fades = tr.filter((t) => !t.outgoingClipId || !t.incomingClipId);
		expect(loops.length).toBeGreaterThanOrEqual(3);
		expect(loops.every((t) => t.alignment === 'center' && t.effectId === 'jasper.constant-power')).toBe(true);
		expect(scenes).toHaveLength(2);
		expect(fades.map((t) => t.duration)).toEqual([30, 30]);
		expect(checkInvariants(h.doc)).toEqual([]);
		// every piece plays inside the 4 s media
		for (const c of clips) {
			expect(c.sourceIn).toBeGreaterThanOrEqual(0);
			expect(c.sourceIn + c.duration * F30).toBeLessThanOrEqual(4 * S);
		}
	});

	it('range, replace, a second bed on another track, a per-shot bed, equal-gain loop joints', () => {
		const h = new Harness();
		const { amb } = threeScenes(h);
		const amb2 = h.registerVideo({ kind: 'audio', seconds: 30 });
		const first = h.ok([
			{ type: 'soundDesign.layBed', range: { start: 0, end: 600 }, mediaId: amb, fade: 'equal-gain' },
		]);
		const firstIds = (first.results[0] as { clipIds: string[] }).clipIds;
		expect(
			Object.values(h.seq.transitions)
				.filter((t) => t.duration === 45)
				.every((t) => t.effectId === 'jasper.constant-gain'),
		).toBe(true);
		// without replace: a new "Ambience 2" track
		const second = h.ok([{ type: 'soundDesign.layBed', range: { start: 0, end: 300 }, mediaId: amb2 }]);
		const r2 = second.results[0] as { trackId: string; trackCreated: boolean };
		expect(r2.trackCreated).toBe(true);
		expect(h.seq.audioTracks.find((t) => t.id === r2.trackId)!.name).toBe('Ambience 2');
		// replace: both earlier beds over 0–600 go, the new one lays on the free "Ambience" track
		const third = h.ok([
			{
				type: 'soundDesign.layBed',
				shots: [
					{ start: 0, end: 300 },
					{ start: 300, end: 600, mediaId: amb2, loop: { inSec: 5, outSec: 25 } },
				],
				mediaId: amb,
				replace: true,
			},
		]);
		const r3 = third.results[0] as {
			replacedClipIds: string[];
			trackCreated: boolean;
			beds: { mediaId: string }[];
		};
		expect(r3.replacedClipIds.length).toBeGreaterThan(firstIds.length);
		expect(firstIds.every((id) => !h.seq.clips[id])).toBe(true);
		expect(r3.trackCreated).toBe(false);
		expect(r3.beds.map((b) => b.mediaId)).toEqual([amb, amb2]);
		// the second shot's pieces play inside 5–25 s of their media
		const pieces = Object.values(h.seq.clips).filter(
			(c) => c.kind === 'audio' && (c as AudioClip).mediaId === amb2,
		);
		expect(pieces.every((c) => c.sourceIn >= 5 * S - 1 && c.sourceIn + c.duration * F30 <= 25 * S + 1)).toBe(
			true,
		);
		expect(checkInvariants(h.doc)).toEqual([]);
	});

	it('ducks under the dialogue with Volume keyframes (−10 dB)', () => {
		const h = new Harness();
		const { amb } = threeScenes(h);
		const voice = h.registerVideo({ kind: 'audio', seconds: 3 });
		h.ok([{ type: 'clip.place', source: { mediaId: voice }, at: 150, tracks: { audio: 'A1' } }]);
		const v = h.clips('A1')[0]!;
		h.ok([{ type: 'essentialSound.setType', clipIds: [v.id], audioType: 'dialogue' }]);
		const r = h.ok([
			{ type: 'soundDesign.layBed', range: { start: 0, end: 600 }, mediaId: amb, duckUnder: 'dialogue' },
		]);
		const res = r.results[0] as { clipIds: string[]; ducked: number };
		expect(res.ducked).toBe(1);
		// the piece playing at 4.5 s (frame 135 + its dialogue's middle 195) is 10 dB down at frame 195
		const piece = res.clipIds
			.map((id) => h.seq.clips[id] as AudioClip)
			.find((c) => c.start <= 195 && c.start + c.duration > 195)!;
		const at = (f: number) => piece.sourceIn + (f - piece.start) * F30;
		expect(evaluate(piece.volumeDb, at(195))).toBeCloseTo(-10, 1);
		expect(checkInvariants(h.doc)).toEqual([]);
		// nothing to duck: a warning, no keyframes
		const h2 = new Harness();
		const t2 = threeScenes(h2);
		const r2 = h2.ok([
			{ type: 'soundDesign.layBed', range: { start: 0, end: 600 }, mediaId: t2.amb, duckUnder: 'dialogue' },
		]);
		expect(r2.warnings.some((w) => w.code === 'W_BED_NOTHING_TO_DUCK')).toBe(true);
	});

	it('refusals change nothing', () => {
		const h = new Harness();
		const { amb, scenes } = threeScenes(h);
		const before = h.doc;
		const bad = (c: Record<string, unknown>, code: string) => {
			const r = h.tx([{ type: 'soundDesign.layBed', ...c }]);
			expect(r.ok, JSON.stringify(c)).toBe(false);
			if (!r.ok) expect(r.errors[0]!.code, JSON.stringify(r.errors)).toBe(code);
			expect(h.doc).toBe(before);
		};
		bad({ mediaId: amb }, 'E_INVALID_PARAM');
		bad({ mediaId: amb, range: { start: 0, end: 100 }, shots: [{ start: 0, end: 100 }] }, 'E_INVALID_PARAM');
		bad({ mediaId: 'med_nope', range: { start: 0, end: 100 } }, 'E_NOT_FOUND');
		bad({ mediaId: scenes[0], range: { start: 0, end: 100 } }, 'E_INVALID_PARAM'); // footage without audio
		bad(
			{
				mediaId: amb,
				shots: [
					{ start: 0, end: 100 },
					{ start: 50, end: 150 },
				],
			},
			'E_INVALID_PARAM',
		);
		bad({ mediaId: amb, range: { start: 10, end: 11 } }, 'E_INVALID_PARAM');
		bad({ mediaId: amb, range: { start: 0, end: 100 }, loop: { inSec: 1, outSec: 1.05 } }, 'E_INVALID_PARAM');
		bad({ mediaId: amb, range: { start: 0, end: 100 }, loop: { inSec: 9, outSec: 12 } }, 'E_INVALID_PARAM');
		bad({ mediaId: amb, range: { start: 0, end: 100 }, track: 'V1' }, 'E_TRACK_KIND');
		bad({ mediaId: amb, range: { start: 0, end: 100 }, track: 'A9' }, 'E_NOT_FOUND');
		bad({ mediaId: amb, range: { start: 0, end: 100 }, unknown: 1 }, 'E_SCHEMA');
		// an explicit track with audio there; a locked track
		const v = h.registerVideo({ kind: 'audio', seconds: 3 });
		h.ok([{ type: 'clip.place', source: { mediaId: v }, at: 0, tracks: { audio: 'A1' } }]);
		const withAudio = h.doc;
		const r = h.tx([
			{ type: 'soundDesign.layBed', mediaId: amb, range: { start: 0, end: 100 }, track: 'A1' },
		]);
		expect(r.ok === false && r.errors[0]!.code).toBe('E_OVERLAP');
		h.ok([{ type: 'track.update', trackId: 'A2', patch: { locked: true } }]);
		const r2 = h.tx([
			{ type: 'soundDesign.layBed', mediaId: amb, range: { start: 0, end: 100 }, track: 'A2' },
		]);
		expect(r2.ok === false && r2.errors[0]!.code).toBe('E_TRACK_LOCKED');
		expect(withAudio).not.toBe(before);
	});

	it('never throws on hostile arguments (property): a refusal or a valid document', () => {
		const h = new Harness();
		const { amb } = threeScenes(h);
		fc.assert(
			fc.property(
				fc.record({
					start: fc.oneof(fc.integer({ min: -10, max: 700 }), fc.constant('00:00:01:00')),
					end: fc.integer({ min: -10, max: 900 }),
					inSec: fc.integer({ min: -1000, max: 6000 }).map((ms) => ms / 1000),
					outSec: fc.integer({ min: -1000, max: 6000 }).map((ms) => ms / 1000),
					crossfadeSec: fc.integer({ min: 0, max: 10_000 }).map((ms) => ms / 1000),
					sceneCrossfadeSec: fc.integer({ min: 0, max: 3000 }).map((ms) => ms / 1000),
					fadeSec: fc.integer({ min: 0, max: 5000 }).map((ms) => ms / 1000),
					duck: fc.constantFrom('dialogue', 'heroes', null, undefined),
					purpose: fc.constantFrom('ambience', 'roomtone'),
				}),
				(a) => {
					const { document, result } = applyTransaction(
						h.doc,
						{
							label: 'Lay bed',
							origin: 'user',
							sequenceId: h.seqId,
							commands: [
								{
									type: 'soundDesign.layBed',
									mediaId: amb,
									range: { start: a.start, end: a.end },
									loop: { inSec: a.inSec, outSec: a.outSec },
									crossfadeSec: a.crossfadeSec,
									sceneCrossfadeSec: a.sceneCrossfadeSec,
									fadeSec: a.fadeSec,
									purpose: a.purpose,
									...(a.duck !== undefined ? { duckUnder: a.duck } : {}),
								},
							],
						},
						h.ctx({ ids: createCounterIdSource(1000) }),
					);
					if (result.ok) expect(checkInvariants(document)).toEqual([]);
					else expect(result.errors.some((error) => error.code === 'E_INTERNAL')).toBe(false);
				},
			),
			{
				numRuns: 150,
				examples: [
					[
						{
							start: 0,
							end: 300,
							inSec: 0,
							outSec: 4,
							crossfadeSec: 1.5,
							sceneCrossfadeSec: 0.5,
							fadeSec: 1,
							duck: null,
							purpose: 'ambience',
						},
					],
				],
			},
		);
	});
});

describe('room tone', () => {
	it('dialogue regions, the gaps between dialogue clips, the padded fill, the level', () => {
		const h = new Harness();
		const v = h.registerVideo({ kind: 'audio', seconds: 4 });
		const tone = h.registerVideo({ kind: 'audio', seconds: 30 });
		// dialogue 0–3 s, 4–7 s on A1; 20–22 s (a gap of 13 s: another scene)
		h.ok([{ type: 'clip.place', source: { mediaId: v }, at: 0, tracks: { audio: 'A1' } }]);
		h.ok([{ type: 'clip.place', source: { mediaId: v }, at: 120, tracks: { audio: 'A1' } }]);
		h.ok([{ type: 'clip.place', source: { mediaId: v }, at: 600, tracks: { audio: 'A1' } }]);
		const [a, b, c] = h.clips('A1');
		h.ok([{ type: 'clip.trim', clipId: a!.id, edge: 'out', deltaFrames: -30 }]);
		h.ok([{ type: 'clip.trim', clipId: b!.id, edge: 'out', deltaFrames: -30 }]);
		h.ok([{ type: 'clip.trim', clipId: c!.id, edge: 'out', deltaFrames: -60 }]);
		h.ok([{ type: 'essentialSound.setType', clipIds: [a!.id, b!.id, c!.id], audioType: 'dialogue' }]);
		const regions = dialogueRegions(h.doc, h.seq);
		expect(regions.map((r) => [r.start, r.end])).toEqual([
			[0, 210],
			[600, 660],
		]);
		expect(insideDialogueRegion(regions, 90, 120)).toBeTruthy();
		expect(insideDialogueRegion(regions, 300, 400)).toBeNull();
		const gaps = dialogueGaps(h.doc, h.seq);
		expect(gaps.map((g) => [g.start, g.end, g.beforeClipId, g.afterClipId])).toEqual([
			[90, 120, a!.id, b!.id],
		]);
		const span = roomToneSpan(gaps[0]!, R30);
		expect(span).toEqual({ start: 82, end: 128 });
		expect(mergeSpans([span, { start: 120, end: 140 }, { start: 300, end: 310 }])).toEqual([
			{ start: 82, end: 140 },
			{ start: 300, end: 310 },
		]);
		const r = h.ok([
			{
				type: 'soundDesign.layBed',
				purpose: 'roomtone',
				shots: [span],
				mediaId: tone,
				loop: { inSec: 2, outSec: 4.5 },
				gainDb: roomToneGainDb(-48, -55),
			},
		]);
		const res = r.results[0] as { trackId: string; clipIds: string[] };
		expect(h.seq.audioTracks.find((t) => t.id === res.trackId)!.name).toBe('Room Tone');
		const fill = res.clipIds.map((id) => h.seq.clips[id] as AudioClip & { bed?: unknown });
		expect(fill[0]!.start).toBe(82);
		expect(fill[fill.length - 1]!.start + fill[fill.length - 1]!.duration).toBe(128);
		expect(readClipBed(fill[0]!.bed)?.purpose).toBe('roomtone');
		expect(fill[0]!.gainDb).toBe(-7);
		// fades of 0.25 s (8 frames) at both ends, under the dialogue
		const fades = Object.values(h.seq.transitions).filter((t) => !t.outgoingClipId || !t.incomingClipId);
		expect(fades.map((t) => t.duration)).toEqual([8, 8]);
		expect(checkInvariants(h.doc)).toEqual([]);
		// the level: matched to the floor plus the clip's gain, never under −56 dBFS
		expect(roomToneGainDb(-50, -62)).toBe(-6);
		expect(roomToneGainDb(-50, -40, 3)).toBe(13);
		expect(roomToneGainDb(Number.NaN, -40)).toBe(0);
		expect(roomToneGainDb(-120, -40)).toBe(40);
	});
});

describe('bed metadata: invariant and repair', () => {
	it('a malformed bed or one on another kind of clip is reported and dropped by repair', () => {
		const h = new Harness();
		const { amb } = threeScenes(h);
		h.ok([{ type: 'soundDesign.layBed', range: { start: 0, end: 200 }, mediaId: amb }]);
		const doc = JSON.parse(JSON.stringify(h.doc));
		const seq = Object.values(doc.sequences)[0] as { clips: Record<string, { kind: string; bed?: unknown }> };
		const audio = Object.values(seq.clips).filter((c) => c.kind === 'audio');
		const video = Object.values(seq.clips).find((c) => c.kind === 'video')!;
		audio[0]!.bed = { purpose: 'nope', shot: 0, piece: 0, loop: { inFlicks: 5, outFlicks: 1 } };
		video.bed = { purpose: 'ambience', shot: 0, piece: 0, loop: { inFlicks: 0, outFlicks: 10 } };
		const issues = checkInvariants(doc);
		expect(issues.filter((i) => (i as { invariant?: string }).invariant === 'INV-SFX').length).toBe(2);
		const repaired = repairDocument(doc, createCounterIdSource(77));
		expect(checkInvariants(repaired.document)).toEqual([]);
		const rs = Object.values(repaired.document.sequences)[0]!;
		expect(Object.values(rs.clips).filter((c) => (c as { bed?: unknown }).bed !== undefined).length).toBe(
			audio.length - 1,
		);
		// idempotent
		expect(repairDocument(repaired.document, createCounterIdSource(78)).document).toEqual(repaired.document);
	});
});
