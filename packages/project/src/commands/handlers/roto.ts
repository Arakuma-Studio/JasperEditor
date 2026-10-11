// Roto / object matte commands (parity workstream `roto`): roto.add / update / addStrokes / removeStrokes / setBox /
// setResult / freeze / remove / apply. Roto objects live on video and still clips in media frames and media pixels;
// the mattes are computed by the engine (`roto` job) and referenced by `result`; effects bind to a roto by id
// (`object` param). Every change of what the mattes depend on makes the result stale (`rotoIsStale`) until the next
// propagation; a frozen roto refuses such changes.
import type { Draft } from 'immer';
import { intrinsicBoxOf } from '../../registry/properties.ts';
import {
	clipMediaFrames,
	faceSquare,
	mediaFrameAt,
	mediaFrameFlicks,
	OBJECT_BLUR_EFFECT_ID,
	OBJECT_MATTE_EFFECT_ID,
	rotoFrameCount,
	rotoRateOf,
} from '../../roto/index.ts';
import type { ParamValue } from '../../schema/common.ts';
import type {
	ClipRoto,
	ClipTracker,
	EffectInstance,
	RotoResult,
	RotoStroke,
	VideoClip,
} from '../../schema/sequence.ts';
import type { Rational } from '../../time.ts';
import { stepOfRate } from '../../tracking/samples.ts';
import type { DClip, DDoc, DSeq, HandlerContext } from '../context.ts';
import { assertUnlocked, findTrackIn } from '../placement.ts';
import type { CommandOf } from '../schemas/index.ts';
import { effectHandlers } from './effect.ts';
import { ruleFromParam, validateValue } from './param.ts';
import { trackerHandlers } from './tracker.ts';
import type { HandlerMap } from './util.ts';

type DRoto = Draft<ClipRoto>;
type StrokeInput = {
	kind: RotoStroke['kind'];
	radius: number;
	points: readonly (readonly [number, number])[];
};
type PointInput = { x: number; y: number; fg?: boolean; radius?: number };

/** Owner of the roto commands in the catalogue. */
export const ROTO_OWNER = 'parity-roto' as const;

/** Effects that bind to a roto object through their `object` param. */
export const ROTO_BOUND_EFFECTS: readonly string[] = [OBJECT_MATTE_EFFECT_ID, OBJECT_BLUR_EFFECT_ID];

function locate(doc: DDoc, rotoId: string, h: HandlerContext): { seq: DSeq; clip: DClip; roto: DRoto } {
	for (const seq of Object.values(doc.sequences))
		for (const clip of Object.values(seq.clips)) {
			const roto = (clip as { rotos?: DRoto[] }).rotos?.find((r) => r.id === rotoId);
			if (roto) return { seq, clip, roto };
		}
	return h.fail('E_NOT_FOUND', `Roto object not found: ${rotoId}`);
}

function assertClipUnlocked(seq: DSeq, clip: DClip, h: HandlerContext): void {
	const t = findTrackIn(seq, clip.trackId);
	if (t) assertUnlocked(t.track, h);
}

function assertEditable(roto: DRoto, h: HandlerContext): void {
	if (roto.frozen) h.fail('E_INVALID_PARAM', `Roto "${roto.name}" is frozen; unfreeze it to change it`);
}

/** Media frame of `at` on the roto's clip (stills: 0), clamped to the media. */
function frameAt(
	doc: DDoc,
	seq: DSeq,
	clip: DClip,
	roto: Pick<ClipRoto, 'rate' | 'mediaId'>,
	at: CommandOf<'roto.addStrokes'>['at'],
	h: HandlerContext,
): number {
	if (clip.kind === 'still') return 0;
	const f = mediaFrameAt(h.clipContentTime(seq, clip, at), roto.rate as Rational);
	const asset = doc.media[roto.mediaId];
	const n = rotoFrameCount(asset, roto.rate as Rational);
	return n !== null ? Math.min(f, n - 1) : f;
}

function finitePoint(p: readonly number[], h: HandlerContext): [number, number] {
	if (!Number.isFinite(p[0]) || !Number.isFinite(p[1]))
		h.fail('E_INVALID_PARAM', 'Points must be finite numbers');
	return [p[0]!, p[1]!];
}

function toStrokes(
	frame: number,
	strokes: readonly StrokeInput[] | undefined,
	points: readonly PointInput[] | undefined,
	box: { width: number; height: number },
	h: HandlerContext,
): RotoStroke[] {
	const out: RotoStroke[] = [];
	for (const s of strokes ?? [])
		out.push({ kind: s.kind, frame, radius: s.radius, points: s.points.map((p) => finitePoint(p, h)) });
	const pr = Math.max(2, Math.round(Math.min(box.width, box.height) * 0.01));
	for (const p of points ?? [])
		out.push({
			kind: p.fg === false ? 'bg' : 'fg',
			frame,
			radius: p.radius ?? pr,
			points: [finitePoint([p.x, p.y], h)],
		});
	return out;
}

function checkRect(rect: readonly number[], h: HandlerContext): [number, number, number, number] {
	const [x0, y0, x1, y1] = rect as [number, number, number, number];
	if (![x0, y0, x1, y1].every(Number.isFinite) || !(x1 > x0) || !(y1 > y0))
		h.fail('E_INVALID_PARAM', 'A box is [x0, y0, x1, y1] with x1 > x0 and y1 > y0 (media px)');
	return [x0, y0, x1, y1];
}

/** First selecting stroke / box sets the base; strokes outside the span extend it. */
function noteFrame(roto: DRoto, frame: number, selecting: boolean): void {
	if (roto.base === null && selecting) roto.base = frame;
	if (frame < roto.span[0]) roto.span[0] = frame;
	if (frame > roto.span[1]) roto.span[1] = frame;
}

function checkSpan(span: readonly number[], n: number | null, h: HandlerContext): [number, number] {
	const [a, b] = span as [number, number];
	if (b < a) h.fail('E_INVALID_PARAM', 'span must be [first, last] media frames with last ≥ first');
	if (n !== null && b > n - 1) h.fail('E_OUT_OF_MEDIA', `span ends after the media's last frame (${n - 1})`);
	return [a, b];
}

/** Effect instances bound to roto ids, anywhere in the document. */
function boundEffects(doc: DDoc, ids: ReadonlySet<string>) {
	const out: { list: Draft<EffectInstance>[]; fx: Draft<EffectInstance> }[] = [];
	for (const seq of Object.values(doc.sequences))
		for (const clip of Object.values(seq.clips)) {
			const list = (clip as { effects?: Draft<EffectInstance>[] }).effects;
			for (const fx of list ?? []) {
				const v = fx.params.object?.value;
				if (ROTO_BOUND_EFFECTS.includes(fx.effectId) && typeof v === 'string' && ids.has(v))
					out.push({ list: list!, fx });
			}
		}
	return out;
}

export const rotoHandlers = {
	'roto.add': (doc, cmd: CommandOf<'roto.add'>, h) => {
		const { seq, clip } = h.clip(doc, cmd.clipId);
		if (clip.kind !== 'video' && clip.kind !== 'still')
			h.fail('E_INVALID_PARAM', `Roto objects go on video and still clips, not ${clip.kind} clips`, {
				path: [clip.id],
			});
		assertClipUnlocked(seq, clip, h);
		const mediaId = (clip as { mediaId: string }).mediaId;
		const asset = doc.media[mediaId];
		const rate = rotoRateOf(asset, seq.settings.frameRate as Rational);
		const n = rotoFrameCount(asset, rate);
		const kind = cmd.kind ?? 'brush';
		if (kind === 'faces' && (cmd.strokes?.length || cmd.points?.length || cmd.box))
			h.fail('E_INVALID_PARAM', 'A faces roto takes no strokes, points or box');
		const c = clip as { rotos?: DRoto[] };
		c.rotos ??= [];
		const shown =
			clip.kind === 'still'
				? ([0, 0] as [number, number])
				: clipMediaFrames(clip, seq.settings.frameRate as Rational, rate, n);
		const span = cmd.span ? checkSpan(cmd.span, n, h) : shown;
		const id = h.ids.next('rto');
		const count = c.rotos.filter((r) => r.kind === kind).length;
		const roto: ClipRoto = {
			id,
			name: cmd.name ?? (kind === 'faces' ? `Faces ${count + 1}` : `Roto ${count + 1}`),
			kind,
			mediaId,
			rate: { num: rate.num, den: rate.den },
			base: kind === 'faces' ? span[0] : null,
			span,
			strokes: [],
			settings: { ...(cmd.settings ?? {}) },
			result: null,
		};
		const draft = roto as DRoto;
		const frame = frameAt(doc, seq, clip, roto, cmd.at, h);
		const box = intrinsicBoxOf({ doc, seq, clip });
		const strokes = toStrokes(frame, cmd.strokes, cmd.points, box, h);
		for (const s of strokes) {
			draft.strokes.push(s as Draft<RotoStroke>);
			noteFrame(draft, frame, s.kind === 'fg');
		}
		if (cmd.box) {
			draft.boxes = [{ frame, rect: checkRect(cmd.box, h) }];
			noteFrame(draft, frame, true);
		}
		c.rotos.push(draft);
		h.defineRef(cmd.ref, id);
		return { rotoId: id, clipId: clip.id, frame, span: [...draft.span], base: draft.base };
	},

	'roto.update': (doc, cmd: CommandOf<'roto.update'>, h) => {
		const { seq, clip, roto } = locate(doc, cmd.rotoId, h);
		assertClipUnlocked(seq, clip, h);
		if (cmd.name !== undefined) roto.name = cmd.name;
		const changes = cmd.span !== undefined || cmd.base !== undefined || cmd.settings !== undefined;
		if (changes) assertEditable(roto, h);
		if (cmd.span) {
			const n = rotoFrameCount(doc.media[roto.mediaId], roto.rate as Rational);
			roto.span = checkSpan(cmd.span, n, h);
			for (const s of roto.strokes) noteFrame(roto, s.frame, false);
			for (const b of roto.boxes ?? []) noteFrame(roto, b.frame, false);
		}
		if (cmd.base !== undefined) {
			if (cmd.base < roto.span[0] || cmd.base > roto.span[1])
				h.fail('E_INVALID_PARAM', `The base frame must lie in the span [${roto.span[0]}, ${roto.span[1]}]`);
			roto.base = cmd.base;
		}
		if (cmd.settings) roto.settings = { ...roto.settings, ...cmd.settings };
		return { rotoId: roto.id, span: [...roto.span], base: roto.base };
	},

	'roto.addStrokes': (doc, cmd: CommandOf<'roto.addStrokes'>, h) => {
		const { seq, clip, roto } = locate(doc, cmd.rotoId, h);
		assertClipUnlocked(seq, clip, h);
		assertEditable(roto, h);
		if (roto.kind === 'faces') h.fail('E_INVALID_PARAM', 'A faces roto takes no strokes');
		if (!cmd.strokes?.length && !cmd.points?.length) h.fail('E_INVALID_PARAM', 'Give strokes or points');
		const frame = frameAt(doc, seq, clip, roto, cmd.at, h);
		const strokes = toStrokes(frame, cmd.strokes, cmd.points, intrinsicBoxOf({ doc, seq, clip }), h);
		for (const s of strokes) {
			roto.strokes.push(s as Draft<RotoStroke>);
			noteFrame(roto, frame, s.kind === 'fg');
		}
		return { rotoId: roto.id, frame, added: strokes.length, span: [...roto.span], base: roto.base };
	},

	'roto.removeStrokes': (doc, cmd: CommandOf<'roto.removeStrokes'>, h) => {
		const { seq, clip, roto } = locate(doc, cmd.rotoId, h);
		assertClipUnlocked(seq, clip, h);
		assertEditable(roto, h);
		const frame = cmd.at !== undefined ? frameAt(doc, seq, clip, roto, cmd.at, h) : null;
		const kinds = new Set(cmd.kinds ?? ['fg', 'bg', 'refine', 'refineErase']);
		const match = (s: { frame: number; kind: string }) =>
			(frame === null || s.frame === frame) && kinds.has(s.kind as RotoStroke['kind']);
		let removeIdx: Set<number>;
		if (cmd.last !== undefined) {
			const idx = roto.strokes.map((s, i) => (match(s) ? i : -1)).filter((i) => i >= 0);
			removeIdx = new Set(idx.slice(-cmd.last));
		} else removeIdx = new Set(roto.strokes.map((s, i) => (match(s) ? i : -1)).filter((i) => i >= 0));
		const before = roto.strokes.length;
		roto.strokes = roto.strokes.filter((_, i) => !removeIdx.has(i));
		let boxes = 0;
		if (cmd.last === undefined && kinds.has('fg') && roto.boxes) {
			const keep = roto.boxes.filter((b) => !(frame === null || b.frame === frame));
			boxes = roto.boxes.length - keep.length;
			if (keep.length) roto.boxes = keep;
			else delete roto.boxes;
		}
		// The base moves to the earliest frame that still selects something (none: no base).
		const selecting = [
			...roto.strokes.filter((s) => s.kind === 'fg').map((s) => s.frame),
			...(roto.boxes ?? []).map((b) => b.frame),
		];
		if (roto.kind === 'brush' && (roto.base === null || !selecting.includes(roto.base)))
			roto.base = selecting.length ? Math.min(...selecting) : null;
		return { rotoId: roto.id, removed: before - roto.strokes.length, boxes, base: roto.base };
	},

	'roto.setBox': (doc, cmd: CommandOf<'roto.setBox'>, h) => {
		const { seq, clip, roto } = locate(doc, cmd.rotoId, h);
		assertClipUnlocked(seq, clip, h);
		assertEditable(roto, h);
		if (roto.kind === 'faces') h.fail('E_INVALID_PARAM', 'A faces roto takes no box');
		const frame = frameAt(doc, seq, clip, roto, cmd.at, h);
		const rest = (roto.boxes ?? []).filter((b) => b.frame !== frame);
		if (cmd.rect) {
			rest.push({ frame, rect: checkRect(cmd.rect, h) });
			noteFrame(roto, frame, true);
		}
		if (rest.length) roto.boxes = rest.sort((a, b) => a.frame - b.frame);
		else delete roto.boxes;
		if (!cmd.rect && roto.base === frame && !roto.strokes.some((s) => s.frame === frame && s.kind === 'fg')) {
			const selecting = [
				...roto.strokes.filter((s) => s.kind === 'fg').map((s) => s.frame),
				...rest.map((b) => b.frame),
			];
			roto.base = selecting.length ? Math.min(...selecting) : null;
		}
		return { rotoId: roto.id, frame, base: roto.base };
	},

	'roto.setResult': (doc, cmd: CommandOf<'roto.setResult'>, h) => {
		const { seq, clip, roto } = locate(doc, cmd.rotoId, h);
		assertClipUnlocked(seq, clip, h);
		if (roto.frozen) h.fail('E_INVALID_PARAM', `Roto "${roto.name}" is frozen; unfreeze it to recompute it`);
		const r = cmd.result as RotoResult | null;
		if (r && r.end < r.start) h.fail('E_INVALID_PARAM', 'result.end must be ≥ result.start');
		roto.result = r ? ({ ...r } as Draft<RotoResult>) : null;
		return { rotoId: roto.id, result: r ? { key: r.key, start: r.start, end: r.end } : null };
	},

	'roto.freeze': (doc, cmd: CommandOf<'roto.freeze'>, h) => {
		const { seq, clip, roto } = locate(doc, cmd.rotoId, h);
		assertClipUnlocked(seq, clip, h);
		if (cmd.frozen && !roto.result) h.fail('E_INVALID_PARAM', 'Nothing to freeze: propagate the roto first');
		if (cmd.frozen) roto.frozen = true;
		else delete roto.frozen;
		return { rotoId: roto.id, frozen: cmd.frozen };
	},

	'roto.remove': (doc, cmd: CommandOf<'roto.remove'>, h) => {
		const ids = new Set(cmd.rotoIds);
		for (const id of ids) {
			const { seq, clip } = locate(doc, id, h);
			assertClipUnlocked(seq, clip, h);
			const c = clip as { rotos?: DRoto[] };
			c.rotos = (c.rotos ?? []).filter((r) => r.id !== id);
			if (c.rotos.length === 0) delete c.rotos;
		}
		const effects: string[] = [];
		for (const { list, fx } of boundEffects(doc, ids)) {
			list.splice(list.indexOf(fx), 1);
			effects.push(fx.id);
		}
		return { rotoIds: [...ids], removedEffects: effects };
	},

	'roto.apply': (doc, cmd: CommandOf<'roto.apply'>, h) => {
		const { seq, clip, roto } = locate(doc, cmd.rotoId, h);
		assertClipUnlocked(seq, clip, h);
		const effectId =
			(cmd.effect ?? (roto.kind === 'faces' ? 'blur' : 'matte')) === 'blur'
				? OBJECT_BLUR_EFFECT_ID
				: OBJECT_MATTE_EFFECT_ID;
		const spec = h.registries.effects.get(effectId);
		if (!spec) return h.fail('E_UNKNOWN_EFFECT', `Unknown effect: ${effectId}`);
		const list = ((clip as { effects?: Draft<EffectInstance>[] }).effects ??= []);
		let fx = list.find((e) => e.effectId === effectId && e.params.object?.value === roto.id);
		let created = false;
		if (!fx) {
			const r = effectHandlers['effect.add']!(
				doc,
				{
					type: 'effect.add',
					effectId,
					target: { clipId: clip.id },
					params: { object: roto.id },
					...(cmd.ref ? { ref: cmd.ref } : {}),
				},
				h,
			) as { effectInstanceId: string };
			fx = list.find((e) => e.id === r.effectInstanceId)!;
			created = true;
		} else h.defineRef(cmd.ref, fx.id);
		for (const [name, raw] of Object.entries(cmd.params ?? {})) {
			if (name === 'object') h.fail('E_INVALID_PARAM', 'The object is the roto being applied');
			const p = spec.params.find((x) => x.name === name);
			if (!p) h.fail('E_INVALID_PARAM', `${spec.id} has no parameter "${name}"`);
			const v = validateValue(raw, ruleFromParam(p!), h, `${spec.id}.${name}`);
			fx.params[name] = { value: v.value as ParamValue, keyframes: [] } as never;
		}
		return { effectInstanceId: fx.id, effectId, created, rotoId: roto.id, clipId: clip.id };
	},

	'roto.faceTracker': (doc, cmd: CommandOf<'roto.faceTracker'>, h) => {
		const { seq, clip, roto } = locate(doc, cmd.rotoId, h);
		assertClipUnlocked(seq, clip, h);
		if (roto.kind !== 'faces') h.fail('E_INVALID_PARAM', `Roto "${roto.name}" is not a face track`);
		if (clip.kind !== 'video') h.fail('E_INVALID_PARAM', 'Face trackers go on video clips');
		const face = roto.result?.faces?.find((f) => f.id === cmd.faceId);
		if (!face)
			h.fail(
				'E_NOT_FOUND',
				`Face ${cmd.faceId} is not in the computed face track of "${roto.name}" (track faces first)`,
			);
		const n = face!.present.length;
		if (n === 0 || face!.poses.length !== n * 4)
			h.fail('E_INVALID_PARAM', 'The face track is empty or malformed');
		const rate = roto.rate as Rational;
		const data: number[] = [];
		for (let i = 0; i < n; i++) {
			const [cx, cy, size, angle] = face!.poses.slice(i * 4, i * 4 + 4) as [number, number, number, number];
			for (const [x, y] of faceSquare(cx, cy, size, angle))
				data.push(Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000);
		}
		const confidence = face!.present.map((p) => (p ? 1 : 0));
		const ref = Math.max(0, face!.present.indexOf(1));
		const v = clip as Draft<VideoClip>;
		v.trackers ??= [];
		const id = h.ids.next('tkr');
		const start = mediaFrameFlicks(face!.startFrame, rate);
		const step = stepOfRate(rate);
		const tracker: ClipTracker = {
			id,
			name: cmd.name ?? `${roto.name} · Face ${cmd.faceId + 1}`,
			kind: 'planar',
			reference: {
				time: start + ref * step,
				corners: [0, 1, 2, 3].map(
					(k) => [data[ref * 8 + k * 2]!, data[ref * 8 + k * 2 + 1]!] as [number, number],
				),
			},
			samples: { start, step, stride: 8, data, confidence },
			method: 'face-landmarks@1',
		};
		v.trackers.push(tracker as Draft<ClipTracker>);
		h.defineRef(cmd.ref, id);
		let applied: unknown = null;
		if (cmd.targetClipId)
			applied = trackerHandlers['tracker.apply']!(
				doc,
				{
					type: 'tracker.apply',
					trackerId: id,
					targetClipId: cmd.targetClipId,
					mode: 'transform',
					...(cmd.components ? { components: cmd.components } : {}),
				},
				h,
			);
		return { trackerId: id, clipId: clip.id, frames: n, ...(applied ? { applied } : {}) };
	},
} satisfies HandlerMap;
