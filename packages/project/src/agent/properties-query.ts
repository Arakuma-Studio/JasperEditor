// Property reads for agents (docs/wp-notes/mcp-cli.md §3): `clip.properties` and `param.get`. Every property
// comes back with `value` (the keyframed value at the time: what the Effect Controls field shows, i.e. the
// keys interpolated with the property's own rules — hold-only types step, numbers clamp to their range) and
// `evaluated` (what the renderer actually draws at that frame: the render snapshot's resolved layer, which
// does not clamp Motion and skips bypassed effects, disabled clips and hidden tracks), plus the keyframes in
// sequence frames and timecode.

import { compositionOfClip } from '../composition/props.ts';
import { findTrack, trackLabel } from '../derive/index.ts';
import { expressionInfoAt } from '../expressions.ts';
import { evaluate, evaluateKeyframes } from '../keyframes.ts';
import type { SpatialMetric } from '../keyframes-spatial.ts';
import { type EffectRegistry, paramSpatialMetric } from '../registry/effects.ts';
import type { MgTemplateRegistry } from '../registry/mg.ts';
import {
	effectPropertySpecs,
	type PropertySpec,
	propertiesForClip,
	propertyKeyToParamPath,
	resolvePropertyAt,
	sequenceFrameOfContentTime,
} from '../registry/properties.ts';
import { clipContentTime, resolveSceneAt } from '../render/scene.ts';
import { buildRenderSnapshot } from '../render/snapshot.ts';
import type { Animatable, Keyframe } from '../schema/common.ts';
import type { ProjectDocument } from '../schema/document.ts';
import type { Clip, EffectInstance, Sequence } from '../schema/sequence.ts';
import { flicksPerFrame, type Rational } from '../time.ts';
import { formatTimecode } from '../timecode.ts';
import type { Appearance } from '../title-looks/model.ts';
import { appearancePropertySpecs } from '../title-looks/properties.ts';
import { transitionSpec, transitionStartFrame } from '../transitions.ts';
import { type KeyEaseSummary, keyEaseSummaries } from './keyframe-eases.ts';
import { queryMediaHandle } from './media.ts';

export type PropertyQueryEnv = {
	doc: ProjectDocument;
	effects?: EffectRegistry;
	mgTemplates?: MgTemplateRegistry;
	/** The editor's playhead (default time when the query gives none). */
	playhead?(): { frame: number };
	activeSequenceId?: string | null;
};

export class PropertyQueryError extends Error {
	constructor(
		readonly code: 'E_NOT_FOUND' | 'E_INVALID_PARAM',
		message: string,
	) {
		super(message);
		this.name = 'PropertyQueryError';
	}
}

const round = (v: unknown): unknown => {
	if (typeof v === 'number') return Math.round(v * 1e4) / 1e4;
	if (Array.isArray(v)) return v.map(round);
	return v;
};

const tc = (seq: Sequence, frame: number) =>
	formatTimecode(frame, seq.settings.frameRate as Rational, {
		dropFrame: seq.settings.dropFrame,
		startFrames: seq.settings.startTimecodeFrames,
	});

function findClip(doc: ProjectDocument, clipId: string): { seq: Sequence; clip: Clip } {
	for (const seq of Object.values(doc.sequences)) {
		const clip = seq.clips[clipId];
		if (clip) return { seq, clip };
	}
	throw new PropertyQueryError('E_NOT_FOUND', `Clip not found: ${clipId}. get_timeline lists clip ids.`);
}

type KeyOut = {
	id: string;
	frame: number;
	timecode: string;
	value: unknown;
	interpolation: string;
	/** keyframe-sides: the incoming side when the key has one of its own. */
	inInterpolation?: string;
} & KeyEaseSummary;

/**
 * Maps keys to their listing entries, each with the compact ease of the segment leaving it (`metric`: the spatial
 * metric the property evaluates with — effect points — so auto-bezier eases match what renders).
 */
function withEases<T extends object>(
	keys: readonly Keyframe<unknown>[],
	entry: (k: Keyframe<unknown>) => T,
	metric?: SpatialMetric,
): (T & KeyEaseSummary)[] {
	const eases = keyEaseSummaries(keys, undefined, metric);
	return keys.map((k, i) => ({ ...entry(k), ...eases[i] }));
}

/** A property's keys in sequence frames, each with the compact ease of the segment leaving it. */
function keysOf(
	seq: Sequence,
	clip: Clip,
	anim: Animatable<unknown> | null,
	metric?: SpatialMetric,
): KeyOut[] {
	if (!anim) return [];
	return withEases(
		anim.keyframes as readonly Keyframe<unknown>[],
		(k) => {
			const frame = sequenceFrameOfContentTime(clip, k.time, seq.settings.frameRate as Rational);
			return {
				id: k.id,
				frame,
				timecode: tc(seq, frame),
				value: round(k.value),
				interpolation: k.interpolation,
				...(k.inInterpolation !== undefined ? { inInterpolation: k.inInterpolation } : {}),
			};
		},
		metric,
	);
}

/** Why a clip draws nothing at `frame` (null = it is rendered). */
function notRenderedReason(seq: Sequence, clip: Clip, frame: number): string | null {
	if (frame < clip.start || frame >= clip.start + clip.duration) return 'the frame is outside the clip';
	if (!clip.enabled) return 'the clip is disabled';
	const track = findTrack(seq, clip.trackId)?.track;
	if (track && track.kind === 'video' && track.output === false)
		return `track ${trackLabel(seq, clip.trackId)} has its output turned off`;
	return null;
}

type Resolved = {
	layer: ReturnType<typeof resolveSceneAt>[number] | null;
	audio: { volumeDb: number; pan: number } | null;
};

/** Keys whose rendered value the scene view holds (Motion, opacity, audio levels, effect params). */
const RENDERER_KEY = /^(transform\.|opacity$|volumeDb$|pan$|effects\.)/;

/** The renderer's view of a clip at a frame (the same snapshot + scene resolver the Program monitor uses). */
function rendererView(doc: ProjectDocument, seq: Sequence, clip: Clip, frame: number): Resolved {
	const snapshot = buildRenderSnapshot(doc, seq.id, {
		range: { start: frame, end: frame + 1 },
		resolveMedia: queryMediaHandle,
		resolveFont: () => null,
	});
	const layer = resolveSceneAt(snapshot, frame).find((l) => l.clip.clipId === clip.id) ?? null;
	const a = snapshot.audioClips.find(
		(x) => x.clipId === clip.id && frame >= x.start && frame < x.start + x.duration,
	);
	if (!a) return { layer, audio: null };
	const ct = clipContentTime(a, frame, snapshot.settings.fps);
	return { layer, audio: { volumeDb: evaluate(a.volumeDb, ct), pan: evaluate(a.pan, ct) } };
}

/** The rendered value of one property from the renderer's view; undefined = the renderer does not draw it. */
function renderedValue(
	view: Resolved,
	key: string,
	fallback: unknown,
): { value: unknown; rendered: boolean; why?: string } {
	const l = view.layer;
	const tr = l?.props.transform;
	const motion: Record<string, unknown> = tr
		? {
				'transform.position': tr.position,
				'transform.anchor': tr.anchor,
				'transform.scale': tr.scale,
				'transform.scaleWidth': tr.scaleWidth,
				'transform.rotation': tr.rotation,
				'transform.uniformScale': tr.uniformScale,
				'transform.flipH': tr.flipH,
				'transform.flipV': tr.flipV,
			}
		: {};
	if (key in motion) return { value: motion[key], rendered: !!l };
	if (key === 'opacity')
		return l ? { value: l.props.opacity, rendered: true } : { value: fallback, rendered: false };
	if (key === 'volumeDb' || key === 'pan')
		return view.audio
			? { value: view.audio[key], rendered: true }
			: {
					value: fallback,
					rendered: false,
					why: 'the clip is not audible at this frame (muted, solo or disabled)',
				};
	if (key.startsWith('effects.')) {
		const [, fxId, ...rest] = key.split('.');
		const name = rest.join('.');
		const fx = l?.props.effects.find((e) => e.id === fxId);
		if (!fx) return { value: fallback, rendered: false };
		if (!fx.enabled)
			return { value: fx.params[name] ?? fallback, rendered: false, why: 'the effect is bypassed' };
		return { value: name in fx.params ? fx.params[name] : fallback, rendered: true };
	}
	return { value: fallback, rendered: !!l || !!view.audio };
}

/** Every property spec of a clip (intrinsic, template / composition params, known effects' params). */
function clipSpecs(env: PropertyQueryEnv, clip: Clip) {
	const template =
		clip.kind === 'motion-graphic'
			? env.mgTemplates?.get(
					(clip as { template: { id: string } }).template.id,
					(clip as { template: { version: number } }).template.version,
				)
			: undefined;
	const composition =
		clip.kind === 'composition' ? compositionOfClip(env.doc as never, clip)?.info : undefined;
	const specs: PropertySpec[] = [...propertiesForClip(clip, template, composition ?? undefined)];
	const effectsOut: { id: string; effectId: string; enabled: boolean; known: boolean }[] = [];
	for (const fx of (clip as { effects?: EffectInstance[] }).effects ?? []) {
		const spec = env.effects?.get(fx.effectId, fx.effectVersion);
		effectsOut.push({ id: fx.id, effectId: fx.effectId, enabled: fx.enabled, known: !!spec });
		if (spec) specs.push(...effectPropertySpecs(fx, spec));
		// spec 19 TL-104: a look's palette, light and layer params, each with its `param.set` target
		if (fx.appearance) specs.push(...appearancePropertySpecs(fx, fx.appearance as Appearance));
	}
	return { specs, effectsOut };
}

const keyMatches = (key: string, filter: readonly string[] | null) =>
	!filter || filter.some((k) => key === k || key.startsWith(`${k}.`));

/**
 * The keyframes of a clip's animated properties (sequence frames, compact eases): only the keys / key prefixes
 * of `keys` (as clip.properties takes them) and only keys whose frame lies in [fromFrame, toFrame] when given.
 * `unmatched` lists the `keys` entries that name no property of the clip. Agents select keys with it (MCP
 * apply_ease, get_keyframe_eases…).
 */
export function clipKeyframesQuery(
	env: PropertyQueryEnv,
	args: { clipId: string; keys?: readonly string[]; fromFrame?: number; toFrame?: number },
) {
	const { seq, clip } = findClip(env.doc, args.clipId);
	const { specs } = clipSpecs(env, clip);
	const filter = args.keys?.length ? args.keys : null;
	const unmatched = (filter ?? []).filter((k) => !specs.some((s) => keyMatches(s.key, [k])));
	const ctx = { doc: env.doc, seq, clip };
	const lo = args.fromFrame ?? Number.NEGATIVE_INFINITY;
	const hi = args.toFrame ?? Number.POSITIVE_INFINITY;
	const properties = specs
		.filter((s) => keyMatches(s.key, filter))
		.flatMap((s) => {
			const r = resolvePropertyAt(ctx, s, clip.start);
			const keyframes = keysOf(seq, clip, r.anim, r.metric).filter((k) => k.frame >= lo && k.frame <= hi);
			if (!keyframes.length) return [];
			return [
				{ key: s.key, label: s.label, target: propertyKeyToParamPath({ clipId: clip.id }, s.key), keyframes },
			];
		});
	return { clipId: clip.id, sequenceId: seq.id, properties, unmatched };
}

/** Properties of a clip at a sequence frame, with keyframed `value` and rendered `evaluated`. */
export function clipPropertiesQuery(
	env: PropertyQueryEnv,
	args: { clipId: string; frame?: number; keys?: string[] },
) {
	const { seq, clip } = findClip(env.doc, args.clipId);
	const end = clip.start + clip.duration - 1;
	let frame = args.frame;
	if (frame === undefined) {
		const ph = env.playhead?.().frame;
		frame =
			ph !== undefined && env.activeSequenceId === seq.id && ph >= clip.start && ph <= end ? ph : clip.start;
	}
	if (frame < 0) throw new PropertyQueryError('E_INVALID_PARAM', 'frame must be ≥ 0');
	const at = Math.min(end, Math.max(clip.start, frame));
	const { specs, effectsOut } = clipSpecs(env, clip);
	const filter = args.keys?.length ? args.keys : null;
	const view = rendererView(env.doc, seq, clip, at);
	const ctx = { doc: env.doc, seq, clip };
	const why = notRenderedReason(seq, clip, frame);
	const properties = specs
		.filter((s) => keyMatches(s.key, filter))
		.map((s) => {
			const r = resolvePropertyAt(ctx, s, at);
			const rv = renderedValue(view, s.key, r.value);
			const keys = keysOf(seq, clip, r.anim, r.metric);
			const target = propertyKeyToParamPath({ clipId: clip.id }, s.key);
			// Wave expressions: the stored expression, its error, and its value where the scene view does not hold the
			// property (shape, text, masks…).
			const ex = expressionInfoAt(env.doc, target, seq.id, r.time);
			const evaluated = ex && 'value' in ex && !RENDERER_KEY.test(s.key) ? ex.value : rv.value;
			return {
				key: s.key,
				label: s.label,
				group: s.group,
				kind: s.kind,
				...(s.unit ? { unit: s.unit } : {}),
				animatable: s.animatable,
				target,
				value: round(r.value),
				evaluated: round(evaluated),
				animated: r.animated,
				...(ex ? { expression: ex.expression, ...(ex.error ? { expressionError: ex.error } : {}) } : {}),
				...(keys.length ? { keyframes: keys } : {}),
				...(!rv.rendered || why
					? { rendered: false, why: why ?? rv.why ?? 'the clip draws nothing at this frame' }
					: {}),
			};
		});
	return {
		clipId: clip.id,
		kind: clip.kind,
		name: clip.name,
		sequenceId: seq.id,
		track: trackLabel(seq, clip.trackId),
		frame,
		timecode: tc(seq, frame),
		...(at !== frame ? { evaluatedAt: { frame: at, timecode: tc(seq, at), outside: true } } : {}),
		...(effectsOut.length ? { effects: effectsOut } : {}),
		properties,
		notes:
			'value = the keyframed value at the frame (as Effect Controls shows it); evaluated = what the renderer draws at that frame. They differ where the renderer does not clamp (eased overshoot), for bypassed effects, and for clips the frame does not show.',
	};
}

/** One parameter by its param.set target path, with `value` and `evaluated` at a sequence frame. */
export function paramGetQuery(env: PropertyQueryEnv, args: { target: string[]; frame?: number }) {
	const [head, a, ...rest] = args.target;
	if (head === 'clip' && a) {
		const key = rest.join('.');
		const r = clipPropertiesQuery(env, { clipId: a, frame: args.frame, keys: [key] });
		const p = r.properties.find((x) => x.key === key);
		if (!p)
			throw new PropertyQueryError(
				'E_NOT_FOUND',
				`${a} has no property "${key}". clip.properties lists them: ${r.properties
					.map((x) => x.key)
					.slice(0, 40)
					.join(', ')}`,
			);
		return { ...r, properties: undefined, property: p };
	}
	if (head === 'effect' && a && rest.length === 1) {
		for (const seq of Object.values(env.doc.sequences)) {
			for (const clip of Object.values(seq.clips))
				if (((clip as { effects?: EffectInstance[] }).effects ?? []).some((e) => e.id === a))
					return paramGetQuery(env, { target: ['clip', clip.id, 'effects', a, rest[0]!], frame: args.frame });
			const lists = [...seq.videoTracks, ...seq.audioTracks]
				.map((t) => t.effects ?? [])
				.concat([seq.master.effects]);
			for (const list of lists) {
				const fx = list.find((e) => e.id === a);
				if (!fx) continue;
				const anim = fx.params[rest[0]!] as Animatable<unknown> | undefined;
				const spec = env.effects?.get(fx.effectId, fx.effectVersion)?.params.find((p) => p.name === rest[0]);
				if (!anim && !spec)
					throw new PropertyQueryError('E_NOT_FOUND', `Effect ${a} has no parameter ${rest[0]}`);
				return seqParam(
					seq,
					args.frame,
					anim ?? { value: spec!.default, keyframes: [] },
					fx.enabled ? null : 'the effect is bypassed',
					// spatial-points: track / master effect points measure their paths in the sequence frame's pixels.
					paramSpatialMetric(spec, { width: seq.settings.width, height: seq.settings.height }),
				);
			}
		}
		throw new PropertyQueryError('E_NOT_FOUND', `Effect instance not found: ${a}`);
	}
	if (head === 'transition' && a && rest.length === 1) {
		for (const seq of Object.values(env.doc.sequences)) {
			const t = seq.transitions[a];
			if (!t) continue;
			const spec = transitionSpec(t.effectId);
			const p = spec?.params.find((x) => x.name === rest[0]);
			if (!p) throw new PropertyQueryError('E_NOT_FOUND', `Transition ${a} has no parameter ${rest[0]}`);
			const anim = (t.params[p.name] as Animatable<unknown> | undefined) ?? {
				value: p.default,
				keyframes: [],
			};
			const start = transitionStartFrame(seq, t) ?? 0;
			const F = flicksPerFrame(seq.settings.frameRate as Rational);
			const frame = args.frame ?? start;
			const local = Math.round(Math.min(t.duration - 1, Math.max(0, frame - start)));
			const value = evaluateKeyframes(anim, local * F);
			const ex = expressionInfoAt(env.doc, args.target, seq.id, local * F);
			return {
				target: args.target,
				sequenceId: seq.id,
				frame,
				timecode: tc(seq, frame),
				value: round(value),
				evaluated: round(ex && 'value' in ex ? ex.value : value),
				...(ex ? { expression: ex.expression, ...(ex.error ? { expressionError: ex.error } : {}) } : {}),
				animated: anim.keyframes.length > 0,
				...(anim.keyframes.length
					? {
							keyframes: withEases(anim.keyframes, (k) => ({
								id: k.id,
								frame: start + Math.round(k.time / F),
								timecode: tc(seq, start + Math.round(k.time / F)),
								value: round(k.value),
								interpolation: k.interpolation,
								...(k.inInterpolation !== undefined ? { inInterpolation: k.inInterpolation } : {}),
							})),
						}
					: {}),
				...(frame < start || frame >= start + t.duration
					? { rendered: false, why: 'the frame is outside the transition' }
					: {}),
			};
		}
		throw new PropertyQueryError('E_NOT_FOUND', `Transition not found: ${a}`);
	}
	if (head === 'track' && a && rest.length === 1 && (rest[0] === 'volumeDb' || rest[0] === 'pan')) {
		for (const seq of Object.values(env.doc.sequences)) {
			const track = seq.audioTracks.find((t) => t.id === a || trackLabel(seq, t.id) === a);
			if (!track) continue;
			const anim = (track[rest[0]] as Animatable<number> | undefined) ?? { value: 0, keyframes: [] };
			return seqParam(seq, args.frame, anim, null);
		}
		throw new PropertyQueryError('E_NOT_FOUND', `Audio track not found: ${a}`);
	}
	throw new PropertyQueryError(
		'E_INVALID_PARAM',
		`Unsupported target ${JSON.stringify(args.target)}: use ["clip", clipId, ...key], ["effect", effectInstanceId, param], ["transition", transitionId, param] or ["track", trackId, "volumeDb"|"pan"]`,
	);
}

/** A sequence-timed parameter (track and master effects, track volume / pan). */
function seqParam(
	seq: Sequence,
	frameArg: number | undefined,
	anim: Animatable<unknown>,
	notRendered: string | null,
	metric?: SpatialMetric,
) {
	const F = flicksPerFrame(seq.settings.frameRate as Rational);
	const frame = frameArg ?? 0;
	const value = evaluate(anim, frame * F, metric ? { metric } : undefined);
	return {
		sequenceId: seq.id,
		frame,
		timecode: tc(seq, frame),
		value: round(value),
		evaluated: round(value),
		animated: anim.keyframes.length > 0,
		...(anim.keyframes.length
			? {
					keyframes: withEases(
						anim.keyframes,
						(k) => ({
							id: k.id,
							frame: Math.round(k.time / F),
							timecode: tc(seq, Math.round(k.time / F)),
							value: round(k.value),
							interpolation: k.interpolation,
							...(k.inInterpolation !== undefined ? { inInterpolation: k.inInterpolation } : {}),
						}),
						metric,
					),
				}
			: {}),
		...(notRendered ? { rendered: false, why: notRendered } : {}),
	};
}
