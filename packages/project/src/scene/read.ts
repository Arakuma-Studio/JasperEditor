// Clip → canonical layer (docs/wp-notes/scene-file.md § Canonical form): what a clip holds, in the scene's terms, for
// the diff of `jasper apply` and for `jasper export-scene`. An aspect the format cannot say exactly (an expression,
// roving keys, a curved motion path with custom handles, a second stroke, keyed masks…) is left out and named in
// `omitted`: the scene then does not manage it, so an apply of the exported file never rewrites it.
import type { Registries } from '../commands/types.ts';
import { easesToCubic } from '../ease/curve.ts';
import { spanEases, spanLeaving } from '../ease/segments.ts';
import { rovingRuns } from '../keyframes.ts';
import { intrinsicBoxOf, sequenceFrameOfContentTime } from '../registry/properties.ts';
import type { Animatable, Keyframe, RGBA, Vec2 } from '../schema/common.ts';
import type { ProjectDocument } from '../schema/document.ts';
import type { Mask } from '../schema/mask.ts';
import {
	type Clip,
	type EffectInstance,
	isLegacyShape,
	type Sequence,
	type TextAnimator,
	type TextClip,
} from '../schema/sequence.ts';
import type { Rational } from '../time.ts';
import type { SceneProp } from './format.ts';
import type {
	ResolvedSceneLayer,
	SceneAnimatorR,
	SceneAnimR,
	SceneEffectR,
	SceneKeyR,
	SceneLayerKind,
	SceneMaskR,
	SceneStrokeR,
	SceneTextR,
	SceneValueR,
} from './model.ts';
import { cubicEase, scenePropPath } from './resolve.ts';

/** Clip kinds a scene layer can be. */
export function sceneKindOf(clip: Clip): SceneLayerKind | null {
	if (clip.kind === 'text') return 'text';
	if (clip.kind === 'still') return 'image';
	if (clip.kind === 'composition') return 'composition';
	if (clip.kind === 'shape' && isLegacyShape((clip as Extract<Clip, { kind: 'shape' }>).shape))
		return 'shape';
	return null;
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** An animatable → canonical form, or null when it is not representable (expression, roving keys, curved paths). */
function anim(
	a: Animatable<unknown> | null | undefined,
	clip: Pick<Clip, 'start' | 'duration' | 'sourceIn' | 'speed'>,
	rate: Rational,
	opts: { point?: boolean } = {},
): SceneAnimR | null {
	if (!a) return null;
	if (a.expression?.enabled) return null;
	if (a.keyframes.length === 0) return { kind: 'static', value: clone(a.value) as SceneValueR };
	const sorted = [...a.keyframes].sort((x, y) => x.time - y.time) as Keyframe<unknown>[];
	if (sorted.some((k) => k.roving)) return null;
	const runs = rovingRuns(sorted);
	const keys: SceneKeyR[] = [];
	for (let i = 0; i < sorted.length; i++) {
		const k = sorted[i]!;
		const mode = k.spatial?.mode ?? 'linear';
		if (mode !== 'linear' && mode !== 'auto-bezier') return null;
		if (!opts.point && mode !== 'linear' && i < sorted.length - 1) return null;
		const sp = spanLeaving(sorted, i, runs);
		let ease: SceneKeyR['ease'] = { kind: 'linear' };
		if (sp) {
			const e = spanEases(sorted, sp.a, sp.b);
			ease = e.hold ? { kind: 'hold' } : e.linear ? { kind: 'linear' } : cubicEase(easesToCubic(e.out, e.in));
		}
		keys.push({
			frame: sequenceFrameOfContentTime(clip, k.time, rate) - clip.start,
			value: clone(k.value) as SceneValueR,
			ease,
			...(opts.point ? { path: mode === 'auto-bezier' ? ('auto' as const) : ('linear' as const) } : {}),
		});
	}
	return { kind: 'keys', keys };
}

function get(obj: unknown, path: readonly string[]): unknown {
	let o = obj;
	for (const p of path) o = o && typeof o === 'object' ? (o as Record<string, unknown>)[p] : undefined;
	return o;
}

/** Effects a scene manages: not internal render stages and not carrying data the format cannot say. */
export function isSceneEffect(fx: EffectInstance, registries: Registries): boolean {
	const spec = registries.effects.get(fx.effectId, fx.effectVersion);
	if (!spec || spec.internal || spec.appliesTo !== 'video') return false;
	const x = fx as Record<string, unknown>;
	for (const k of ['appearance', 'puppet', 'warpAnalysis', 'essential', 'subtitleTemplate', 'patternOrigin'])
		if (x[k] !== undefined) return false;
	return !(fx.masks && fx.masks.length > 0);
}

function readEffect(
	fx: EffectInstance,
	clip: Clip,
	rate: Rational,
	registries: Registries,
): SceneEffectR | null {
	const spec = registries.effects.get(fx.effectId, fx.effectVersion)!;
	const params: Record<string, SceneAnimR> = {};
	for (const p of spec.params) {
		const stored = fx.params[p.name] as Animatable<unknown> | undefined;
		if (!stored) {
			params[p.name] = { kind: 'static', value: clone(p.default) as SceneValueR };
			continue;
		}
		const a = anim(stored, clip, rate);
		if (!a) return null;
		params[p.name] = a;
	}
	return { effectId: spec.id, enabled: fx.enabled, params };
}

function readMask(m: Mask): SceneMaskR | null {
	const keyed = [m.path, m.feather, m.opacity, m.expansion].some(
		(a) => a.keyframes.length > 0 || a.expression?.enabled,
	);
	if (
		keyed ||
		(m.path.value.feather?.length ?? 0) > 0 ||
		m.locked ||
		(m.trackMethod && m.trackMethod !== 'position-scale-rotation')
	)
		return null;
	return {
		shape: m.shape ?? 'bezier',
		mode: m.mode,
		inverted: m.inverted,
		feather: m.feather.value,
		opacity: m.opacity.value,
		expansion: m.expansion.value,
		falloff: m.featherFalloff ?? 'smooth',
		closed: m.path.value.closed,
		vertices: m.path.value.vertices.map((v) => ({
			p: [...v.p] as Vec2,
			in: [...v.in] as Vec2,
			out: [...v.out] as Vec2,
		})),
	};
}

function readAnimator(a: TextAnimator | null | undefined): SceneAnimatorR | null {
	return a
		? { preset: a.preset, version: a.version, durationFrames: a.durationFrames, params: clone(a.params) }
		: null;
}

function readText(doc: ProjectDocument, clip: TextClip, omitted: string[]): SceneTextR {
	const s = clip.content.style;
	const t: SceneTextR = {
		text: clip.content.text,
		sizePx: s.sizePx,
		weight: s.weight,
		italic: s.italic,
		fill: [...s.fill] as RGBA,
		align: s.align,
		lineHeight: s.lineHeight,
		trackingEm: s.trackingEm,
		allCaps: s.allCaps,
		shadow: s.shadow
			? {
					color: [...s.shadow.color] as RGBA,
					angleDeg: s.shadow.angleDeg,
					distancePx: s.shadow.distancePx,
					blurPx: s.shadow.blurPx,
					spreadPx: s.shadow.spreadPx ?? 0,
				}
			: null,
		background: s.background
			? {
					color: [...s.background.color] as RGBA,
					paddingPx: s.background.paddingPx,
					radiusPx: s.background.radiusPx,
				}
			: null,
		box:
			clip.box.autoSize === 'width'
				? { mode: 'point' }
				: clip.box.autoSize === 'height'
					? { mode: 'paragraph', width: clip.box.width }
					: { mode: 'box', width: clip.box.width, height: clip.box.height },
		animIn: readAnimator(clip.textAnimation?.in),
		animOut: readAnimator(clip.textAnimation?.out),
	};
	const font = doc.fonts[s.fontId];
	if (font) t.font = font.family;
	else omitted.push('font');
	if (s.strokes.length <= 1) {
		const st = s.strokes[0];
		t.stroke = st ? { color: [...st.color] as RGBA, width: st.widthPx, position: st.position } : null;
	} else omitted.push('stroke (several strokes)');
	for (const [k, why] of [
		['runs', 'styled runs'],
		['paragraphs', 'paragraph styles'],
		['expression', 'a Source Text expression'],
	] as const)
		if ((clip.content as Record<string, unknown>)[k] !== undefined) omitted.push(why);
	if (clip.content.writingMode === 'vertical') omitted.push('vertical text');
	if (clip.sourceTextKeyframes?.length) omitted.push('Source Text keys');
	if (clip.animators?.length) omitted.push('text animators');
	return t;
}

/** The anchor a layer starts with (the centre of its box, `intrinsicBoxOf`): exports leave such an anchor out. */
export function defaultAnchor(doc: ProjectDocument, seq: Sequence, clip: Clip): Vec2 | null {
	if (clip.kind === 'shape') {
		const size = (clip as Extract<Clip, { kind: 'shape' }>).shape as { size?: Animatable<Vec2> };
		if (!size.size || size.size.keyframes.length > 0) return null;
	}
	const box = intrinsicBoxOf({ doc, seq, clip });
	return [box.width / 2, box.height / 2];
}

export type ReadLayer = { layer: ResolvedSceneLayer; omitted: string[] };

/** A clip as a canonical layer (id = the clip name), or null for clips a scene cannot describe. */
export function readSceneLayer(
	doc: ProjectDocument,
	seq: Sequence,
	clip: Clip,
	registries: Registries,
): ReadLayer | null {
	const kind = sceneKindOf(clip);
	const trackIndex = seq.videoTracks.findIndex((t) => t.id === clip.trackId);
	if (!kind || trackIndex < 0) return null;
	const rate = seq.settings.frameRate as Rational;
	const omitted: string[] = [];
	const c = clip as Extract<Clip, { kind: 'text' | 'still' | 'shape' | 'composition' }>;
	const layer: ResolvedSceneLayer = {
		id: clip.name,
		name: clip.name,
		kind,
		start: clip.start,
		duration: clip.duration,
		track: trackIndex + 1,
		props: {},
		blend: c.blendMode,
		index: -1,
	};
	const props: SceneProp[] = ['position', 'anchor', 'scale', 'rotation', 'opacity'];
	if (kind === 'shape') props.push('size', 'radius', 'fill');
	for (const p of props) {
		if (p === 'scale' && !c.transform.uniformScale) {
			omitted.push('scale (non-uniform)');
			continue;
		}
		const raw = get(c, scenePropPath(p)) as Animatable<unknown> | null | undefined;
		if (p === 'fill' && raw === null) {
			layer.props.fill = { kind: 'static', value: null };
			continue;
		}
		const a = anim(raw, clip, rate, { point: p === 'position' });
		if (a) layer.props[p] = a;
		else if (raw) omitted.push(p);
	}
	const managed = c.effects.filter((fx) => isSceneEffect(fx, registries));
	const fx = managed.map((f) => readEffect(f, clip, rate, registries));
	if (fx.every((f): f is SceneEffectR => f !== null)) layer.effects = fx;
	else omitted.push('effects (keyed params the format cannot say)');
	const masks = (c.masks ?? []).map(readMask);
	if (masks.every((m): m is SceneMaskR => m !== null)) layer.masks = masks;
	else omitted.push('masks (keyed, tracked or variable feather)');
	switch (c.kind) {
		case 'text':
			layer.text = readText(doc, c, omitted);
			break;
		case 'still':
			layer.mediaId = c.mediaId;
			break;
		case 'shape': {
			const sh = c.shape as Extract<typeof c.shape, { type: 'rect' | 'ellipse' }>;
			layer.shape = { type: sh.type };
			if (sh.stroke === null) layer.shape.stroke = null;
			else if (sh.stroke.color.keyframes.length || sh.stroke.width.keyframes.length)
				omitted.push('stroke (keyed)');
			else
				layer.shape.stroke = {
					color: [...sh.stroke.color.value] as RGBA,
					width: sh.stroke.width.value,
					position: sh.stroke.position,
				} satisfies SceneStrokeR;
			break;
		}
		case 'composition':
			if (!c.composition.mediaId) return null;
			layer.composition = { mediaId: c.composition.mediaId, id: c.composition.id, props: clone(c.props) };
			break;
	}
	if ((c as { threeD?: unknown }).threeD) omitted.push('3D layer');
	if ((c as { trackedBy?: unknown }).trackedBy) omitted.push('tracking');
	return { layer, omitted };
}
