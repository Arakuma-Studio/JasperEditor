// Clip edges (spec 12 §2.2): a graphic (still, text, shape, solid, motion graphic, composition, animated image) that
// starts on V2 or above appears (`appear`); its end leaves (`exit`, ambient). Edges another source describes better
// are skipped: a transition at that edge, an In/Out text animation, an edit against an adjacent clip on the same track
// (the `edits` source) and — when the `keyframes` source runs — animated Motion/Opacity.
import { clipEnd } from '../../derive/index.ts';
import { isAnimated } from '../../keyframes.ts';
import { intrinsicBoxOf } from '../../registry/properties.ts';
import { clipContentTime, resolveLayerProps } from '../../render/scene.ts';
import type { Animatable } from '../../schema/common.ts';
import type { Clip, TextClip, Transform } from '../../schema/sequence.ts';
import type { SoundTypeId } from '../taxonomy.ts';
import type { CueCandidate } from './types.ts';
import { type CueContext, candidate, clamp01, clipName, contentClipsOnTrack, label, panOfX } from './util.ts';

const GRAPHIC_KINDS: ReadonlySet<string> = new Set([
	'still',
	'text',
	'shape',
	'solid',
	'motion-graphic',
	'composition',
	'animated-image',
]);

const APPEAR_TYPES: Record<string, SoundTypeId[]> = {
	text: ['pop', 'ui', 'swish'],
	'motion-graphic': ['whoosh', 'swish', 'pop'],
	composition: ['whoosh', 'swish', 'pop'],
};
const DEFAULT_APPEAR: SoundTypeId[] = ['pop', 'swish', 'ui'];

function animatedMotion(c: Clip): boolean {
	const tr = (c as { transform?: Transform | null }).transform;
	const op = (c as { opacity?: Animatable<number> }).opacity;
	const a = (x: unknown) =>
		!!x &&
		typeof x === 'object' &&
		Array.isArray((x as Animatable<unknown>).keyframes) &&
		isAnimated(x as Animatable<unknown>);
	return a(op) || (!!tr && (a(tr.position) || a(tr.scale) || a(tr.scaleWidth) || a(tr.rotation)));
}

function geometryAt(ctx: CueContext, c: Clip, frame: number): { area: number; pan: number } {
	try {
		const vc = c as TextClip;
		const box = intrinsicBoxOf({ clip: c, doc: ctx.doc, seq: ctx.seq });
		const p = resolveLayerProps(
			{ transform: vc.transform, opacity: vc.opacity, intrinsicBox: box, effects: [] },
			clipContentTime(c as never, frame, ctx.rate),
		);
		const area =
			clamp01((p.bounds.width * p.bounds.height) / (ctx.width * ctx.height)) * clamp01(p.opacity / 100);
		return { area: Math.max(area, 0.02), pan: panOfX(ctx, p.bounds.x + p.bounds.width / 2) };
	} catch {
		return { area: 0.1, pan: 0 };
	}
}

export function deriveEdgeCues(ctx: CueContext, opts: { keyframesSource: boolean }): CueCandidate[] {
	const cues: CueCandidate[] = [];
	const headTransition = new Set<string>();
	const tailTransition = new Set<string>();
	for (const t of Object.values(ctx.seq.transitions ?? {})) {
		if (t?.incomingClipId) headTransition.add(t.incomingClipId);
		if (t?.outgoingClipId) tailTransition.add(t.outgoingClipId);
	}
	for (const { track, index } of ctx.videoTracks) {
		if (index < 1) continue;
		const list = contentClipsOnTrack(ctx, track.id);
		for (let i = 0; i < list.length; i++) {
			const c = list[i]!;
			if (!GRAPHIC_KINDS.has(c.kind)) continue;
			if (opts.keyframesSource && animatedMotion(c)) continue;
			const ta = (c as TextClip).textAnimation;
			const prev = list[i - 1];
			const next = list[i + 1];
			const where = `on ${label(ctx, track.id)}`;
			if (
				!headTransition.has(c.id) &&
				!ta?.in &&
				!(prev && clipEnd(prev) === c.start) &&
				c.start >= ctx.range.start &&
				c.start < ctx.range.end
			) {
				const g = geometryAt(ctx, c, c.start);
				cues.push(
					candidate('clipEdges', {
						key: `clip:${c.id}:start`,
						frame: c.start,
						kind: 'appear',
						weight: 'support',
						types: APPEAR_TYPES[c.kind] ?? DEFAULT_APPEAR,
						align: 'peak',
						pan: g.pan,
						anchor: { type: 'clip', clipId: c.id, edge: 'start' },
						confidence: 0.5,
						reason: `${clipName(c)} (${c.kind}) appears ${where}`,
						size: g.area,
					}),
				);
			}
			const end = clipEnd(c);
			if (
				!tailTransition.has(c.id) &&
				!ta?.out &&
				!(next && next.start === end) &&
				end >= ctx.range.start &&
				end < ctx.range.end
			) {
				const g = geometryAt(ctx, c, end - 1);
				cues.push(
					candidate('clipEdges', {
						key: `clip:${c.id}:end`,
						frame: end,
						kind: 'exit',
						weight: 'ambient',
						types: ['swish', 'pop', 'whoosh'],
						align: 'peak',
						pan: g.pan,
						anchor: { type: 'clip', clipId: c.id, edge: 'end' },
						confidence: 0.35,
						reason: `${clipName(c)} (${c.kind}) disappears ${where}`,
						size: g.area,
					}),
				);
			}
		}
	}
	return cues;
}
