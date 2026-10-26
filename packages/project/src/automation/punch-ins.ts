// Punch-ins planner (spec 15 EA-021, EA-030, EA-032): candidates are the A-roll clips of at least `minClipSeconds`
// (1.5 s) whose Motion is not keyframed (no Ken Burns, no earlier zoom) and that no effect already moves; `density`
// (0.7) of them get a punch-in, clips whose phrases end in "!" or "?" first (measured: 55–57 % of such phrases sit
// under a zoom vs 29 % overall), then in a seeded order. The zoom starts at the clip's midpoint (52 % of the user's sit
// there ±1 frame) or the transcript word start nearest it, ramps linearly to `scale` (180 %) in `rampFrames` (7) and
// holds to the clip's end. It zooms about the frame centre, a point, or the subject (a faces roto on the clip, else
// the engine's face / saliency analysis given in `subjects`); zooming in about any point of the frame keeps a clip
// that covered the frame covering it. Default output: Motion scale (and position) keys on the clip — exported
// natively; option: a Transform adjustment clip on a "ZOOM" track right above the A-roll. Pure.
import { sequenceWords } from '../captions/sequence-transcript.ts';
import type { BatchEffect } from '../commands/schemas/batch.ts';
import { evaluate } from '../keyframes.ts';
import { intrinsicBoxOf } from '../registry/properties.ts';
import { layerMatrix } from '../render/transform.ts';
import type { Vec2 } from '../schema/common.ts';
import type { ProjectDocument } from '../schema/document.ts';
import type { Clip, Sequence } from '../schema/sequence.ts';
import { FLICKS_PER_SECOND, flicksPerFrame } from '../time.ts';
import { trackLabel } from '../derive/index.ts';
import {
	AutomationInputError,
	automationSequence,
	type ClipSkip,
	type FrameGeometry,
	fpsValue,
	frameGeometry,
	motionCandidates,
	passTrack,
	spanFree,
	timecodeOf,
	trackSpans,
} from './common.ts';
import { AUTOMATION_DEFAULTS, type PunchInParams, PunchInParamsSchema, type PunchTarget } from './params.ts';
import { itemSeed, seededRandom } from './rng.ts';

export const PUNCH_PASS = 'punch-ins' as const;

/** A subject point of a clip: 0…1 of its picture (media display), and where it came from. */
export type ClipSubject = { x: number; y: number; source: 'faces' | 'saliency' | 'roto' };

export type MotionPlan = {
	/** Scale in % from → to (keys at the clip-relative frames). */
	scale: { from: number; to: number };
	scaleWidth?: { from: number; to: number };
	position?: { from: Vec2; to: Vec2 };
	/** Clip-relative frames of the first and last key. */
	keys: [number, number];
};

export type PunchPlacement = {
	/** Proposal item id: `punch:<clip id>`. */
	id: string;
	clipId: string;
	clipName: string;
	/** Sequence frame the zoom starts on. */
	frame: number;
	timecode: string;
	/** The clip's end (the zoom holds until here). */
	end: number;
	rampFrames: number;
	scale: number;
	seed: number;
	/** Where it zooms, in sequence pixels, and how that point was found. */
	target: {
		x: number;
		y: number;
		source: 'center' | 'point' | 'faces' | 'saliency' | 'roto' | 'center-fallback';
	};
	/** The clip's phrases end in "!" or "?" (ranked first). */
	emphasis: boolean;
	start: 'midpoint' | 'word';
	motion: MotionPlan;
	/** The adjustment-layer form (method `adjustment`). */
	adjustment: { start: number; length: number; name: string; effects: BatchEffect[] };
	/** The same zoom at the other measured size (140 % ↔ 180 %), for the Review's ⇄. */
	alternative: { scale: number; motion: MotionPlan; adjustment: PunchPlacement['adjustment'] };
};

export type ResolvedPunchParams = {
	minFrames: number;
	density: number;
	scale: number;
	rampFrames: number;
	start: 'midpoint' | 'word';
	target: PunchTarget;
	method: 'motion' | 'adjustment';
	exclude: Set<string>;
	skipReframed: boolean;
	seed: number;
	track?: string;
	range?: { start: number; end: number };
};

export type PunchPlan = {
	pass: typeof PUNCH_PASS;
	sequenceId: string;
	trackId: string;
	method: 'motion' | 'adjustment';
	seed: number;
	punches: PunchPlacement[];
	/** Candidates (clips that could get one) and the ones the density left out. */
	candidates: number;
	skipped: (ClipSkip & { timecode: string })[];
	/** Method `adjustment`: the track of the Transform clips (existing, or a new "ZOOM" right above the A-roll). */
	zoomTrack:
		| { trackId: string; label: string; create: false }
		| { create: true; name: string; index: number }
		| null;
	warnings: { code: string; message: string }[];
};

export function resolvePunchParams(raw: unknown, geo: Pick<FrameGeometry, 'fps'>): ResolvedPunchParams {
	const parsed = PunchInParamsSchema.safeParse(raw ?? {});
	if (!parsed.success)
		throw new AutomationInputError(
			'E_INVALID_PARAM',
			parsed.error.issues.map((i) => `${i.path.join('.') || 'params'}: ${i.message}`).join('; '),
		);
	const p: PunchInParams = parsed.data;
	const fps = fpsValue(geo.fps);
	return {
		minFrames: Math.max(
			1,
			Math.ceil((p.minClipSeconds ?? AUTOMATION_DEFAULTS.punchMinClipSeconds) * fps - 1e-6),
		),
		density: p.density ?? AUTOMATION_DEFAULTS.punchDensity,
		scale: p.scale ?? AUTOMATION_DEFAULTS.punchScale,
		rampFrames: p.rampFrames ?? AUTOMATION_DEFAULTS.punchRampFrames,
		start: p.start ?? 'midpoint',
		target: p.target ?? 'center',
		method: p.method ?? 'motion',
		exclude: new Set(p.excludeClipIds ?? []),
		skipReframed: p.skipReframed ?? true,
		seed: p.seed ?? AUTOMATION_DEFAULTS.seed,
		...(p.track !== undefined ? { track: p.track } : {}),
		...(p.range ? { range: p.range } : {}),
	};
}

const EMPHASIS = /[!?¡¿]/;

/** Clip ids whose transcript words (sequence transcript) contain "!" / "?" (or ¡ ¿). */
function emphasisClips(doc: ProjectDocument, seq: Sequence, clips: readonly Clip[]): Set<string> {
	const out = new Set<string>();
	let words: ReturnType<typeof sequenceWords>;
	try {
		words = sequenceWords(doc, seq);
	} catch {
		return out;
	}
	if (!words.length) return out;
	const F = flicksPerFrame(frameGeometry(seq).fps);
	for (const c of clips) {
		const a = c.start * F;
		const b = (c.start + c.duration) * F;
		for (const w of words) {
			if (w.start >= b) break;
			if (w.end > a && w.start < b && EMPHASIS.test(w.text)) {
				out.add(c.id);
				break;
			}
		}
	}
	return out;
}

/** Word starts (sequence frames) of the sequence transcript, sorted. */
function wordStarts(doc: ProjectDocument, seq: Sequence): number[] {
	try {
		const F = flicksPerFrame(frameGeometry(seq).fps);
		return sequenceWords(doc, seq).map((w) => Math.round(w.start / F));
	} catch {
		return [];
	}
}

/** The start frame of a punch-in on `c`: the midpoint, or the word start nearest it (inside the clip, ramp fits). */
function startOf(c: Clip, mode: 'midpoint' | 'word', ramp: number, words: readonly number[]) {
	const mid = c.start + Math.floor(c.duration / 2);
	const latest = c.start + c.duration - ramp;
	if (mode === 'word') {
		let best: number | null = null;
		for (const w of words) {
			if (w <= c.start || w > latest) continue;
			if (best === null || Math.abs(w - mid) < Math.abs(best - mid)) best = w;
		}
		if (best !== null) return { frame: best, kind: 'word' as const };
	}
	return { frame: Math.min(Math.max(mid, c.start + 1), latest), kind: 'midpoint' as const };
}

type TransformValues = {
	position: Vec2;
	anchor: Vec2;
	scale: number;
	scaleWidth: number;
	uniformScale: boolean;
	rotation: number;
	flipH: boolean;
	flipV: boolean;
};

/** The clip's (static) Motion values; null for a clip without Motion. */
function motionOf(c: Clip): TransformValues | null {
	const tr = (c as { transform?: Record<string, unknown> }).transform as
		| {
				position: { value: Vec2 };
				anchor: { value: Vec2 };
				scale: { value: number };
				scaleWidth: { value: number };
				uniformScale: boolean;
				rotation: { value: number };
				flipH: boolean;
				flipV: boolean;
		  }
		| undefined;
	if (!tr) return null;
	try {
		return {
			position: evaluate(tr.position as never, 0) as Vec2,
			anchor: evaluate(tr.anchor as never, 0) as Vec2,
			scale: evaluate(tr.scale as never, 0) as number,
			scaleWidth: evaluate(tr.scaleWidth as never, 0) as number,
			uniformScale: tr.uniformScale !== false,
			rotation: evaluate(tr.rotation as never, 0) as number,
			flipH: !!tr.flipH,
			flipV: !!tr.flipV,
		};
	} catch {
		return null;
	}
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;

/**
 * Motion keys that zoom the clip by `k` about the sequence point `p` between clip-relative frames `a` and `b`:
 * scale × k and position' = p + k (position − p), linear in both, so every frame in between is the same zoom about p.
 */
export function zoomMotion(
	m: TransformValues,
	k: number,
	p: Vec2,
	a: number,
	b: number,
	reverse = false,
): MotionPlan {
	const to: Vec2 = [r3(p[0] + k * (m.position[0] - p[0])), r3(p[1] + k * (m.position[1] - p[1]))];
	const moves = Math.abs(to[0] - m.position[0]) > 1e-6 || Math.abs(to[1] - m.position[1]) > 1e-6;
	const s = { from: r3(m.scale), to: r3(m.scale * k) };
	const sw = m.uniformScale ? undefined : { from: r3(m.scaleWidth), to: r3(m.scaleWidth * k) };
	const flip = <T>(x: { from: T; to: T }) => (reverse ? { from: x.to, to: x.from } : x);
	return {
		scale: flip(s),
		...(sw ? { scaleWidth: flip(sw) } : {}),
		...(moves ? { position: flip({ from: [r3(m.position[0]), r3(m.position[1])] as Vec2, to }) } : {}),
		keys: [a, b],
	};
}

/** The subject of a clip from a faces roto on it (largest face present at the clip's content time `t`), 0…1. */
export function rotoSubject(doc: ProjectDocument, seq: Sequence, c: Clip, frame: number): ClipSubject | null {
	const rotos = (c as { rotos?: unknown[] }).rotos;
	if (!Array.isArray(rotos)) return null;
	let box: { width: number; height: number };
	try {
		box = intrinsicBoxOf({ clip: c, doc, seq } as never);
	} catch {
		return null;
	}
	if (!(box.width > 0 && box.height > 0)) return null;
	const F = flicksPerFrame(frameGeometry(seq).fps);
	const t = c.sourceIn + (frame - c.start) * F * (c.speed?.rate ?? 1);
	let best: { x: number; y: number; size: number } | null = null;
	for (const r of rotos) {
		const ro = r as {
			kind?: string;
			rate?: { num: number; den: number };
			result?: { faces?: { startFrame: number; poses: number[]; present: number[] }[] } | null;
		};
		if (ro.kind !== 'faces' || !ro.result?.faces || !ro.rate || !(ro.rate.num > 0 && ro.rate.den > 0))
			continue;
		const mf = Math.floor((t * ro.rate.num) / (ro.rate.den * FLICKS_PER_SECOND) + 1e-6);
		for (const face of ro.result.faces) {
			const i = mf - face.startFrame;
			if (i < 0 || face.present?.[i] !== 1) continue;
			const [cx, cy, size] = [face.poses[i * 4], face.poses[i * 4 + 1], face.poses[i * 4 + 2]];
			if (![cx, cy, size].every((v) => typeof v === 'number' && Number.isFinite(v))) continue;
			if (!best || size! > best.size) best = { x: cx!, y: cy!, size: size! };
		}
	}
	if (!best) return null;
	return {
		x: Math.min(1, Math.max(0, best.x / box.width)),
		y: Math.min(1, Math.max(0, best.y / box.height)),
		source: 'roto',
	};
}

/** A point of the clip's picture (0…1) on the sequence frame through its Motion, clamped to the frame. */
function pictureToFrame(
	doc: ProjectDocument,
	seq: Sequence,
	c: Clip,
	m: TransformValues,
	s: ClipSubject,
): Vec2 {
	const geo = frameGeometry(seq);
	let box: { width: number; height: number };
	try {
		box = intrinsicBoxOf({ clip: c, doc, seq } as never);
	} catch {
		box = { width: geo.width, height: geo.height };
	}
	const M = layerMatrix(m as never);
	const px = s.x * box.width;
	const py = s.y * box.height;
	const x = M.a * px + M.c * py + M.e;
	const y = M.b * px + M.d * py + M.f;
	return [Math.min(geo.width, Math.max(0, r3(x))), Math.min(geo.height, Math.max(0, r3(y)))];
}

/** The Transform adjustment clip of a punch-in (`p` in sequence px). */
function adjustmentOf(
	geo: FrameGeometry,
	start: number,
	end: number,
	ramp: number,
	scale: number,
	p: Vec2,
): PunchPlacement['adjustment'] {
	const n: [number, number] = [r3(p[0] / geo.width), r3(p[1] / geo.height)];
	return {
		start,
		length: end - start,
		name: `Punch-in ${scale} %`,
		effects: [
			{
				effectId: 'jasper.transform',
				params: {
					anchorPoint: n,
					position: n,
					uniformScale: true,
					useCompShutterAngle: false,
					shutterAngle: 360,
				},
				keyframes: {
					scaleHeight: [
						{ frame: 0, value: 100, interpolation: 'linear' },
						{
							frame: Math.min(ramp, end - start),
							value: scale,
							interpolation: 'linear',
							inInterpolation: 'linear',
						},
					],
				},
			},
		],
	};
}

export type PunchContext = {
	/** Subjects measured by the engine (face model or saliency), per clip id: 0…1 of the clip's picture. */
	subjects?: Readonly<Record<string, ClipSubject>>;
};

function placeOne(
	doc: ProjectDocument,
	seq: Sequence,
	c: Clip,
	params: ResolvedPunchParams,
	seed: number,
	emphasis: boolean,
	words: readonly number[],
	ctx: PunchContext,
): PunchPlacement {
	const geo = frameGeometry(seq);
	const st = startOf(c, params.start, params.rampFrames, words);
	const end = c.start + c.duration;
	const ramp = Math.max(1, Math.min(params.rampFrames, end - st.frame));
	const m = motionOf(c) ?? {
		position: [geo.width / 2, geo.height / 2] as Vec2,
		anchor: [geo.width / 2, geo.height / 2] as Vec2,
		scale: 100,
		scaleWidth: 100,
		uniformScale: true,
		rotation: 0,
		flipH: false,
		flipV: false,
	};
	let target: PunchPlacement['target'];
	if (params.target === 'center') target = { x: geo.width / 2, y: geo.height / 2, source: 'center' };
	else if (params.target === 'subject') {
		const s = rotoSubject(doc, seq, c, st.frame) ?? ctx.subjects?.[c.id] ?? null;
		if (s) {
			const [x, y] = pictureToFrame(doc, seq, c, m, s);
			target = { x, y, source: s.source };
		} else target = { x: geo.width / 2, y: geo.height / 2, source: 'center-fallback' };
	} else
		target = { x: r3(params.target.x * geo.width), y: r3(params.target.y * geo.height), source: 'point' };
	const p: Vec2 = [target.x, target.y];
	const a = st.frame - c.start;
	const altScale = params.scale === 140 ? 180 : 140;
	return {
		id: `punch:${c.id}`,
		clipId: c.id,
		clipName: c.name,
		frame: st.frame,
		timecode: timecodeOf(seq, st.frame),
		end,
		rampFrames: ramp,
		scale: params.scale,
		seed,
		target,
		emphasis,
		start: st.kind,
		motion: zoomMotion(m, params.scale / 100, p, a, a + ramp),
		adjustment: adjustmentOf(geo, st.frame, end, ramp, params.scale, p),
		alternative: {
			scale: altScale,
			motion: zoomMotion(m, altScale / 100, p, a, a + ramp),
			adjustment: adjustmentOf(geo, st.frame, end, ramp, altScale, p),
		},
	};
}

/** Plans the punch-ins of a sequence (see the file comment). Throws `AutomationInputError` for an invalid request. */
export function planPunchIns(
	doc: ProjectDocument,
	sequenceId: string | null | undefined,
	rawParams: unknown,
	ctx: PunchContext = {},
): PunchPlan {
	const seq = automationSequence(doc, sequenceId);
	const geo = frameGeometry(seq);
	const params = resolvePunchParams(rawParams, geo);
	const track = passTrack(seq, params.track);
	const minFrames = Math.max(params.minFrames, params.rampFrames + 2);
	const cand = motionCandidates(seq, track, {
		minFrames,
		exclude: params.exclude,
		...(params.skipReframed ? { skipReframed: doc } : {}),
		...(params.range ? { range: params.range } : {}),
	});
	const emph = emphasisClips(doc, seq, cand.clips);
	const words = params.start === 'word' ? wordStarts(doc, seq) : [];
	const ranked = cand.clips
		.map((c) => {
			const seed = itemSeed(params.seed, PUNCH_PASS, c.id);
			return { c, seed, emphasis: emph.has(c.id), draw: seededRandom(seed)() };
		})
		.sort((a, b) => Number(b.emphasis) - Number(a.emphasis) || a.draw - b.draw || a.c.start - b.c.start);
	const count = Math.round(params.density * ranked.length);
	const chosen = ranked.slice(0, count).sort((a, b) => a.c.start - b.c.start);
	const punches = chosen.map((x) => placeOne(doc, seq, x.c, params, x.seed, x.emphasis, words, ctx));
	const skipped = [
		...cand.skipped,
		...ranked.slice(count).map((x) => ({
			clipId: x.c.id,
			frame: x.c.start,
			code: 'density',
			reason: 'left out by the density setting',
		})),
	]
		.sort((a, b) => a.frame - b.frame)
		.map((s) => ({ ...s, timecode: timecodeOf(seq, s.frame) }));
	const warnings: { code: string; message: string }[] = [];
	if (params.target === 'subject' && punches.some((p) => p.target.source === 'center-fallback'))
		warnings.push({
			code: 'W_NO_SUBJECT',
			message: `${punches.filter((p) => p.target.source === 'center-fallback').length} punch-in(s) zoom to the centre: no face tracking or saliency result for their clip`,
		});
	if (params.start === 'word' && words.length === 0)
		warnings.push({
			code: 'W_NO_WORDS',
			message: 'No transcript words: the zooms start at the clip midpoints',
		});
	const trackIndex = seq.videoTracks.findIndex((t) => t.id === track.id);
	return {
		pass: PUNCH_PASS,
		sequenceId: seq.id,
		trackId: track.id,
		method: params.method,
		seed: params.seed,
		punches,
		candidates: cand.clips.length,
		skipped,
		zoomTrack:
			params.method === 'adjustment' && punches.length
				? zoomTrackOf(seq, trackIndex, [
						...punches.map((p): [number, number] => [
							p.adjustment.start,
							p.adjustment.start + p.adjustment.length,
						]),
					])
				: null,
		warnings,
	};
}

/** The ZOOM track: a free, unlocked track named "ZOOM" directly above the A-roll, else a new one inserted there. */
function zoomTrackOf(seq: Sequence, aRollIndex: number, spans: [number, number][]): PunchPlan['zoomTrack'] {
	const above = seq.videoTracks[aRollIndex + 1];
	if (above && !above.locked && /^zoom( \d+)?$/i.test((above.name ?? '').trim())) {
		const taken = trackSpans(seq, above.id);
		if (spans.every(([a, b]) => spanFree(taken, a, b)))
			return { trackId: above.id, label: trackLabel(seq, above.id) ?? above.id, create: false };
	}
	const names = new Set(seq.videoTracks.map((t) => (t.name ?? '').trim().toLowerCase()));
	let name = 'ZOOM';
	for (let n = 2; names.has(name.toLowerCase()) && n < 1000; n++) name = `ZOOM ${n}`;
	return { create: true, name, index: aRollIndex + 1 };
}

/** Re-plans single punch-ins (Refresh / Reroll): the clip must still be a candidate. */
export function replanPunchIns(
	doc: ProjectDocument,
	sequenceId: string | null | undefined,
	rawParams: unknown,
	targets: readonly { itemId: string; clipId: string; seed: number }[],
	ctx: PunchContext = {},
): ({ itemId: string; ok: true; punch: PunchPlacement } | { itemId: string; ok: false; reason: string })[] {
	const seq = automationSequence(doc, sequenceId);
	const geo = frameGeometry(seq);
	const params = resolvePunchParams(rawParams, geo);
	const track = passTrack(seq, params.track);
	const cand = motionCandidates(seq, track, {
		minFrames: Math.max(params.minFrames, params.rampFrames + 2),
		exclude: params.exclude,
		...(params.skipReframed ? { skipReframed: doc } : {}),
	});
	const byId = new Map(cand.clips.map((c) => [c.id, c]));
	const why = new Map(cand.skipped.map((s) => [s.clipId, s.reason]));
	const words = params.start === 'word' ? wordStarts(doc, seq) : [];
	return targets.map((t) => {
		const c = byId.get(t.clipId);
		if (!c)
			return {
				itemId: t.itemId,
				ok: false as const,
				reason: why.has(t.clipId)
					? `its clip is no longer a candidate: ${why.get(t.clipId)}`
					: 'its clip is gone from the A-roll track',
			};
		const emph = emphasisClips(doc, seq, [c]).has(c.id);
		const punch = placeOne(doc, seq, c, params, t.seed, emph, words, ctx);
		return { itemId: t.itemId, ok: true as const, punch: { ...punch, id: t.itemId } };
	});
}
