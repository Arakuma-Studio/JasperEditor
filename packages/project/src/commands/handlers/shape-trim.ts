// One-click Trim Paths animations (`shape.animateTrim`), Path Direction toggling and straight-line shapes
// (docs/wp-notes/shapes.md § Trim Paths animations). The keys, expressions and part layout come from
// `vector/trim-animate.ts`; this file places them in the document.
import type { Draft } from 'immer';
import { contentTimeAt } from '../../derive/index.ts';
import { type CubicEase, cubicToEases } from '../../ease/curve.ts';
import { DEFAULT_SHAPE_SECONDS } from '../../factories.ts';
import { EASE_PRESETS } from '../../keyframes.ts';
import type { Animatable, Keyframe } from '../../schema/common.ts';
import type { ShapeClip } from '../../schema/sequence.ts';
import { PATH_ITEM_TYPES, type ShapeItem, type ShapeItemOf } from '../../schema/shapes.ts';
import { type Rational, secondsToFrames } from '../../time.ts';
import { newShapeItem, nextItemName, reidItems, walkItems } from '../../vector/defaults.ts';
import {
	findTrimParts,
	mirrorCubicEase,
	planTrimAnimation,
	TRIM_ANIMATION_LIMITS,
	type TrimAnimationPlan,
	type TrimChannel,
	trimLinkedOffsetExpression,
	trimPartExpression,
	trimPartOffsetExpression,
} from '../../vector/trim-animate.ts';
import type { DClip, DDoc, DSeq, HandlerContext } from '../context.ts';
import { assertUnlocked, findTrackIn } from '../placement.ts';
import type { CommandOf } from '../schemas/index.ts';
import { frameBox } from './clip-common.ts';
import { convertShapeClipToVector, reidKeyframes, shapeHandlers } from './shape.ts';
import { rigTrack } from './three-d.ts';
import type { HandlerMap } from './util.ts';

type Group = ShapeItemOf<'group'>;
type Trim = ShapeItemOf<'trim'>;
type Contents = ShapeItem[];

const PATH_TYPES: ReadonlySet<string> = new Set(PATH_ITEM_TYPES);

function hasPaths(contents: readonly ShapeItem[]): boolean {
	let found = false;
	walkItems(contents, (it) => {
		if (PATH_TYPES.has(it.type)) found = true;
	});
	return found;
}

function countItems(contents: readonly ShapeItem[]): number {
	let n = 0;
	walkItems(contents, () => {
		n++;
	});
	return n;
}

/** The clips of a command that can hold a trim, the rest named with the reason they are skipped. */
function eligibleClips(
	doc: DDoc,
	clipIds: readonly string[],
	h: HandlerContext,
	what: string,
	/** Rectangle / ellipse clips are converted to vector shapes (else skipped). */
	convert: boolean,
): { seq: DSeq; clip: Draft<ShapeClip>; legacy: boolean }[] {
	const out: { seq: DSeq; clip: Draft<ShapeClip>; legacy: boolean }[] = [];
	const skipped: string[] = [];
	for (const id of new Set(clipIds)) {
		const { seq, clip } = h.clip(doc, id);
		const label = `"${clip.name}" (${id})`;
		if (clip.kind !== 'shape') {
			skipped.push(`${label}: not a shape clip`);
			continue;
		}
		const c = clip as Draft<ShapeClip>;
		if (c.shape.type !== 'vector') {
			if (convert) out.push({ seq, clip: c, legacy: true });
			else skipped.push(`${label}: a rectangle / ellipse clip (convert it to a vector shape first)`);
			continue;
		}
		if (!hasPaths(c.shape.contents as Contents)) {
			skipped.push(`${label}: no path items`);
			continue;
		}
		out.push({ seq, clip: c, legacy: false });
	}
	if (!out.length) return h.fail('E_INVALID_PARAM', `No clip can take ${what}: ${skipped.join('; ')}`);
	for (const e of out) assertUnlocked(findTrackIn(e.seq, e.clip.trackId)!.track, h);
	if (skipped.length)
		h.warn(
			'W_TRIM_SKIPPED',
			`Skipped ${skipped.length} clip${skipped.length > 1 ? 's' : ''} for ${what}: ${skipped.join('; ')}`,
			['clipIds'],
		);
	return out;
}

/** Sequence frame → content time (flicks) of a clip, unclamped and unsnapped (fractional frames allowed). */
function contentFlicks(seq: DSeq, clip: DClip, frame: number): number {
	return Math.round(contentTimeAt(clip, frame, seq.settings.frameRate as Rational));
}

/** Writes a planned channel into an Animatable (value, keys, expression). */
function writeChannel(
	h: HandlerContext,
	seq: DSeq,
	clip: DClip,
	t0: number,
	ch: TrimChannel,
	expression: string | null,
): Animatable<number> {
	const out: Animatable<number> = { value: ch.value, keyframes: [] };
	if (expression !== null) out.expression = { text: expression, enabled: true };
	const s = ch.segment;
	if (!s) return out;
	let ta = contentFlicks(seq, clip, t0 + s.startFrame);
	let tb = contentFlicks(seq, clip, t0 + s.endFrame);
	let [va, vb] = [s.from, s.to];
	let curve: CubicEase = s.curve;
	// Reversed clips run content time backwards: the keys swap and the curve is mirrored (same motion on screen).
	if (tb < ta) {
		[ta, tb] = [tb, ta];
		[va, vb] = [vb, va];
		curve = mirrorCubicEase(curve);
	}
	if (ta < 0 || tb <= ta)
		h.fail('E_INVALID_PARAM', `The animation starts before the content of clip "${clip.name}"`, {
			path: ['at'],
		});
	const { easeOut, easeIn } = cubicToEases(curve);
	const key = (
		time: number,
		value: number,
		easeInV: Keyframe<number>['easeIn'],
		easeOutV: Keyframe<number>['easeOut'],
	) =>
		({
			id: h.ids.next('kf'),
			time,
			value,
			interpolation: 'bezier',
			easeIn: easeInV,
			easeOut: easeOutV,
		}) satisfies Keyframe<number>;
	out.value = va;
	out.keyframes = [key(ta, va, EASE_PRESETS.linear, easeOut), key(tb, vb, easeIn, EASE_PRESETS.linear)];
	return out;
}

/** Removes the parts of an earlier divide (part 1 stays) and takes its master trim out of part 1. */
function collapseParts(contents: Contents): Trim | null {
	const parts = findTrimParts(contents);
	if (!parts) return null;
	const linked = new Set(parts.linked.map((g) => g.id));
	for (let i = contents.length - 1; i >= 0; i--) if (linked.has(contents[i]!.id)) contents.splice(i, 1);
	const master = contents.find((it) => it.id === parts.master.id) as Group;
	return master.contents.pop() as Trim;
}

type AnimatedClip = {
	clipId: string;
	converted: boolean;
	/** Master trim first, then the part trims. */
	trimIds: string[];
	/** Groups this run created (the wrapper of divided contents, parts 2…N). */
	groupIds: string[];
	/** Divide styles: every part, part 1 first. */
	partIds: string[];
};

function animateClip(
	h: HandlerContext,
	seq: DSeq,
	clip: Draft<ShapeClip>,
	plan: TrimAnimationPlan,
	t0: number,
	converted: boolean,
): AnimatedClip {
	const contents = (clip.shape as Draft<{ contents: Contents }>).contents as Contents;
	// Replace, never stack: an earlier divide is merged back into part 1, its master (or a last top-level trim) reused.
	let reuse = collapseParts(contents);
	if (!reuse && contents[contents.length - 1]?.type === 'trim') reuse = contents.pop() as Trim;
	const master: Trim = reuse
		? { ...reuse }
		: newShapeItem('trim', { id: h.ids.next('shp'), name: nextItemName(contents, 'trim') });
	delete master.enabled;
	const result: AnimatedClip = {
		clipId: clip.id,
		converted,
		trimIds: [master.id],
		groupIds: [],
		partIds: [],
	};
	master.start = writeChannel(h, seq, clip, t0, plan.start, null);
	master.end = writeChannel(h, seq, clip, t0, plan.end, null);
	master.offset = writeChannel(
		h,
		seq,
		clip,
		t0,
		plan.offset,
		plan.linkedOffset ? trimLinkedOffsetExpression(master.id) : null,
	);
	if (plan.parts === null) {
		contents.push(master);
		return result;
	}
	const N = plan.parts;
	let part1: Group;
	if (contents.length === 1 && contents[0]!.type === 'group') part1 = contents[0] as Group;
	else {
		part1 = newShapeItem('group', { id: h.ids.next('shp'), name: 'Part 1', contents: contents.splice(0) });
		contents.push(part1);
		result.groupIds.push(part1.id);
	}
	if (countItems([part1]) * N > TRIM_ANIMATION_LIMITS.maxDividedItems)
		h.fail(
			'E_LIMIT',
			`Dividing "${clip.name}" into ${N} parts would make more than ${TRIM_ANIMATION_LIMITS.maxDividedItems} shape items`,
			{ path: ['copies'] },
		);
	part1.name = 'Part 1';
	const base = JSON.stringify(part1);
	result.partIds.push(part1.id);
	for (let i = 2; i <= N; i++) {
		const copy = reidKeyframes(reidItems([JSON.parse(base) as ShapeItem], () => h.ids.next('shp'))[0]!, () =>
			h.ids.next('kf'),
		) as Group;
		copy.name = `Part ${i}`;
		const trim = newShapeItem('trim', { id: h.ids.next('shp'), name: master.name });
		if (master.mode) trim.mode = master.mode;
		trim.start = {
			value: master.start.value,
			keyframes: [],
			expression: { text: trimPartExpression(part1.id, master.id, 'start'), enabled: true },
		};
		trim.end = {
			value: master.end.value,
			keyframes: [],
			expression: { text: trimPartExpression(part1.id, master.id, 'end'), enabled: true },
		};
		trim.offset = {
			value: ((i - 1) * 360) / N,
			keyframes: [],
			expression: { text: trimPartOffsetExpression(part1.id, master.id), enabled: true },
		};
		copy.contents.push(trim);
		contents.push(copy);
		result.groupIds.push(copy.id);
		result.partIds.push(copy.id);
		result.trimIds.push(trim.id);
	}
	part1.contents.push(master);
	return result;
}

export const shapeTrimHandlers = {
	'shape.animateTrim': (doc, cmd: CommandOf<'shape.animateTrim'>, h) => {
		const clips = eligibleClips(doc, cmd.clipIds, h, 'a Trim Paths animation', true);
		const plan = planTrimAnimation(cmd);
		const results: AnimatedClip[] = [];
		for (const { seq, clip, legacy } of clips) {
			if (legacy) convertShapeClipToVector(seq, clip, h);
			const t0 = cmd.at === undefined ? clip.start : h.frame(seq, cmd.at);
			results.push(animateClip(h, seq, clip, plan, t0, legacy));
		}
		return { clips: results, skipped: cmd.clipIds.filter((id) => !clips.some((c) => c.clip.id === id)) };
	},
	'shape.reversePathDirection': (doc, cmd: CommandOf<'shape.reversePathDirection'>, h) => {
		const clips = eligibleClips(doc, cmd.clipIds, h, 'Reverse Path Direction', false);
		return {
			clips: clips.map(({ clip }) => {
				let paths = 0;
				walkItems((clip.shape as Draft<{ contents: Contents }>).contents as Contents, (it) => {
					if (!PATH_TYPES.has(it.type)) return;
					const p = it as Draft<ShapeItemOf<'rect'>>;
					if (p.direction === 'reversed') delete p.direction;
					else p.direction = 'reversed';
					paths++;
				});
				return { clipId: clip.id, paths };
			}),
		};
	},
	'shape.addLine': (doc, cmd: CommandOf<'shape.addLine'>, h) => {
		const seq = h.sequence(doc, cmd.sequenceId);
		const frame = frameBox(seq);
		const horizontal = cmd.orientation === 'horizontal';
		const length = cmd.length ?? 0.6 * (horizontal ? frame.width : frame.height);
		const half = length / 2;
		const at = cmd.at === undefined ? 0 : h.frame(seq, cmd.at);
		const duration =
			cmd.durationFrames ??
			secondsToFrames(DEFAULT_SHAPE_SECONDS, seq.settings.frameRate as Rational, 'round');
		const track = rigTrack(seq, h, at, duration, cmd.trackId);
		// Content (0, 0) is the layer centre = the default anchor and position: the line is centred on it.
		const path = horizontal ? `M ${-half} 0 L ${half} 0` : `M 0 ${-half} L 0 ${half}`;
		const { clipId } = shapeHandlers['clip.addShape'](
			doc,
			{
				type: 'clip.addShape',
				...(cmd.sequenceId ? { sequenceId: cmd.sequenceId } : {}),
				at,
				duration,
				track,
				name: cmd.name ?? 'Line',
				...(cmd.ref ? { ref: cmd.ref } : {}),
				shape: {
					type: 'vector',
					contents: [
						{ type: 'path', path },
						{ type: 'stroke', color: cmd.color ?? [1, 1, 1, 1], width: cmd.strokeWidth ?? 8 },
					],
				},
			},
			h,
		) as { clipId: string };
		const contents = (seq.clips[clipId] as ShapeClip).shape as { contents: Contents };
		return { clipId, pathId: contents.contents[0]!.id, strokeId: contents.contents[1]!.id, length };
	},
} satisfies HandlerMap;
