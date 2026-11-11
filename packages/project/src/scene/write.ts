// `jasper export-scene` (docs/wp-notes/scene-file.md § Export): a sequence → a scene file object, layers bottom to
// top (track, then start), default values left out, ids from clip names (made unique; a renamed duplicate is pinned
// with `clip:`). Applying the result to the same project plans nothing. Pure.
import { formatCubicBezier } from '../agent/keyframe-eases.ts';
import type { Registries } from '../commands/types.ts';
import { CSS_EASE_KEYWORDS } from '../ease/names.ts';
import { matchEasePreset } from '../ease/presets.ts';
import type { RGBA } from '../schema/common.ts';
import type { ProjectDocument } from '../schema/document.ts';
import type { Sequence } from '../schema/sequence.ts';
import { latestTextAnimationSpec, scaleAnimationFrames } from '../text-animations.ts';
import type { Rational } from '../time.ts';
import { SCENE_FORMAT_VERSION, type SceneProp } from './format.ts';
import {
	colorEqual,
	nearlyEqual,
	type ResolvedSceneLayer,
	type SceneAnimatorR,
	type SceneAnimR,
	type SceneEaseR,
	type SceneValueR,
} from './model.ts';
import { defaultAnchor, readSceneLayer } from './read.ts';
import { SCENE_PROP_KIND } from './resolve.ts';
import { sceneSequenceName } from './sequence.ts';

const r4 = (n: number) => {
	const v = Math.round(n * 1e4) / 1e4;
	return Object.is(v, -0) ? 0 : v;
};
const round = (v: unknown): unknown => (typeof v === 'number' ? r4(v) : Array.isArray(v) ? v.map(round) : v);

/** RGBA → "#RRGGBB" (or "#RRGGBBAA" when not opaque). */
export function sceneHex(c: readonly number[]): string {
	const b = (x: number) =>
		Math.round(Math.min(1, Math.max(0, x)) * 255)
			.toString(16)
			.padStart(2, '0')
			.toUpperCase();
	return `#${b(c[0]!)}${b(c[1]!)}${b(c[2]!)}${(c[3] ?? 1) < 1 ? b(c[3]!) : ''}`;
}

const KEYWORD_OF = Object.fromEntries(Object.entries(CSS_EASE_KEYWORDS).map(([k, v]) => [v, k]));

/** The name of an ease as a file writes it: a CSS keyword, a preset id or cubic-bezier(…). */
export function sceneEaseName(e: SceneEaseR): string | undefined {
	if (e.kind === 'linear') return undefined;
	if (e.kind === 'hold') return 'hold';
	const curve = { kind: 'cubic' as const, x1: e.x1, y1: e.y1, x2: e.x2, y2: e.y2 };
	const preset = matchEasePreset(curve, undefined, 1e-3);
	if (preset) return KEYWORD_OF[preset.id] ?? preset.id;
	return formatCubicBezier(curve);
}

export type ExportOptions = {
	registries: Registries;
	/** How the file names a media asset (a path relative to the file, or its media id). */
	srcOf(mediaId: string): string;
};

export type ExportedScene = {
	file: Record<string, unknown>;
	/** Clips left out (kinds a scene cannot describe) and aspects not written. */
	warnings: string[];
};

const seconds = (frames: number, rate: Rational) => r4((frames * rate.den) / rate.num);

function value(v: SceneValueR, color: boolean): unknown {
	if (color && Array.isArray(v) && v.length >= 3) return sceneHex(v as number[]);
	return round(v);
}

function keysOut(a: Extract<SceneAnimR, { kind: 'keys' }>, rate: Rational, color: boolean): unknown[] {
	return a.keys.map((k, i) => {
		const last = i === a.keys.length - 1;
		const ease = last ? undefined : sceneEaseName(k.ease);
		return {
			t: seconds(k.frame, rate),
			value: value(k.value, color),
			...(ease ? { ease } : {}),
			...(!last && k.path === 'auto' ? { path: 'auto' } : {}),
		};
	});
}

function animatorOut(a: SceneAnimatorR, rate: Rational): unknown {
	const spec = latestTextAnimationSpec(a.preset);
	const params: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(a.params))
		if (!spec || !nearlyEqual(v, spec.defaults[k])) params[k] = v;
	const dflt = spec ? scaleAnimationFrames(spec.defaultDurationFrames, rate) : null;
	if (dflt === a.durationFrames && !Object.keys(params).length) return a.preset;
	return {
		preset: a.preset,
		...(dflt !== a.durationFrames ? { duration: seconds(a.durationFrames, rate) } : {}),
		...(Object.keys(params).length ? { params } : {}),
	};
}

/** One canonical layer → its file form. */
function layerOut(
	l: ResolvedSceneLayer,
	ctx: {
		doc: ProjectDocument;
		seq: Sequence;
		anchor: number[] | null;
		index: number;
		registries: Registries;
		srcOf: ExportOptions['srcOf'];
	},
): Record<string, unknown> {
	const rate = ctx.seq.settings.frameRate as Rational;
	const out: Record<string, unknown> = { id: l.id };
	if (l.name !== l.id) out.name = l.name;
	if (l.clipPin) out.clip = l.clipPin;
	switch (l.kind) {
		case 'text':
			out.type = 'text';
			break;
		case 'image': {
			const m = ctx.doc.media[l.mediaId!];
			out.type = m?.vector?.format === 'svg' ? 'svg' : 'image';
			out.src = ctx.srcOf(l.mediaId!);
			break;
		}
		case 'shape':
			out.type = 'shape';
			out.shape = l.shape!.type;
			break;
		case 'composition':
			out.type = 'composition';
			out.bundle = ctx.srcOf(l.composition!.mediaId);
			out.composition = l.composition!.id;
			if (l.composition!.props && Object.keys(l.composition!.props).length) out.props = l.composition!.props;
			break;
	}
	if (l.start !== 0) out.start = seconds(l.start, rate);
	out.duration = seconds(l.duration, rate);
	if (l.track !== ctx.index + 1) out.track = l.track;
	const keyframes: Record<string, unknown> = {};
	const centre = [ctx.seq.settings.width / 2, ctx.seq.settings.height / 2];
	const DEFAULT: Partial<Record<SceneProp, unknown>> = {
		position: centre,
		scale: 100,
		rotation: 0,
		opacity: 100,
		radius: 0,
		...(ctx.anchor ? { anchor: ctx.anchor } : {}),
	};
	for (const [p, a] of Object.entries(l.props) as [SceneProp, SceneAnimR][]) {
		const color = SCENE_PROP_KIND[p] === 'color';
		if (a.kind === 'keys') keyframes[p] = keysOut(a, rate, color);
		else if (p === 'fill' && a.value === null) out.fill = null;
		else if (p === 'size' || p === 'fill' || DEFAULT[p] === undefined || !nearlyEqual(a.value, DEFAULT[p]))
			out[p] = value(a.value, color);
	}
	if (l.blend && l.blend !== 'normal') out.blend = l.blend;
	if (l.text) {
		const t = l.text;
		out.text = t.text;
		if (t.font !== undefined) out.font = t.font;
		if (t.sizePx !== undefined) out.size = r4(t.sizePx);
		if (t.weight !== undefined && t.weight !== 400) out.weight = t.weight;
		if (t.italic) out.italic = true;
		if (t.fill && !colorEqual(t.fill, [1, 1, 1, 1])) out.color = sceneHex(t.fill);
		if (t.align && t.align !== 'center') out.align = t.align;
		if (t.lineHeight !== undefined && !nearlyEqual(t.lineHeight, 1.2)) out.lineHeight = r4(t.lineHeight);
		if (t.trackingEm) out.tracking = r4(t.trackingEm);
		if (t.allCaps) out.allCaps = true;
		if (t.stroke)
			out.stroke = {
				color: sceneHex(t.stroke.color),
				width: r4(t.stroke.width),
				position: t.stroke.position,
			};
		if (t.shadow)
			out.shadow = {
				color: sceneHex(t.shadow.color),
				angle: r4(t.shadow.angleDeg),
				distance: r4(t.shadow.distancePx),
				blur: r4(t.shadow.blurPx),
				...(t.shadow.spreadPx ? { spread: r4(t.shadow.spreadPx) } : {}),
			};
		if (t.background)
			out.background = {
				color: sceneHex(t.background.color),
				padding: r4(t.background.paddingPx),
				radius: r4(t.background.radiusPx),
			};
		if (t.box?.mode === 'box') out.box = [r4(t.box.width), r4(t.box.height)];
		else if (t.box?.mode === 'paragraph') out.width = r4(t.box.width);
		if (t.animIn || t.animOut)
			out.animation = {
				...(t.animIn ? { in: animatorOut(t.animIn, rate) } : {}),
				...(t.animOut ? { out: animatorOut(t.animOut, rate) } : {}),
			};
	}
	if (l.shape?.stroke)
		out.stroke = {
			color: sceneHex(l.shape.stroke.color),
			width: r4(l.shape.stroke.width),
			position: l.shape.stroke.position,
		};
	if (Object.keys(keyframes).length) out.keyframes = keyframes;
	if (l.effects?.length)
		out.effects = l.effects.map((fx) => {
			const spec = ctx.registries.effects.get(fx.effectId)!;
			const params: Record<string, unknown> = {};
			const keys: Record<string, unknown> = {};
			for (const p of spec.params) {
				const a = fx.params[p.name];
				if (!a) continue;
				const color = p.type === 'color';
				if (a.kind === 'keys') keys[p.name] = keysOut(a, rate, color);
				else if (!nearlyEqual(a.value, p.default as unknown)) params[p.name] = value(a.value, color);
			}
			return {
				effect: fx.effectId,
				...(fx.enabled ? {} : { enabled: false }),
				...(Object.keys(params).length ? { params } : {}),
				...(Object.keys(keys).length ? { keyframes: keys } : {}),
			};
		});
	if (l.masks?.length)
		out.masks = l.masks.map((m) => ({
			path: {
				...(m.closed ? {} : { closed: false }),
				points: m.vertices.map((v) =>
					v.in[0] === 0 && v.in[1] === 0 && v.out[0] === 0 && v.out[1] === 0
						? round(v.p)
						: { p: round(v.p), in: round(v.in), out: round(v.out) },
				),
			},
			...(m.mode !== 'add' ? { mode: m.mode } : {}),
			...(m.inverted ? { inverted: true } : {}),
			...(m.feather !== 10 ? { feather: r4(m.feather) } : {}),
			...(m.opacity !== 100 ? { opacity: r4(m.opacity) } : {}),
			...(m.expansion !== 0 ? { expansion: r4(m.expansion) } : {}),
			...(m.falloff !== 'smooth' ? { falloff: m.falloff } : {}),
		}));
	return out;
}

/** A sequence as a scene file object (stable order: layers by track then start). */
export function exportScene(doc: ProjectDocument, sequenceId: string, opts: ExportOptions): ExportedScene {
	const seq = doc.sequences[sequenceId];
	if (!seq) throw new Error(`No sequence ${sequenceId}`);
	const warnings: string[] = [];
	const rate = seq.settings.frameRate as Rational;
	const read: { layer: ResolvedSceneLayer; clipId: string; anchor: number[] | null }[] = [];
	const trackOf = new Map(seq.videoTracks.map((t, i) => [t.id, i]));
	const clips = Object.values(seq.clips).sort(
		(a, b) =>
			(trackOf.get(a.trackId) ?? 1e9) - (trackOf.get(b.trackId) ?? 1e9) ||
			a.start - b.start ||
			(a.id < b.id ? -1 : 1),
	);
	for (const clip of clips) {
		if (!trackOf.has(clip.trackId)) continue;
		const r = readSceneLayer(doc, seq, clip, opts.registries);
		if (!r) {
			warnings.push(`clip "${clip.name}" (${clip.id}, ${clip.kind}) is not a scene layer kind: left out`);
			continue;
		}
		for (const o of r.omitted)
			warnings.push(`clip "${clip.name}" (${clip.id}): ${o} not written (the scene leaves it as it is)`);
		read.push({ layer: r.layer, clipId: clip.id, anchor: defaultAnchor(doc, seq, clip) });
	}
	// Ids: the clip name; a repeated or empty name gets a suffix and a `clip:` pin (names match clips on apply).
	const count = new Map<string, number>();
	for (const r of read) count.set(r.layer.name, (count.get(r.layer.name) ?? 0) + 1);
	const used = new Set<string>();
	for (const r of read) {
		const base = r.layer.name.trim() || 'layer';
		let id = base.slice(0, 200);
		for (let n = 2; used.has(id); n++) id = `${base.slice(0, 190)}-${n}`;
		used.add(id);
		r.layer.id = id;
		if ((count.get(r.layer.name) ?? 0) > 1 || id !== r.layer.name) r.layer.clipPin = r.clipId;
	}
	const sequence: Record<string, unknown> = {
		name: sceneSequenceName(doc, sequenceId) ?? sequenceId,
		size: [seq.settings.width, seq.settings.height],
		fps: rate.den === 1 ? rate.num : `${rate.num}/${rate.den}`,
	};
	const bg = seq.settings.backgroundColor as RGBA;
	if (bg && !colorEqual(bg, [0, 0, 0, 1])) sequence.background = sceneHex(bg);
	return {
		file: {
			scene: SCENE_FORMAT_VERSION,
			sequence,
			layers: read.map((r, i) =>
				layerOut(r.layer, {
					doc,
					seq,
					anchor: r.anchor,
					index: i,
					registries: opts.registries,
					srcOf: opts.srcOf,
				}),
			),
		},
		warnings,
	};
}
