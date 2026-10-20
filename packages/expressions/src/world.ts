// The host side of expressions: maps After Effects' object model onto a Premiere-style document and answers the
// prelude's requests (docs/wp-notes/expressions.md §4).
//
//   comp  = sequence (name = its project item name; `thisComp` = the property's own sequence)
//   layer = clip. Layer index 1 is the topmost: caption tracks, then video tracks top (Vn) → bottom (V1), then
//           audio tracks A1 → An; clips of a track in start order. `inPoint`/`outPoint` = the clip's first and
//           one-past-last sequence frame in seconds, `startTime` = the sequence time of source time 0.
//   time  = sequence seconds. Keyframes live in each clip's content time; the clip's speed/reverse map between.
//   properties = the property-registry keys (`transform.position`, `effects.<fxId>.<param>`, …) arranged in AE-like
//           groups: Transform (Anchor Point, Position, Scale, Scale Width, Rotation, Opacity), Effects
//           (effect(name)(param)), Shape, Audio (Audio Levels = Volume, Pan), Text (Source Text), template Params.
//
// Track, master and transition properties have no layer: `thisLayer` raises an error there; `thisComp`, `time`,
// `value`, `thisProperty` and every global function work.
import {
	type Animatable,
	type CameraClip,
	type CameraState,
	type Clip,
	cameraProjection,
	cameraStateOf,
	contentTimeAt,
	defaultCamera,
	defaultEffectRegistry,
	type EffectInstance,
	type EffectSpec,
	type EvaluateOptions,
	type Expression,
	type ExpressionRef,
	type ExpressionWorldData,
	effectParamPropertySpec,
	evaluateKeyframes,
	FLICKS_PER_SECOND,
	findItem,
	flicksPerFrame,
	getPropertySpec,
	hasActiveExpression,
	invertMat3,
	isShapeOutlineItem,
	type Keyframe,
	kindCapabilities,
	type Layer3D,
	layerMapOf,
	layerWorldMatrix,
	MAT4_IDENTITY,
	maskPropertySpec,
	mat4Invert,
	type ParamSpec,
	PathQuery,
	type PropertySpec,
	PUPPET_PIN_LABELS,
	PUPPET_PIN_PROPS,
	planeHomography,
	propertyEvaluateOptions,
	type Rational,
	type RenderCameraClip,
	type RenderVisualClip,
	resolveLayerProps,
	resolvePropertySpec,
	resolveTextAnimatorSpec,
	type Sequence,
	type ShapeItem,
	sequenceDuration,
	shapeGeom,
	shapeItemMatrix,
	shapeItemPath,
	shapeItemSpecs,
	type TextAnimatorGroup,
	type TextContent,
	type Track,
	textAnimatorPropertySpecs,
	transitionSpec,
	transitionStartFrame,
	trimPathAt,
	type VectorShapeData,
} from '@jasper/project';
import { OP } from './ops.ts';
import { type HostHandler, type RunState, runExpression } from './runtime.ts';
import { fromExpressionValue, type PropKind, toExpressionValue } from './values.ts';

/** How a property's stored times relate to sequence seconds. */
export type TimeMap = {
	/** Stored time (content flicks / sequence flicks / transition-local flicks) → sequence seconds. */
	toSeconds(t: number): number;
	toStored(seconds: number): number;
};

export type ResolvedProp = {
	ref: ExpressionRef;
	name: string;
	matchName: string;
	kind: PropKind;
	options?: readonly string[];
	opts: EvaluateOptions;
	/** The stored animatable (a synthesized one for effect params at their default, and Source Text). */
	anim: Animatable<unknown>;
	expression: Expression | undefined;
	time: TimeMap;
	propertyIndex: number;
};

type Node = {
	path: string;
	group: boolean;
	name: string;
	matchName: string;
	aliases: readonly string[];
	enabled?: boolean;
};

type OwnerInfo = { seqId: string } & (
	| { kind: 'clip'; seq: Sequence; clip: Clip }
	| { kind: 'track'; seq: Sequence; track: Track }
	| { kind: 'master'; seq: Sequence }
	| { kind: 'transition'; seq: Sequence; id: string }
);

export type EvalStatus = { value: unknown; error: string | null };

const compact = (s: string) => s.replace(/\s+/g, '').toLowerCase();

function fps(seq: Sequence): number {
	const r = seq.settings.frameRate as Rational;
	return r.num / r.den;
}

function frameDuration(seq: Sequence): number {
	const r = seq.settings.frameRate as Rational;
	return r.den / r.num;
}

const VISUAL_KINDS_AUDIO = new Set(['audio', 'nest-audio']);

/** Effect display names in stack order: the instance name, else the label, numbered from the second duplicate. */
function effectNames(effects: readonly EffectInstance[]): string[] {
	const seen = new Map<string, number>();
	return effects.map((fx) => {
		if (fx.name) return fx.name;
		const label = defaultEffectRegistry.get(fx.effectId)?.label ?? fx.effectId;
		const n = (seen.get(label) ?? 0) + 1;
		seen.set(label, n);
		return n === 1 ? label : `${label} ${n}`;
	});
}

function propKind(kind: ParamSpec['type'] | PropertySpec['kind'], control?: string): PropKind {
	if (control === 'layer') return 'layer';
	switch (kind) {
		case 'number':
		case 'boolean':
		case 'enum':
		case 'string':
		case 'vec2':
		case 'vec3':
		case 'color':
			return kind;
		default:
			return 'other';
	}
}

/** Guess the kind of a value without a spec (template params). */
function kindOfValue(v: unknown): PropKind {
	if (typeof v === 'number') return 'number';
	if (typeof v === 'boolean') return 'boolean';
	if (typeof v === 'string') return 'string';
	if (Array.isArray(v) && v.every((x) => typeof x === 'number')) {
		if (v.length === 2) return 'vec2';
		if (v.length === 3) return 'vec3';
		if (v.length === 4) return 'color';
	}
	return 'other';
}

export class World {
	readonly data: ExpressionWorldData;
	/** Bound sequences (expressions attached), set by the binder; used for layer transforms. */
	bound: Record<string, Sequence> | null = null;
	private readonly layerCache = new Map<string, string[]>();
	private readonly propCache = new Map<string, ResolvedProp | null>();
	private readonly valueCache = new Map<string, Map<string, EvalStatus>>();
	private readonly childCache = new Map<string, Node[]>();
	/** Measured paths of the path methods per (layer, locator, time); bounded. */
	private readonly pathCache = new Map<string, PathQuery>();

	constructor(data: ExpressionWorldData) {
		this.data = data;
	}

	owner(seqId: string, owner: string): OwnerInfo | null {
		const seq = this.data.sequences[seqId];
		if (!seq) return null;
		if (owner === 'master') return { seqId, kind: 'master', seq };
		if (owner.startsWith('track:')) {
			const id = owner.slice(6);
			const track = [...seq.videoTracks, ...seq.audioTracks, ...seq.captionTracks].find((t) => t.id === id);
			return track ? { seqId, kind: 'track', seq, track } : null;
		}
		if (owner.startsWith('transition:')) {
			const id = owner.slice(11);
			return seq.transitions[id] ? { seqId, kind: 'transition', seq, id } : null;
		}
		const clip = seq.clips[owner];
		return clip ? { seqId, kind: 'clip', seq, clip } : null;
	}

	/** Clip ids in layer-index order (1 = topmost). */
	layers(seqId: string): string[] {
		const hit = this.layerCache.get(seqId);
		if (hit) return hit;
		const seq = this.data.sequences[seqId];
		if (!seq) return [];
		const byTrack = new Map<string, Clip[]>();
		for (const c of Object.values(seq.clips)) {
			const l = byTrack.get(c.trackId);
			if (l) l.push(c);
			else byTrack.set(c.trackId, [c]);
		}
		const order = [...seq.captionTracks, ...[...seq.videoTracks].reverse(), ...seq.audioTracks];
		const out: string[] = [];
		for (const t of order) {
			const list = (byTrack.get(t.id) ?? []).sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : 1));
			for (const c of list) out.push(c.id);
		}
		this.layerCache.set(seqId, out);
		return out;
	}

	box(seq: Sequence, clip: Clip): { width: number; height: number } {
		return this.data.boxes[clip.id] ?? { width: seq.settings.width, height: seq.settings.height };
	}

	clipTime(seq: Sequence, clip: Clip): TimeMap {
		const F = flicksPerFrame(seq.settings.frameRate as Rational);
		const rate = clip.speed.rate;
		return {
			toSeconds: (t) => {
				const i = (t - clip.sourceIn) / (F * rate);
				const frame = clip.speed.reverse ? clip.start + clip.duration - 1 - i : clip.start + i;
				return (frame * F) / FLICKS_PER_SECOND;
			},
			toStored: (s) => contentTimeAt(clip, (s * FLICKS_PER_SECOND) / F, seq.settings.frameRate as Rational),
		};
	}

	timeOf(info: OwnerInfo): TimeMap {
		if (info.kind === 'clip') return this.clipTime(info.seq, info.clip);
		if (info.kind === 'transition') {
			const F = flicksPerFrame(info.seq.settings.frameRate as Rational);
			const t = info.seq.transitions[info.id]!;
			const start = (transitionStartFrame(info.seq, t) ?? 0) * F;
			return {
				toSeconds: (x) => (start + x) / FLICKS_PER_SECOND,
				toStored: (s) => s * FLICKS_PER_SECOND - start,
			};
		}
		return { toSeconds: (x) => x / FLICKS_PER_SECOND, toStored: (s) => s * FLICKS_PER_SECOND };
	}

	private effectsOf(info: OwnerInfo): readonly EffectInstance[] {
		if (info.kind === 'clip') return 'effects' in info.clip ? info.clip.effects : [];
		if (info.kind === 'track') return info.track.effects ?? [];
		if (info.kind === 'master') return info.seq.master.effects;
		return [];
	}

	/** Masks of a clip and of its effects (stack order), as AE lists a layer's masks. */
	masksOf(info: OwnerInfo): { id: string; name: string; anims: Record<string, Animatable<number>> }[] {
		if (info.kind !== 'clip') return [];
		const c = info.clip;
		const all = [
			...('masks' in c ? (c.masks ?? []) : []),
			...this.effectsOf(info).flatMap((fx) => fx.masks ?? []),
		];
		return all.map((m) => ({
			id: m.id,
			name: m.name,
			anims: { feather: m.feather, opacity: m.opacity, expansion: m.expansion },
		}));
	}

	/**
	 * The property tree under `group` of an owner. Cached per world (a world belongs to one immutable document or
	 * snapshot): `content(…)` chains resolve through it on every evaluation.
	 */
	children(info: OwnerInfo, group: string): Node[] {
		const owner =
			info.kind === 'clip'
				? info.clip.id
				: info.kind === 'track'
					? `track:${info.track.id}`
					: info.kind === 'transition'
						? `transition:${info.id}`
						: 'master';
		const key = `${info.seqId}\u0000${owner}\u0000${group}`;
		const hit = this.childCache.get(key);
		if (hit) return hit;
		const out = this.computeChildren(info, group);
		this.childCache.set(key, out);
		return out;
	}

	private computeChildren(info: OwnerInfo, group: string): Node[] {
		const leaf = (path: string, name: string, ...aliases: string[]): Node => ({
			path,
			group: false,
			name,
			matchName: path,
			aliases,
		});
		if (group === '') {
			const out: Node[] = [];
			if (info.kind === 'transition') {
				const t = info.seq.transitions[info.id]!;
				const spec = transitionSpec(t.effectId);
				return (spec?.params ?? []).map((p) => leaf(p.name, p.label, p.name));
			}
			if (info.kind === 'clip') {
				const c = info.clip as Record<string, unknown>;
				if (c.transform || c.opacity)
					out.push({
						path: 'transform',
						group: true,
						name: 'Motion',
						matchName: 'transform',
						aliases: ['Transform', 'motion'],
					});
				if (Array.isArray(c.effects))
					out.push({
						path: 'effects',
						group: true,
						name: 'Effects',
						matchName: 'effects',
						aliases: ['effect', 'Effects'],
					});
				if (c.shape)
					out.push({ path: 'shape', group: true, name: 'Shape', matchName: 'shape', aliases: ['contents'] });
				if (this.masksOf(info).length)
					out.push({
						path: 'masks',
						group: true,
						name: 'Masks',
						matchName: 'masks',
						aliases: ['mask', 'Masks'],
					});
				if (VISUAL_KINDS_AUDIO.has(info.clip.kind))
					out.push({ path: 'audio', group: true, name: 'Audio', matchName: 'audio', aliases: ['Audio'] });
				if (info.clip.kind === 'text')
					out.push({ path: 'text', group: true, name: 'Text', matchName: 'text', aliases: ['Text'] });
				if (info.clip.kind === 'motion-graphic')
					out.push({
						path: 'params',
						group: true,
						name: 'Params',
						matchName: 'params',
						aliases: ['parameters'],
					});
				return out;
			}
			out.push({ path: 'audio', group: true, name: 'Audio', matchName: 'audio', aliases: ['Audio'] });
			out.push({
				path: 'effects',
				group: true,
				name: 'Effects',
				matchName: 'effects',
				aliases: ['effect', 'Effects'],
			});
			return out;
		}
		if (group === 'transform' && info.kind === 'clip') {
			const c = info.clip as Record<string, unknown>;
			const out: Node[] = [];
			if (c.transform) {
				out.push(leaf('transform.anchor', 'Anchor Point', 'anchorPoint', 'anchor'));
				out.push(leaf('transform.position', 'Position', 'position'));
				out.push(leaf('transform.scale', 'Scale', 'scale', 'scaleHeight'));
				out.push(leaf('transform.scaleWidth', 'Scale Width', 'scaleWidth'));
				out.push(leaf('transform.rotation', 'Rotation', 'rotation', 'zRotation'));
			}
			if (c.opacity) out.push(leaf('opacity', 'Opacity', 'opacity'));
			return out;
		}
		if (group === 'effects') {
			const fxs = this.effectsOf(info);
			const names = effectNames(fxs);
			return fxs.map((fx, i) => ({
				path: `effects.${fx.id}`,
				group: true,
				name: names[i]!,
				matchName: fx.effectId,
				aliases: [defaultEffectRegistry.get(fx.effectId)?.label ?? fx.effectId, fx.id],
				enabled: fx.enabled,
			}));
		}
		if (group.startsWith('effects.')) {
			const fxId = group.slice(8);
			const fx = this.effectsOf(info).find((e) => e.id === fxId);
			const spec = fx ? defaultEffectRegistry.get(fx.effectId, fx.effectVersion) : undefined;
			if (!fx) return [];
			if (!spec) return Object.keys(fx.params).map((n) => leaf(`${group}.${n}`, n, n));
			// a Puppet effect lists its pins (effect("Puppet")("Puppet Pin 1").position).
			const pins = fx.puppet?.pins ?? [];
			return [
				...spec.params.map((p) => leaf(`${group}.${p.name}`, p.label, p.name)),
				...pins.map((pin) => ({
					path: `puppet.${pin.id}`,
					group: true,
					name: pin.name,
					matchName: 'pin',
					aliases: [pin.id],
				})),
			];
		}
		if (group.startsWith('puppet.') && group.split('.').length === 2) {
			return PUPPET_PIN_PROPS.map((k) => leaf(`${group}.${k}`, PUPPET_PIN_LABELS[k], k));
		}
		// a vector shape's contents (AE: content("Group 1").content("Rectangle Path 1").size,
		// content("Group 1").transform.position).
		if (info.kind === 'clip' && (group === 'shape' || group.startsWith('shape.items.'))) {
			const sh = (info.clip as { shape?: { type?: string; contents?: ShapeItem[] } }).shape;
			if (sh?.type === 'vector') return vectorShapeChildren(info.clip, sh.contents ?? [], group, leaf);
		}
		if (group === 'shape' && info.kind === 'clip') {
			const shape = (info.clip as { shape?: { stroke?: unknown } }).shape;
			const out = [
				leaf('shape.size', 'Size', 'size'),
				leaf('shape.fill', 'Fill Color', 'fill', 'fillColor', 'color'),
			];
			if (shape?.stroke)
				out.push(
					leaf('shape.stroke.color', 'Stroke Color', 'strokeColor'),
					leaf('shape.stroke.width', 'Stroke Width', 'strokeWidth'),
				);
			out.push(leaf('shape.cornerRadius', 'Roundness', 'cornerRadius', 'roundness'));
			return out;
		}
		if (group === 'masks') {
			return this.masksOf(info).map((m) => ({
				path: `masks.${m.id}`,
				group: true,
				name: m.name,
				matchName: 'mask',
				aliases: [m.id],
			}));
		}
		if (group.startsWith('masks.')) {
			return [
				leaf(`${group}.feather`, 'Mask Feather', 'maskFeather', 'feather'),
				leaf(`${group}.opacity`, 'Mask Opacity', 'maskOpacity', 'opacity'),
				leaf(`${group}.expansion`, 'Mask Expansion', 'maskExpansion', 'expansion'),
			];
		}
		if (group === 'audio') {
			const out = [leaf('volumeDb', 'Volume', 'audioLevels', 'level', 'volume', 'Audio Levels')];
			if (info.kind !== 'master') out.push(leaf('pan', 'Pan', 'pan', 'balance'));
			return out;
		}
		if (group === 'text' && info.kind === 'clip') {
			const out = [leaf('text.content', 'Source Text', 'sourceText', 'text')];
			// text.animator("Animator 1").property.position, ….selector("Range Selector 1").start
			const animators = (info.clip as { animators?: TextAnimatorGroup[] }).animators ?? [];
			if (animators.length)
				out.push({
					path: 'textAnimators',
					group: true,
					name: 'Animators',
					matchName: 'animator',
					aliases: ['animators', 'Animators'],
				});
			const c = info.clip as { pathOptions?: unknown; moreOptions?: unknown };
			if (c.pathOptions)
				out.push({
					path: 'textPath',
					group: true,
					name: 'Path Options',
					matchName: 'pathOption',
					aliases: ['pathOptions'],
				});
			if (c.moreOptions)
				out.push({
					path: 'textMore',
					group: true,
					name: 'More Options',
					matchName: 'moreOption',
					aliases: ['moreOptions'],
				});
			return out;
		}
		if ((group === 'textPath' || group === 'textMore') && info.kind === 'clip') {
			const owner = group === 'textPath' ? 'pathOptions' : 'moreOptions';
			const g = (info.clip as unknown as Record<string, Record<string, unknown> | undefined>)[owner] ?? {};
			return textAnimatorPropertySpecs(info.clip as never)
				.filter(
					(sp) =>
						sp.key.startsWith(`${group}.`) && sp.animatable !== 'no' && g[sp.key.slice(group.length + 1)],
				)
				.map((sp) => leaf(sp.key, sp.label, sp.key.slice(group.length + 1)));
		}
		if (group.startsWith('textAnimators') && info.kind === 'clip') {
			const animators = (info.clip as { animators?: TextAnimatorGroup[] }).animators ?? [];
			const parts = group.split('.');
			if (parts.length === 1)
				return animators.map((a) => ({
					path: `textAnimators.${a.id}`,
					group: true,
					name: a.name,
					matchName: 'ADBE Text Animator',
					aliases: [a.id],
					enabled: a.enabled,
				}));
			const a = animators.find((x) => x.id === parts[1]);
			if (!a) return [];
			if (parts.length === 2)
				return [
					{
						path: `${group}.properties`,
						group: true,
						name: 'Properties',
						matchName: 'property',
						aliases: ['properties'],
					},
					{
						path: `${group}.selectors`,
						group: true,
						name: 'Selectors',
						matchName: 'selector',
						aliases: ['selectors'],
					},
				];
			const specs = textAnimatorPropertySpecs(info.clip as never).filter(
				(sp) => sp.key.startsWith(`${group}.`) && sp.animatable !== 'no',
			);
			if (parts[2] === 'properties' && parts.length === 3)
				return specs.map((sp) =>
					leaf(sp.key, sp.label, sp.key.slice(group.length + 1).replace(/^axes\./, '')),
				);
			if (parts[2] === 'selectors' && parts.length === 3)
				return a.selectors.map((sel) => ({
					path: `${group}.${sel.id}`,
					group: true,
					name: sel.name,
					matchName: `ADBE Text Selector`,
					aliases: [sel.id],
					enabled: sel.enabled,
				}));
			if (parts[2] === 'selectors' && parts.length === 4)
				return specs.map((sp) => leaf(sp.key, sp.label, sp.key.slice(group.length + 1)));
			return [];
		}
		if (group === 'params' && info.kind === 'clip') {
			const params = (info.clip as { params?: Record<string, unknown> }).params ?? {};
			return Object.keys(params).map((n) => leaf(`params.${n}`, n, n));
		}
		return [];
	}

	child(info: OwnerInfo, group: string, key: unknown): { node: Node; index: number; count: number } | null {
		const list = this.children(info, group);
		let i = -1;
		if (typeof key === 'number') i = Number.isInteger(key) && key >= 1 && key <= list.length ? key - 1 : -1;
		else {
			const k = String(key);
			i = list.findIndex((n) => n.name === k);
			if (i < 0) i = list.findIndex((n) => n.matchName === k || n.aliases.includes(k));
			if (i < 0) {
				const c = compact(k);
				i = list.findIndex(
					(n) =>
						compact(n.name) === c || compact(n.matchName) === c || n.aliases.some((a) => compact(a) === c),
				);
			}
		}
		if (i < 0) return null;
		const node = list[i]!;
		return { node, index: i + 1, count: node.group ? this.children(info, node.path).length : 0 };
	}

	prop(ref: ExpressionRef): ResolvedProp | null {
		const key = `${ref.seq}\u0000${ref.owner}\u0000${ref.path}`;
		if (this.propCache.has(key)) return this.propCache.get(key)!;
		const p = this.resolveProp(ref);
		this.propCache.set(key, p);
		return p;
	}

	private resolveProp(ref: ExpressionRef): ResolvedProp | null {
		const info = this.owner(ref.seq, ref.owner);
		if (!info) return null;
		const time = this.timeOf(info);
		const base = { ref, time };
		const indexIn = (group: string) =>
			Math.max(1, this.children(info, group).findIndex((n) => n.path === ref.path) + 1);
		if (ref.path.startsWith('effects.') && info.kind !== 'transition') {
			const [, fxId, ...rest] = ref.path.split('.');
			const name = rest.join('.');
			const fx = this.effectsOf(info).find((e) => e.id === fxId);
			if (!fx) return null;
			const spec = defaultEffectRegistry.get(fx.effectId, fx.effectVersion);
			const p = spec?.params.find((x) => x.name === name);
			const stored = fx.params[name];
			if (!p && !stored) return null;
			const ps = p && spec ? effectParamPropertySpec(fx.id, spec as EffectSpec, p) : null;
			const anim = stored ?? { value: p!.default, keyframes: [] };
			return {
				...base,
				name: p?.label ?? name,
				matchName: name,
				kind: p ? propKind(p.type, p.ui?.control) : kindOfValue(anim.value),
				options: p?.options,
				opts: ps ? propertyEvaluateOptions(ps) : {},
				anim,
				expression: anim.expression,
				propertyIndex: indexIn(`effects.${fx.id}`),
			};
		}
		if (info.kind === 'transition') {
			const t = info.seq.transitions[info.id]!;
			const spec = transitionSpec(t.effectId);
			const p = spec?.params.find((x) => x.name === ref.path);
			if (!p) return null;
			const anim = t.params[p.name] ?? {
				value: p.default,
				keyframes: [],
			};
			return {
				...base,
				name: p.label,
				matchName: p.name,
				kind: propKind(p.type, p.ui?.control),
				options: p.options,
				opts: propertyEvaluateOptions(
					effectParamPropertySpec(info.id, { id: t.effectId, appliesTo: 'video' } as EffectSpec, p),
				),
				anim,
				expression: anim.expression,
				propertyIndex: indexIn(''),
			};
		}
		if (info.kind === 'track' || info.kind === 'master') {
			if (ref.path !== 'volumeDb' && ref.path !== 'pan') return null;
			const anim =
				info.kind === 'master'
					? info.seq.master.volumeDb
					: (info.track[ref.path] ?? {
							value: 0,
							keyframes: [],
						});
			if (info.kind === 'master' && ref.path !== 'volumeDb') return null;
			const spec = getPropertySpec(ref.path)!;
			return {
				...base,
				name: spec.label,
				matchName: ref.path,
				kind: 'number',
				opts: propertyEvaluateOptions(spec),
				anim,
				expression: anim.expression,
				propertyIndex: indexIn('audio'),
			};
		}
		// Clip properties.
		const clip = info.clip as Record<string, unknown>;
		if (ref.path === 'text.content') {
			const content = clip.content as TextContent | undefined;
			if (!content) return null;
			// Source Text hold keys give the keyframed (pre-expression) text.
			const keys = ((clip.sourceTextKeyframes as Keyframe<TextContent>[] | undefined) ?? []).map((k) => ({
				...k,
				value: k.value.text,
			}));
			return {
				...base,
				name: 'Source Text',
				matchName: 'sourceText',
				kind: 'string',
				opts: { holdOnly: true },
				anim: { value: content.text, keyframes: keys, expression: content.expression },
				expression: content.expression,
				propertyIndex: 1,
			};
		}
		if (ref.path.startsWith('puppet.')) {
			const [, pinId, prop] = ref.path.split('.');
			const fxs = ((info.clip as { effects?: EffectInstance[] }).effects ?? []) as (EffectInstance & {
				puppet?: { pins: Record<string, unknown>[] };
			})[];
			const pin = fxs.flatMap((fx) => fx.puppet?.pins ?? []).find((q) => q.id === pinId);
			const anim = pin?.[prop!] as Animatable<unknown> | undefined;
			if (!pin || !anim || !(PUPPET_PIN_PROPS as readonly string[]).includes(prop!)) return null;
			return {
				...base,
				name: PUPPET_PIN_LABELS[prop as 'position'],
				matchName: prop!,
				kind: prop === 'position' ? 'vec2' : 'number',
				opts: {},
				anim,
				expression: anim.expression,
				propertyIndex: PUPPET_PIN_PROPS.indexOf(prop as 'position') + 1,
			};
		}
		if (ref.path.startsWith('masks.')) {
			const [, maskId, prop] = ref.path.split('.');
			const m = this.masksOf(info).find((x) => x.id === maskId);
			const anim = m?.anims[prop!];
			if (!m || !anim) return null;
			const spec = maskPropertySpec(maskId!, prop as 'feather');
			return {
				...base,
				name: spec.label,
				matchName: `mask${prop![0]!.toUpperCase()}${prop!.slice(1)}`,
				kind: 'number',
				opts: propertyEvaluateOptions(spec),
				anim,
				expression: anim.expression,
				propertyIndex: indexIn(`masks.${maskId}`),
			};
		}
		if (ref.path.startsWith('params.')) {
			const name = ref.path.slice(7);
			const params = (clip.params as Record<string, unknown> | undefined) ?? {};
			if (!(name in params)) return null;
			const kfs = (clip.paramKeyframes as Record<string, unknown[]> | undefined)?.[name] ?? [];
			const anim = { value: params[name], keyframes: kfs } as Animatable<unknown>;
			return {
				...base,
				name,
				matchName: name,
				kind: kindOfValue(params[name]),
				opts: {},
				anim,
				expression: undefined,
				propertyIndex: indexIn('params'),
			};
		}
		// dynamic `shape.items.<id>.<field>` keys resolve against the clip; dynamic
		// animator / selector / path / more-options keys too.
		const spec = ref.path.startsWith('shape.items.')
			? resolvePropertySpec(ref.path, undefined, undefined, info.clip as never)
			: (getPropertySpec(ref.path) ?? resolveTextAnimatorSpec(ref.path, info.clip as never));
		if (!spec || spec.animatable === 'no' || !spec.appliesTo(info.clip)) return null;
		let anim: unknown = clip;
		for (const k of spec.storagePath) anim = (anim as Record<string, unknown> | null | undefined)?.[k];
		if (!anim || typeof anim !== 'object' || !Array.isArray((anim as Animatable<unknown>).keyframes))
			return null;
		const a = anim as Animatable<unknown>;
		const textGroup = /^(textAnimators\.[^.]+\.(properties|selectors\.[^.]+)|textPath|textMore)\./.exec(
			ref.path,
		);
		const group = ref.path.startsWith('shape.items.')
			? vectorLeafGroup(ref.path)
			: ref.path.startsWith('transform.') || ref.path === 'opacity'
				? 'transform'
				: ref.path.startsWith('shape.')
					? 'shape'
					: textGroup
						? ref.path.slice(0, ref.path.lastIndexOf(ref.path.includes('.axes.') ? '.axes.' : '.'))
						: 'audio';
		return {
			...base,
			name: spec.label,
			matchName: ref.path,
			kind: propKind(spec.kind),
			options: spec.options,
			opts: propertyEvaluateOptions(spec),
			anim: a,
			expression: a.expression,
			propertyIndex: indexIn(group),
		};
	}

	/** Keyframed (pre-expression) value at stored time `t`. */
	pre(p: ResolvedProp, t: number, opts?: EvaluateOptions): unknown {
		return evaluateKeyframes(p.anim, t, opts ?? p.opts);
	}

	/** Post-expression value at stored time `t` with the error of a failed expression (value = keyframed then). */
	evaluate(ref: ExpressionRef, t: number, opts?: EvaluateOptions, selector?: SelectorInput): EvalStatus {
		const p = this.prop(ref);
		if (!p) return { value: undefined, error: 'Error: property not found' };
		// Audio levels are read per sample by the mixer: like AE, the expression runs once per frame and the
		// samples in between interpolate linearly.
		if (!selector && (ref.path === 'volumeDb' || ref.path === 'pan') && hasActiveExpression(p.anim)) {
			const seq = this.data.sequences[ref.seq]!;
			const f = p.time.toSeconds(t) * fps(seq);
			const f0 = Math.floor(f + 1e-9);
			if (Math.abs(f - f0) > 1e-9) {
				const at = (fr: number) => this.evaluateRaw(ref, p, p.time.toStored(fr / fps(seq)), opts);
				const a = at(f0);
				const b = at(f0 + 1);
				const u = f - f0;
				const lerp =
					typeof a.value === 'number' && typeof b.value === 'number'
						? a.value + (b.value - a.value) * u
						: a.value;
				return { value: lerp, error: a.error ?? b.error };
			}
		}
		return this.evaluateRaw(ref, p, t, opts, selector);
	}

	private evaluateRaw(
		ref: ExpressionRef,
		p: ResolvedProp,
		t: number,
		opts?: EvaluateOptions,
		selector?: SelectorInput,
	): EvalStatus {
		const o = opts ?? p.opts;
		const pre = this.pre(p, t, o);
		if (!hasActiveExpression(p.anim)) return { value: pre, error: null };
		const cacheKey = selector
			? null
			: `${t}|${o.holdOnly ? 1 : 0}|${o.clamp?.min ?? ''}|${o.clamp?.max ?? ''}`;
		const refKey = `${ref.seq}\u0000${ref.owner}\u0000${ref.path}`;
		let cache = this.valueCache.get(refKey);
		if (cacheKey !== null) {
			const hit = cache?.get(cacheKey);
			if (hit) return hit;
		}
		const out = this.run(p, t, pre, o, selector);
		if (cacheKey !== null) {
			if (!cache) this.valueCache.set(refKey, (cache = new Map()));
			if (cache.size > 256) cache.clear();
			cache.set(cacheKey, out);
		}
		return out;
	}

	/**
	 * Evaluates `text` as if it were the expression of the property at `ref` (not stored; no caching). With
	 * `selector` the raw script result is returned (the text Expression Selector converts it).
	 */
	evaluateText(ref: ExpressionRef, text: string, t: number, selector?: SelectorInput): EvalStatus {
		const p = this.prop(ref);
		if (!p) return { value: undefined, error: 'Error: property not found' };
		const adhoc: ResolvedProp = { ...p, anim: { ...p.anim, expression: { text, enabled: true } } };
		const pre = this.pre(p, t, p.opts);
		return this.run(adhoc, t, pre, p.opts, selector);
	}

	private run(
		p: ResolvedProp,
		t: number,
		pre: unknown,
		o: EvaluateOptions,
		selector?: SelectorInput,
	): EvalStatus {
		const seq = this.data.sequences[p.ref.seq]!;
		const state: RunState = {
			time: p.time.toSeconds(t),
			value: toExpressionValue(p.kind, pre, p.options),
			seq: p.ref.seq,
			owner: p.ref.owner,
			path: p.ref.path,
			// Selector evaluations: one seed per selector and character (AE gives every character its own random()).
			seed: selector
				? `${p.ref.owner}/${selector.seedKey ?? p.ref.path}#${selector.textIndex}`
				: `${p.ref.owner}/${p.ref.path}`,
			fd: frameDuration(seq),
			kind: p.kind,
			textIndex: selector?.textIndex ?? 1,
			textTotal: selector?.textTotal ?? 1,
			selectorValue: selector?.selectorValue ?? [100, 100, 100],
		};
		const r = runExpression(p.anim.expression!.text, state, this.host);
		if (!r.ok) return { value: pre, error: r.error };
		if (selector) return { value: r.result, error: null };
		const conv = fromExpressionValue(p.kind, r.result, pre, p.options);
		if (!conv.ok) return { value: pre, error: conv.error };
		return { value: clampOut(conv.value, o), error: null };
	}

	/** Answers prelude requests. */
	readonly host: HostHandler = (op, args) => {
		switch (op) {
			case OP.COMP: {
				const seq = this.data.sequences[String(args[0])];
				if (!seq) return null;
				const f = fps(seq);
				const [r, g, b, a] = seq.settings.backgroundColor;
				return [
					this.data.names[String(args[0])] ?? String(args[0]),
					seq.settings.width,
					seq.settings.height,
					sequenceDuration(seq) / f,
					frameDuration(seq),
					this.layers(String(args[0])).length,
					1,
					seq.settings.startTimecodeFrames / f,
					[r, g, b, a],
					seq.settings.dropFrame,
				];
			}
			case OP.COMPNAME: {
				const name = String(args[0]);
				for (const [id, n] of Object.entries(this.data.names))
					if (n === name && this.data.sequences[id]) return id;
				if (this.data.sequences[name]) return name;
				const c = compact(name);
				for (const [id, n] of Object.entries(this.data.names))
					if (compact(n) === c && this.data.sequences[id]) return id;
				return null;
			}
			case OP.LAYER: {
				const seqId = String(args[0]);
				const list = this.layers(seqId);
				const key = args[1];
				if (typeof key === 'number')
					return Number.isInteger(key) && key >= 1 && key <= list.length ? list[key - 1]! : null;
				const seq = this.data.sequences[seqId];
				if (!seq) return null;
				const name = String(key);
				const byName = list.find((id) => seq.clips[id]?.name === name);
				if (byName) return byName;
				if (seq.clips[name]) return name;
				const c = compact(name);
				return list.find((id) => compact(seq.clips[id]?.name ?? '') === c) ?? null;
			}
			case OP.LINFO: {
				const info = this.owner(String(args[0]), String(args[1]));
				if (info?.kind !== 'clip') return null;
				const { seq, clip } = info;
				const f = fps(seq);
				const F = flicksPerFrame(seq.settings.frameRate as Rational);
				const caps = kindCapabilities(clip.kind);
				const box = this.box(seq, clip);
				const startFrame = clip.speed.reverse
					? clip.start + clip.duration - 1 + clip.sourceIn / (F * clip.speed.rate)
					: clip.start - clip.sourceIn / (F * clip.speed.rate);
				return [
					clip.name,
					this.layers(String(args[0])).indexOf(clip.id) + 1,
					clip.start / f,
					(clip.start + clip.duration) / f,
					startFrame / f,
					caps?.visual ? box.width : 0,
					caps?.visual ? box.height : 0,
					!!caps?.visual,
					VISUAL_KINDS_AUDIO.has(clip.kind) || clip.kind === 'video',
					clip.enabled,
					clip.kind,
					clip.id,
				];
			}
			case OP.CHILD: {
				const info = this.owner(String(args[0]), String(args[1]));
				if (!info) return null;
				const c = this.child(info, String(args[2]), args[3]);
				if (!c) return null;
				return [
					c.node.path,
					c.node.group,
					c.node.name,
					c.node.matchName,
					c.count,
					c.index,
					c.node.enabled ?? true,
				];
			}
			case OP.PINFO: {
				const p = this.prop({ seq: String(args[0]), owner: String(args[1]), path: String(args[2]) });
				if (!p) return null;
				const kfs = p.anim.keyframes;
				return [
					p.name,
					p.kind,
					p.kind === 'vec2' ? 2 : p.kind === 'vec3' ? 3 : p.kind === 'color' ? 4 : 1,
					kfs.map((k) => p.time.toSeconds(k.time)),
					kfs.map((k) => toExpressionValue(p.kind, k.value, p.options)),
					hasActiveExpression(p.anim),
					p.propertyIndex,
					p.matchName,
					p.options ?? null,
					p.expression?.text ?? '',
				];
			}
			case OP.VALUE: {
				const ref = { seq: String(args[0]), owner: String(args[1]), path: String(args[2]) };
				const p = this.prop(ref);
				if (!p) throw new Error('Property no longer exists');
				const t = p.time.toStored(Number(args[3]));
				if (args[4]) return toExpressionValue(p.kind, this.pre(p, t), p.options);
				const st = this.evaluate(ref, t);
				// A reference cycle stops every expression on it (other errors of the read property only make it
				// show its keyframed value, as in AE).
				if (st.error && /too deeply/.test(st.error)) throw new Error(st.error.replace(/^Error: /, ''));
				return toExpressionValue(p.kind, st.value, p.options);
			}
			case OP.XFORM: {
				const info = this.owner(String(args[0]), String(args[1]));
				if (info?.kind !== 'clip') throw new Error('This property does not belong to a layer (clip)');
				return this.xform(info.seqId, info.seq, info.clip, Number(args[2]));
			}
			case OP.RECT: {
				const info = this.owner(String(args[0]), String(args[1]));
				if (info?.kind !== 'clip') throw new Error('This property does not belong to a layer (clip)');
				const b = this.box(info.seq, info.clip);
				return [0, 0, b.width, b.height];
			}
			case OP.MARKERS:
				return this.markers(String(args[0]), args[1] === null ? null : String(args[1]));
			case OP.TEXT: {
				const info = this.owner(String(args[0]), String(args[1]));
				if (info?.kind !== 'clip' || info.clip.kind !== 'text') return null;
				return this.textInfo(info.seqId, info.seq, info.clip, Number(args[2]));
			}
			case OP.SAMPLE: {
				const info = this.owner(String(args[0]), String(args[1]));
				if (info?.kind !== 'clip') throw new Error('This property does not belong to a layer (clip)');
				return this.sample(info.seq, info.clip, args.slice(2) as never);
			}
			case OP.PATH: {
				const v = this.pathQuery(
					String(args[0]),
					String(args[1]),
					String(args[2]),
					Number(args[3]),
				).vertices();
				return [v.closed, v.points, v.inTangents, v.outTangents];
			}
			case OP.PATHAT: {
				const q = this.pathQuery(String(args[0]), String(args[1]), String(args[2]), Number(args[3]));
				const r = q.at(Number(args[4]));
				return [r.point[0], r.point[1], r.tangent[0], r.tangent[1]];
			}
			case OP.SPACE:
				return this.itemSpace(String(args[0]), String(args[1]), String(args[2]), Number(args[3]));
			default:
				throw new Error(`unknown host request ${op}`);
		}
	};

	/** A vector shape clip's contents as rendered (expressions bound) and its content time at sequence seconds `s`. */
	private vectorAt(
		seqId: string,
		owner: string,
		s: number,
	): { contents: readonly ShapeItem[]; t: number; box: { width: number; height: number } } {
		const info = this.owner(seqId, owner);
		if (info?.kind !== 'clip') throw new Error('This property does not belong to a layer (clip)');
		if (!Number.isFinite(s)) throw new Error('time must be a finite number');
		const c = (this.bound?.[seqId]?.clips[info.clip.id] ?? info.clip) as { shape?: VectorShapeData };
		if (c.shape?.type !== 'vector') throw new Error(`Layer "${info.clip.name}" is not a vector shape`);
		return {
			contents: c.shape.contents,
			t: this.clipTime(info.seq, info.clip).toStored(s),
			box: this.box(info.seq, info.clip),
		};
	}

	/**
	 * The measured path behind a Path object: `i:<itemId>` = a path item's outline, `t:<trimId>:<item>` = what a Trim
	 * Paths measures (one path by id or name; empty = all its paths laid end to end).
	 */
	private pathQuery(seqId: string, owner: string, loc: string, s: number): PathQuery {
		const key = `${seqId}\u0000${owner}\u0000${loc}\u0000${s}`;
		const hit = this.pathCache.get(key);
		if (hit) return hit;
		const { contents, t } = this.vectorAt(seqId, owner, s);
		let q: PathQuery;
		if (loc.startsWith('i:')) q = new PathQuery(shapeItemPath(contents, loc.slice(2), t));
		else if (loc.startsWith('t:')) {
			const rest = loc.slice(2);
			const sep = rest.indexOf(':');
			const item = rest.slice(sep + 1);
			q = new PathQuery(trimPathAt(contents, rest.slice(0, sep), item === '' ? null : item, t).path);
		} else throw new Error(`unknown path locator ${loc}`);
		if (this.pathCache.size >= 64) this.pathCache.clear();
		this.pathCache.set(key, q);
		return q;
	}

	/**
	 * `[item space → layer, layer → item space | null]` 3×3 row-major at sequence seconds `s`: the space a shape
	 * item's own values live in (its enclosing groups' transforms) mapped to layer pixels (box origin top-left; shape
	 * contents are centred on the box).
	 */
	private itemSpace(seqId: string, owner: string, itemId: string, s: number): (number[] | null)[] {
		const { contents, t, box } = this.vectorAt(seqId, owner, s);
		const m = shapeItemMatrix(contents, itemId, t);
		if (!m) throw new Error('Shape item no longer exists');
		const g = shapeGeom.compose(shapeGeom.translate(box.width / 2, box.height / 2), m);
		const inv = shapeGeom.invert(g);
		const rows = (a: readonly number[]) => [a[0]!, a[2]!, a[4]!, a[1]!, a[3]!, a[5]!, 0, 0, 1];
		return [rows(g), inv ? rows(inv) : null];
	}

	/**
	 * `[layer → sequence, sequence → layer]` 3×3 row-major at sequence seconds `s`; for a 3D layer also
	 * `[…, world (4×4), world⁻¹ (4×4), view-projection (4×4, world → sequence px through the active camera)]`.
	 */
	xform(seqId: string, seq: Sequence, clip: Clip, s: number): number[][] {
		const c = (this.bound?.[seqId]?.clips[clip.id] ?? clip) as Record<string, unknown>;
		const t = this.clipTime(seq, clip).toStored(s);
		const td = c.threeD as Layer3D | undefined;
		const rclip = {
			transform: c.transform ?? null,
			opacity: (c.opacity as Animatable<number>) ?? { value: 100, keyframes: [] },
			effects: (c.effects as EffectInstance[]) ?? [],
			intrinsicBox: this.box(seq, clip),
			...(td?.enabled && clip.kind !== 'adjustment' ? { threeD: td } : {}),
		} as unknown as RenderVisualClip;
		const props = resolveLayerProps(rclip, t);
		if (!rclip.threeD) {
			const m = layerMapOf(props);
			const inv = invertMat3(m) ?? [0, 0, 0, 0, 0, 0, 0, 0, 1];
			return [[...m], [...inv]];
		}
		const cam = this.activeCamera(seqId, seq, s);
		const world = layerWorldMatrix(rclip, t, { cameraEye: cam.eye });
		const proj = cameraProjection(cam, seq.settings.width, seq.settings.height);
		const h = planeHomography(cam, seq.settings.width, seq.settings.height, world) ?? [
			0, 0, 0, 0, 0, 0, 0, 0, 1,
		];
		const hinv = invertMat3(h) ?? [0, 0, 0, 0, 0, 0, 0, 0, 1];
		return [[...h], [...hinv], [...world], [...(mat4Invert(world) ?? MAT4_IDENTITY)], [...proj]];
	}

	/** The sequence's active camera at sequence seconds `s` (the topmost camera clip that is on). */
	private activeCamera(seqId: string, seq: Sequence, s: number): CameraState {
		const F = flicksPerFrame(seq.settings.frameRate as Rational);
		const frame = Math.floor((s * FLICKS_PER_SECOND) / F + 1e-6);
		const hidden = new Set(seq.videoTracks.filter((tr) => tr.output === false).map((tr) => tr.id));
		const index = new Map(seq.videoTracks.map((tr, i) => [tr.id, i]));
		let best: RenderCameraClip | null = null;
		for (const raw of Object.values(seq.clips)) {
			if (raw.kind !== 'camera' || !raw.enabled || hidden.has(raw.trackId)) continue;
			if (frame < raw.start || frame >= raw.start + raw.duration) continue;
			const cc = (this.bound?.[seqId]?.clips[raw.id] ?? raw) as CameraClip;
			const r: RenderCameraClip = {
				clipId: cc.id,
				name: cc.name,
				trackIndex: index.get(cc.trackId) ?? 0,
				start: cc.start,
				duration: cc.duration,
				sourceIn: cc.sourceIn,
				speed: cc.speed,
				camera: cc.camera,
			};
			if (!best || r.trackIndex > best.trackIndex) best = r;
		}
		return best
			? cameraStateOf(best, frame, seq.settings.frameRate as Rational, seq.settings.width)
			: defaultCamera(seq.settings.width, seq.settings.height);
	}

	private markers(seqId: string, owner: string | null): unknown[] {
		const seq = this.data.sequences[seqId];
		if (!seq) return [];
		const f = fps(seq);
		const row = (
			time: number,
			durSeconds: number,
			m: { name: string; comment: string; type: string; url?: string; color: string },
		) => [
			time,
			durSeconds,
			m.comment || m.name,
			m.name,
			m.type === 'chapter' ? m.name : '',
			m.url ?? '',
			m.type,
			m.color,
		];
		if (owner === null)
			return [...seq.markers]
				.sort((a, b) => a.frame - b.frame)
				.map((m) => row(m.frame / f, m.duration / f, m));
		const info = this.owner(seqId, owner);
		if (info?.kind !== 'clip') throw new Error('This property does not belong to a layer (clip)');
		const map = this.clipTime(seq, info.clip);
		return [...info.clip.markers]
			.sort((a, b) => a.flicks - b.flicks)
			.map((m) => row(map.toSeconds(m.flicks), m.duration / f, m));
	}

	private textInfo(seqId: string, seq: Sequence, clip: Clip, s: number): unknown {
		const content = (clip as { content: TextContent }).content;
		const ref = { seq: seqId, owner: clip.id, path: 'text.content' };
		const t = this.clipTime(seq, clip).toStored(s);
		const text = String(this.evaluate(ref, t).value ?? content.text);
		const style = (st: Partial<TextContent['style']>) => {
			const o: Record<string, unknown> = {};
			if (st.fontId !== undefined) o.font = st.fontId;
			if (st.sizePx !== undefined) o.fontSize = st.sizePx;
			if (st.fill !== undefined) o.fillColor = st.fill;
			if (st.strokes !== undefined) {
				o.applyStroke = st.strokes.length > 0;
				o.strokeColor = st.strokes[0]?.color ?? [0, 0, 0, 1];
				o.strokeWidth = st.strokes[0]?.widthPx ?? 0;
			}
			if (st.trackingEm !== undefined) o.tracking = st.trackingEm * 1000;
			if (st.lineHeight !== undefined && st.sizePx !== undefined) o.leading = st.lineHeight * st.sizePx;
			if (st.weight !== undefined) o.fontWeight = st.weight;
			if (st.italic !== undefined) o.isFauxItalic = st.italic;
			if (st.allCaps !== undefined) o.isAllCaps = st.allCaps;
			if (st.align !== undefined) o.justification = st.align;
			return o;
		};
		return {
			text,
			style: style(content.style),
			runs: (content.runs ?? []).map((r) => ({ from: r.from, to: r.to, style: style(r.style) })),
		};
	}

	/**
	 * `sampleImage` on a solid clip: the straight RGBA average of its pixels in the box (the solid's colour inside the
	 * layer, transparent outside, area-weighted). Other clip kinds need rendered pixels, which the synchronous
	 * evaluator does not have: an error (the property keeps its keyframed value) instead of a guess.
	 */
	private sample(seq: Sequence, clip: Clip, a: [number, number, number, number, boolean, number]): number[] {
		const synth = (clip as { syntheticId?: string }).syntheticId;
		if (clip.kind !== 'solid' || !synth)
			throw new Error(
				`sampleImage is only available on solid clips (layer "${clip.name}" is a ${clip.kind} clip)`,
			);
		const color = this.data.solids[synth];
		if (!color) throw new Error('sampleImage: the solid has no colour');
		const box = this.box(seq, clip);
		const [x, y, rx0, ry0] = a;
		const rx = Math.abs(rx0);
		const ry = Math.abs(ry0);
		const ov = (c: number, r: number, size: number) =>
			Math.max(0, Math.min(c + r, size) - Math.max(c - r, 0));
		const area = 4 * rx * ry;
		const cover =
			area > 0
				? (ov(x, rx, box.width) * ov(y, ry, box.height)) / area
				: x >= 0 && y >= 0 && x < box.width && y < box.height
					? 1
					: 0;
		if (cover <= 0 || color[3] <= 0) return [0, 0, 0, 0];
		return [color[0], color[1], color[2], color[3] * cover];
	}

	/** Every property of an owner (for agents and the pick-whip). */
	listProps(seqId: string, owner: string): ResolvedProp[] {
		const info = this.owner(seqId, owner);
		if (!info) return [];
		const out: ResolvedProp[] = [];
		const walk = (group: string) => {
			for (const n of this.children(info, group)) {
				if (n.group) walk(n.path);
				else if (n.matchName !== PATH_MATCH) {
					const p = this.prop({ seq: seqId, owner, path: n.path });
					if (p) out.push(p);
				}
			}
		};
		walk('');
		return out;
	}
}

export type SelectorInput = {
	textIndex: number;
	textTotal: number;
	selectorValue: [number, number, number];
	/** Seed name of the selector (e.g. the animator id); default the property path. */
	seedKey?: string;
};

function clampOut(v: unknown, o: EvaluateOptions): unknown {
	const c = o.clamp;
	if (!c) return v;
	const f = (x: number) =>
		Math.min(c.max ?? Number.POSITIVE_INFINITY, Math.max(c.min ?? Number.NEGATIVE_INFINITY, x));
	if (typeof v === 'number') return f(v);
	if (Array.isArray(v)) return v.map((x) => (typeof x === 'number' ? f(x) : x));
	return v;
}

type LeafFn = (path: string, name: string, ...aliases: string[]) => Node;

/** Lower-camel alias of a display name ("Rectangle Path 1" → "rectanglePath1"). */
const camel = (s: string) =>
	s
		.replace(/[^A-Za-z0-9]+(.)?/g, (_, c: string | undefined) => (c ? c.toUpperCase() : ''))
		.replace(/^./, (c) => c.toLowerCase());

/** After Effects match names of shape items (`ADBE Vector …`), for `matchName` and as lookup aliases. */
const MATCH: Record<string, string> = {
	group: 'ADBE Vector Group',
	rect: 'ADBE Vector Shape - Rect',
	ellipse: 'ADBE Vector Shape - Ellipse',
	polystar: 'ADBE Vector Shape - Star',
	path: 'ADBE Vector Shape - Group',
	fill: 'ADBE Vector Graphic - Fill',
	stroke: 'ADBE Vector Graphic - Stroke',
	gradientFill: 'ADBE Vector Graphic - G-Fill',
	gradientStroke: 'ADBE Vector Graphic - G-Stroke',
	trim: 'ADBE Vector Filter - Trim',
	repeater: 'ADBE Vector Filter - Repeater',
	offsetPaths: 'ADBE Vector Filter - Offset',
	roundCorners: 'ADBE Vector Filter - RC',
	zigZag: 'ADBE Vector Filter - Zigzag',
	twist: 'ADBE Vector Filter - Twist',
	wiggle: 'ADBE Vector Filter - Roughen',
	puckerBloat: 'ADBE Vector Filter - PB',
	mergePaths: 'ADBE Vector Filter - Merge',
};

/** Match name of a path item's Path property (the prelude builds a Path object for it, not a value property). */
const PATH_MATCH = 'ADBE Vector Shape';

/** Sub-groups of an item's fields (the first path segment of nested fields). */
const SUBGROUP_NAMES: Record<string, string> = {
	transform: 'Transform',
	dashes: 'Dashes',
	taper: 'Taper',
	wave: 'Wave',
};

function vectorShapeChildren(
	clip: Pick<Clip, 'kind'>,
	contents: ShapeItem[],
	group: string,
	leaf: LeafFn,
): Node[] {
	const itemNode = (it: ShapeItem): Node => ({
		path: `shape.items.${it.id}`,
		group: true,
		name: it.name,
		matchName: MATCH[it.type] ?? it.type,
		aliases: [it.id, camel(it.name)],
		enabled: it.enabled !== false,
	});
	if (group === 'shape') return contents.map(itemNode);
	const rest = group.slice('shape.items.'.length).split('.');
	const id = rest[0]!;
	const found = findItem(contents, id);
	if (!found) return [];
	const it = found.item;
	const sub = rest.slice(1);
	if (sub[0] === 'contents' && it.type === 'group') return it.contents.map(itemNode);
	const prefix = `shape.items.${id}.`;
	const specs = shapeItemSpecs(clip, id).filter((s) => s.animatable !== 'no' && s.kind !== 'json');
	const out: Node[] = [];
	const seen = new Set<string>();
	for (const s of specs) {
		const field = s.key.slice(prefix.length).split('.');
		const within = field.slice(0, sub.length).join('.') === sub.join('.');
		if (!within) continue;
		const restField = field.slice(sub.length);
		if (restField.length === 1) {
			const name = restField[0]!;
			out.push(leaf(s.key, s.label, name, camel(s.label), ...(name === 'anchor' ? ['anchorPoint'] : [])));
		} else if (restField.length > 1 && !seen.has(restField[0]!)) {
			seen.add(restField[0]!);
			const k = restField[0]!;
			const label = SUBGROUP_NAMES[k] ?? (/^\d+$/.test(k) ? `Dash ${Number(k) + 1}` : k);
			out.push({ path: `${group}.${k}`, group: true, name: label, matchName: k, aliases: [k, camel(label)] });
		}
	}
	// AE's "Path" property of path items; rectangles, ellipses and polystars expose their outline (path methods).
	if (sub.length === 0 && isShapeOutlineItem(it))
		out.push({ path: `${prefix}path`, group: false, name: 'Path', matchName: PATH_MATCH, aliases: ['path'] });
	if (sub.length === 0 && it.type === 'group')
		out.unshift({
			path: `${group}.contents`,
			group: true,
			name: 'Contents',
			matchName: 'ADBE Vectors Group',
			aliases: ['content', 'contents'],
		});
	return out;
}

/** The group path a vector item leaf belongs to (its key without the last segment). */
function vectorLeafGroup(path: string): string {
	return path.slice(0, path.lastIndexOf('.'));
}
