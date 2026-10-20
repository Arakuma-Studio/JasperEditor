// shape.addTrimTracer (path-trace): drives a follower clip with expressions that ride a Trim Paths tip. The handler
// only writes expression text (it cannot evaluate: the expression engine is WebAssembly in @jasper/expressions); the
// expressions read the trim's values and the path it measures at every frame through the Path methods
// (`trimPath()`, `pointOnPath()`, `tangentOnPath()`), so preview and every export path compute the same tip.
import type { Draft } from 'immer';
import { kindCapabilities } from '../../registry/kinds.ts';
import type { Animatable, Expression } from '../../schema/common.ts';
import type { Clip, ShapeClip } from '../../schema/sequence.ts';
import type { ShapeItem, ShapeTrimItem, VectorShapeData } from '../../schema/shapes.ts';
import { findItem } from '../../vector/defaults.ts';
import { trimInputPaths } from '../../vector/evaluate.ts';
import { findTrimParts } from '../../vector/trim-animate.ts';
import type { DClip, DDoc, DSeq, HandlerContext } from '../context.ts';
import { assertUnlocked, findTrackIn, trackClipIds } from '../placement.ts';
import type { CommandOf } from '../schemas/index.ts';
import { expressionHandlers } from './expression.ts';
import { sequenceHandlers } from './sequence.ts';
import { shapeHandlers } from './shape.ts';
import type { HandlerMap } from './util.ts';

/** Diameter of the dot a tracer creates (px). */
const DOT_SIZE = 12;

/** Sum of the keyframe value changes of a trim property (how much it animates). */
function variation(a: Animatable<number>): number {
	let v = 0;
	for (let i = 1; i < a.keyframes.length; i++)
		v += Math.abs(a.keyframes[i]!.value - a.keyframes[i - 1]!.value);
	return Number.isFinite(v) ? v : 0;
}

/** Text safe inside a `//` comment and a JS string. */
const label = (s: string) => s.replace(/[\r\n\u2028\u2029]+/g, ' ');

/** The follower's track: the free, unlocked video track right above the shape clip, else a new one there. */
function followerTrack(doc: DDoc, seq: DSeq, shape: DClip, h: HandlerContext): string {
	const loc = findTrackIn(seq, shape.trackId);
	if (loc?.kind !== 'video') return h.fail('E_TRACK_KIND', 'The shape clip is not on a video track');
	const above = seq.videoTracks[loc.index + 1];
	const end = shape.start + shape.duration;
	if (
		above &&
		!above.locked &&
		trackClipIds(seq, above.id, (c) => c.start < end && c.start + c.duration > shape.start).length === 0
	)
		return above.id;
	const r = sequenceHandlers['track.add'](
		doc,
		{ type: 'track.add', sequenceId: seq.id, kind: 'video', index: loc.index + 1 } as CommandOf<'track.add'>,
		h,
	) as { trackIds: string[] };
	return r.trackIds[0]!;
}

export function trimTracerExpressions(o: {
	clipId: string;
	clipName: string;
	groupIds: readonly string[];
	trim: { id: string; name: string };
	path: { id: string; name: string } | null;
	tip: 'start' | 'end';
}): { position: string; rotation: string } {
	const tipName = o.tip === 'start' ? 'Start' : 'End';
	const chain = [...o.groupIds, o.trim.id].map((id) => `.content(${JSON.stringify(id)})`).join('');
	const along = o.path ? `"${label(o.path.name)}"` : 'every path it trims (Individually)';
	const head = [
		`// Trim tracer: rides the ${tipName} of "${label(o.trim.name)}" along ${along} on layer "${label(o.clipName)}".`,
		'// The layer and shape items are addressed by id, so renaming them keeps it working.',
		`var shape = thisComp.layer(${JSON.stringify(o.clipId)});`,
		`var trim = shape${chain};`,
		o.path
			? `var path = trim.trimPath(${JSON.stringify(o.path.id)}); // the path as the trim measures it`
			: 'var path = trim.trimPath(); // all its paths laid end to end, as Individually measures them',
		`// ${tipName} % plus Offset (360° = one whole length), wrapped like Trim Paths.`,
		`var u = clamp(trim.${o.tip} / 100, 0, 1) + ((trim.offset / 360) % 1 + 1) % 1;`,
		o.tip === 'start' ? 'if (u >= 1) u -= 1;' : 'if (u > 1) u -= 1;',
	];
	return {
		position: [...head, 'shape.toComp(trim.toLayer(path.pointOnPath(u)))'].join('\n'),
		rotation: [
			...head,
			'var d = shape.toCompVec(trim.toLayerVec(path.tangentOnPath(u)));',
			'value + radiansToDegrees(Math.atan2(d[1], d[0]))',
		].join('\n'),
	};
}

/**
 * The trim `shape.animateTrim` animates (and reuses on a re-run): Part 1's master after a divide, else the last
 * top-level item when it is a Trim Paths; null when there is none.
 */
function masterTrimId(contents: readonly ShapeItem[]): string | null {
	const parts = findTrimParts(contents);
	if (parts) return parts.trim.id;
	const last = contents[contents.length - 1];
	return last?.type === 'trim' ? last.id : null;
}

export const shapeTracerHandlers = {
	'shape.addTrimTracer': (doc, cmd: CommandOf<'shape.addTrimTracer'>, h: HandlerContext) => {
		const { seq, clip } = h.clip(doc, cmd.clipId);
		if (clip.kind !== 'shape' || (clip as Draft<ShapeClip>).shape.type !== 'vector')
			return h.fail('E_INVALID_PARAM', `Clip ${cmd.clipId} is not a vector shape`, { path: ['clipId'] });
		const contents = ((clip as Draft<ShapeClip>).shape as VectorShapeData).contents;
		const trimItemId = cmd.trimItemId ?? masterTrimId(contents);
		if (trimItemId === null)
			return h.fail(
				'E_INVALID_PARAM',
				`${clip.name} has no master Trim Paths (none animated by shape.animateTrim, no Trim Paths last in its contents): give trimItemId`,
				{ path: ['trimItemId'] },
			);
		const found = findItem(contents, trimItemId);
		if (!found) return h.fail('E_NOT_FOUND', `Shape item not found: ${trimItemId}`, { path: ['trimItemId'] });
		if (found.item.type !== 'trim')
			return h.fail('E_INVALID_PARAM', `${found.item.name} is not a Trim Paths`, { path: ['trimItemId'] });
		const trim = found.item as ShapeTrimItem;
		// What the trim measures is structural (which paths sit above it): any time gives the same item list.
		const input = trimInputPaths(contents, trim.id, h.clipContentTime(seq, clip, undefined));
		if (!input)
			return h.fail('E_INVALID_PARAM', `${trim.name} is inside a disabled group: it trims nothing`, {
				path: ['trimItemId'],
			});
		const origins = [...new Set(input.paths.map((p) => p.itemId))];
		if (!origins.length)
			return h.fail('E_INVALID_PARAM', `${trim.name} trims no path: add a path above it in its group`, {
				path: ['trimItemId'],
			});
		let pathId = origins[0]!;
		if (cmd.pathItemId !== undefined) {
			if (!findItem(contents, cmd.pathItemId))
				return h.fail('E_NOT_FOUND', `Shape item not found: ${cmd.pathItemId}`, { path: ['pathItemId'] });
			if (!origins.includes(cmd.pathItemId))
				return h.fail('E_INVALID_PARAM', `${trim.name} does not trim ${cmd.pathItemId}`, {
					path: ['pathItemId'],
				});
			pathId = cmd.pathItemId;
		}
		const individual = input.mode === 'individual';
		const tip =
			cmd.tip && cmd.tip !== 'auto' ? cmd.tip : variation(trim.start) > variation(trim.end) ? 'start' : 'end';

		// The follower: an existing visual clip of this sequence, or a new dot over the shape clip's span.
		let followerId: string;
		let created = false;
		if (cmd.follower) {
			const f = h.clip(doc, cmd.follower.clipId);
			if (f.seq.id !== seq.id)
				return h.fail('E_INVALID_PARAM', 'The follower must be in the same sequence as the shape clip', {
					path: ['follower', 'clipId'],
				});
			if (f.clip.id === clip.id)
				return h.fail(
					'E_CYCLE',
					'A shape clip cannot follow its own Trim Paths (its position moves the path)',
					{
						path: ['follower', 'clipId'],
					},
				);
			if (!kindCapabilities(f.clip.kind)?.visual || !('transform' in f.clip) || !f.clip.transform)
				return h.fail('E_INVALID_PARAM', `Clip ${f.clip.id} has no Motion to drive (${f.clip.kind} clip)`, {
					path: ['follower', 'clipId'],
				});
			assertUnlocked(findTrackIn(seq, f.clip.trackId)!.track, h);
			followerId = f.clip.id;
		} else {
			const trackId = followerTrack(doc, seq, clip, h);
			const r = shapeHandlers['clip.addShape'](
				doc,
				{
					type: 'clip.addShape',
					sequenceId: seq.id,
					at: clip.start,
					duration: clip.duration,
					track: trackId,
					name: cmd.name ?? 'Tracer',
					shape: {
						type: 'vector',
						contents: [
							{ type: 'ellipse', name: 'Dot', size: [DOT_SIZE, DOT_SIZE] },
							{ type: 'stroke', color: [0, 0, 0, 1], width: 1.5 },
							{ type: 'fill', color: [1, 1, 1, 1] },
						],
					},
				} as CommandOf<'clip.addShape'>,
				h,
			) as { clipId: string };
			followerId = r.clipId;
			created = true;
		}

		const pathItem = individual ? null : findItem(contents, pathId)!.item;
		const texts = trimTracerExpressions({
			clipId: clip.id,
			clipName: clip.name,
			groupIds: found.ancestors,
			trim: { id: trim.id, name: trim.name },
			path: pathItem ? { id: pathItem.id, name: pathItem.name } : null,
			tip,
		});
		const follower = seq.clips[followerId] as Draft<Clip> & {
			transform: { position: { expression?: Expression }; rotation: { expression?: Expression } };
		};
		const set = (prop: 'position' | 'rotation', text: string) => {
			if (follower.transform[prop].expression)
				h.warn(
					'W_EXPRESSION_REPLACED',
					`The ${prop === 'position' ? 'Position' : 'Rotation'} expression of ${follower.name} was replaced`,
					['follower', 'clipId'],
				);
			expressionHandlers['expression.set'](
				doc,
				{ type: 'expression.set', target: ['clip', followerId, 'transform', prop], text },
				h,
			);
		};
		set('position', texts.position);
		if (cmd.orient) set('rotation', texts.rotation);
		h.defineRef(cmd.ref, followerId);
		return {
			clipId: followerId,
			created,
			trackId: follower.trackId,
			trimItemId: trim.id,
			pathItemId: pathItem ? pathItem.id : null,
			mode: input.mode,
			tip,
			expressions: { position: texts.position, ...(cmd.orient ? { rotation: texts.rotation } : {}) },
		};
	},
} satisfies HandlerMap;
