// Scene file → canonical layers (docs/wp-notes/scene-file.md § Canonical form): times in frames at the scene's rate,
// colours as RGBA, eases as cubic handles, text animation presets and effects with their params checked against the
// catalogues the commands use (`TEXT_ANIMATION_SPECS`, the effect registry, the ease presets). Every problem comes
// back with its path in the file. Pure: media lookups are the caller's (`mediaFor`).

import type { Registries } from '../commands/types.ts';
import type { CubicEase } from '../ease/curve.ts';
import { parseEaseName } from '../ease/names.ts';
import type { ParamSpec } from '../registry/effects.ts';
import { PROPERTY_SPECS } from '../registry/properties.ts';
import type { RGBA, Vec2 } from '../schema/common.ts';
import type { ProjectDocument } from '../schema/document.ts';
import { latestTextAnimationSpec, scaleAnimationFrames } from '../text-animations.ts';
import type { Rational } from '../time.ts';
import {
	SCENE_COMMON_PROPS,
	SCENE_SHAPE_PROPS,
	type SceneAnimator,
	type SceneColor,
	type SceneFile,
	type SceneIssue,
	type SceneKey,
	type SceneLayer,
	type SceneMask,
	type ScenePath,
	type SceneProp,
	type SceneTime,
} from './format.ts';
import type {
	ResolvedScene,
	ResolvedSceneLayer,
	SceneAnimatorR,
	SceneAnimR,
	SceneEaseR,
	SceneEffectR,
	SceneKeyR,
	SceneMaskR,
	SceneMaskVertexR,
	SceneStrokeR,
	SceneTextR,
	SceneValueR,
} from './model.ts';
import { findSceneSequence } from './sequence.ts';

export type ResolveContext = {
	doc: ProjectDocument;
	registries: Registries;
	/** The media id of an image / svg `src` or a composition `bundle` as written in the file, or null. */
	mediaFor(src: string, kind: 'image' | 'bundle'): string | null;
};

/** Default frame size and rate of a sequence the scene creates without saying. */
export const SCENE_DEFAULT_SIZE: readonly [number, number] = [1920, 1080];
export const SCENE_DEFAULT_RATE: Rational = { num: 30, den: 1 };

const NTSC: Record<string, Rational> = {
	'23.976': { num: 24000, den: 1001 },
	'29.97': { num: 30000, den: 1001 },
	'47.952': { num: 48000, den: 1001 },
	'59.94': { num: 60000, den: 1001 },
	'119.88': { num: 120000, den: 1001 },
};

/** `30` → 30/1, `29.97` → 30000/1001, `"30000/1001"` → 30000/1001; null when it is no frame rate. */
export function parseSceneRate(v: number | string): Rational | null {
	if (typeof v === 'string') {
		const [n, d] = v.split('/').map(Number) as [number, number];
		return n > 0 && d > 0 && Number.isSafeInteger(n) && Number.isSafeInteger(d) && n / d <= 1000
			? { num: n, den: d }
			: null;
	}
	if (Number.isInteger(v)) return { num: v, den: 1 };
	const ntsc = NTSC[String(Math.round(v * 1000) / 1000)];
	if (ntsc) return ntsc;
	const milli = Math.round(v * 1000);
	return Math.abs(milli / 1000 - v) < 1e-9 ? { num: milli, den: 1000 } : null;
}

/** "#RRGGBB(AA)" / "#RGB" / [r, g, b(, a)] → RGBA 0…1. */
export function parseSceneColor(c: SceneColor): RGBA {
	if (Array.isArray(c)) return [c[0], c[1], c[2], c[3] ?? 1];
	let h = c.slice(1);
	if (h.length === 3) h = [...h].map((x) => x + x).join('');
	const n = (i: number) => Number.parseInt(h.slice(i, i + 2), 16) / 255;
	return [n(0), n(2), n(4), h.length === 8 ? n(6) : 1];
}

const PROP_KEYS: Record<SceneProp, string> = {
	position: 'transform.position',
	anchor: 'transform.anchor',
	scale: 'transform.scale',
	rotation: 'transform.rotation',
	opacity: 'opacity',
	size: 'shape.size',
	radius: 'shape.cornerRadius',
	fill: 'shape.fill',
};
/** Where a scene property lives in a clip (`param.set` target after `["clip", id]`). */
export const scenePropPath = (p: SceneProp): string[] => PROP_KEYS[p].split('.');
export const SCENE_PROP_KIND: Record<SceneProp, 'vec2' | 'number' | 'color'> = {
	position: 'vec2',
	anchor: 'vec2',
	scale: 'number',
	rotation: 'number',
	opacity: 'number',
	size: 'vec2',
	radius: 'number',
	fill: 'color',
};

class Issues {
	readonly list: SceneIssue[] = [];
	add(path: ScenePath, message: string): void {
		this.list.push({ path, message });
	}
}

/** A time → frames at `rate` (null after reporting a problem). */
function frames(t: SceneTime, rate: Rational, path: ScenePath, out: Issues): number | null {
	const fps = rate.num / rate.den;
	if (typeof t === 'number') return Math.round(t * fps);
	const m = /^\s*(\d+(?:\.\d+)?)\s*(s|ms|f)\s*$/.exec(t)!;
	const n = Number(m[1]);
	if (m[2] === 'f') {
		if (!Number.isInteger(n)) {
			out.add(path, `"${t}": frames are whole numbers`);
			return null;
		}
		return n;
	}
	return Math.round((m[2] === 'ms' ? n / 1000 : n) * fps);
}

/** An ease name → canonical ease; multi-point presets (bounce, elastic…) are refused: a key holds one cubic. */
function ease(name: string | undefined, path: ScenePath, out: Issues): SceneEaseR {
	if (name === undefined) return { kind: 'linear' };
	const t = name.trim().toLowerCase();
	if (t === 'hold') return { kind: 'hold' };
	if (t === 'linear') return { kind: 'linear' };
	const r = parseEaseName(name);
	if (!r.ok) {
		out.add(
			path,
			`unknown ease "${name}"${r.message.startsWith('Invalid') ? ` (${r.message})` : ''}${r.near.length ? `; did you mean ${r.near.slice(0, 5).join(', ')}?` : ''}`,
		);
		return { kind: 'linear' };
	}
	if (r.curve.kind !== 'cubic') {
		out.add(
			path,
			`"${name}" is a multi-point curve (${r.curve.points.length} points); a key takes a cubic ease (basic.*, penner.*, material.*, "cubic-bezier(…)")`,
		);
		return { kind: 'linear' };
	}
	return cubicEase(r.curve);
}

/** A cubic whose handles lie on the diagonal is linear. */
export function cubicEase(c: Pick<CubicEase, 'x1' | 'y1' | 'x2' | 'y2'>): SceneEaseR {
	if (Math.abs(c.x1 - c.y1) < 1e-9 && Math.abs(c.x2 - c.y2) < 1e-9) return { kind: 'linear' };
	return { kind: 'cubic', x1: c.x1, y1: c.y1, x2: c.x2, y2: c.y2 };
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isVec2 = (v: unknown): v is Vec2 => Array.isArray(v) && v.length === 2 && v.every(isNum);

/** Range check of a value against a property / param range. */
function inRange(v: number, range: { min?: number; max?: number } | undefined): boolean {
	return (range?.min === undefined || v >= range.min) && (range?.max === undefined || v <= range.max);
}

function propValue(prop: SceneProp, v: unknown, path: ScenePath, out: Issues): SceneValueR | undefined {
	const kind = SCENE_PROP_KIND[prop];
	const range = PROPERTY_SPECS.find((s) => s.key === PROP_KEYS[prop])?.range;
	if (kind === 'color') {
		if (v === null && prop === 'fill') return null;
		const c = colorValue(v);
		if (!c) out.add(path, 'a colour is "#RRGGBB", "#RRGGBBAA" or [r, g, b, a] in 0…1');
		return c ?? undefined;
	}
	if (kind === 'vec2') {
		if (!isVec2(v)) {
			out.add(path, 'expected [x, y]');
			return undefined;
		}
		if (prop === 'size' && (v[0] < 0 || v[1] < 0)) out.add(path, 'a size is not negative');
		return [v[0], v[1]];
	}
	if (!isNum(v)) {
		out.add(path, 'expected a number');
		return undefined;
	}
	if (!inRange(v, range)) out.add(path, `${v} is outside ${range?.min ?? '−∞'}…${range?.max ?? '∞'}`);
	return v;
}

function colorValue(v: unknown): RGBA | null {
	if (typeof v === 'string' && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(v))
		return parseSceneColor(v);
	if (Array.isArray(v) && (v.length === 3 || v.length === 4) && v.every((x) => isNum(x) && x >= 0 && x <= 1))
		return parseSceneColor(v as SceneColor);
	return null;
}

/** Keys → canonical keys (frames from the layer start, strictly increasing). */
function keys(
	list: readonly SceneKey[],
	rate: Rational,
	path: ScenePath,
	out: Issues,
	value: (v: unknown, p: ScenePath) => SceneValueR | undefined,
	opts: { hold?: boolean; point?: boolean },
): SceneKeyR[] {
	const res: SceneKeyR[] = [];
	list.forEach((k, i) => {
		const p = [...path, i];
		const f = frames(k.t, rate, [...p, 't'], out);
		const v = value(k.value, [...p, 'value']);
		const e = opts.hold ? ({ kind: 'hold' } as const) : ease(k.ease, [...p, 'ease'], out);
		if (k.path !== undefined && !opts.point) out.add([...p, 'path'], 'path is for position keys');
		if (f === null || v === undefined) return;
		const prev = res.at(-1);
		if (prev && f <= prev.frame)
			out.add([...p, 't'], f === prev.frame ? `two keys at frame ${f}` : 'keys go in time order');
		res.push({ frame: f, value: v, ease: e, ...(opts.point ? { path: k.path ?? 'linear' } : {}) });
	});
	return res;
}

const CONTINUOUS_PARAM_TYPES = new Set(['number', 'vec2', 'vec3', 'color', 'mesh']);

function paramValue(spec: ParamSpec, v: unknown, path: ScenePath, out: Issues): SceneValueR | undefined {
	switch (spec.type) {
		case 'number':
			if (!isNum(v)) return void out.add(path, 'expected a number');
			if (!inRange(v, spec.range))
				out.add(path, `${v} is outside ${spec.range?.min ?? '−∞'}…${spec.range?.max ?? '∞'}`);
			return v;
		case 'boolean':
			if (typeof v !== 'boolean') return void out.add(path, 'expected true or false');
			return v;
		case 'enum':
			if (typeof v !== 'string' || !(spec.options ?? []).includes(v))
				return void out.add(path, `expected one of ${(spec.options ?? []).join(', ')}`);
			return v;
		case 'string':
			if (typeof v !== 'string') return void out.add(path, 'expected a string');
			return v;
		case 'vec2':
			if (!isVec2(v)) return void out.add(path, 'expected [x, y]');
			return [v[0], v[1]];
		case 'vec3':
			if (!(Array.isArray(v) && v.length === 3 && v.every(isNum)))
				return void out.add(path, 'expected [x, y, z]');
			return [...v];
		case 'color': {
			const c = colorValue(v);
			if (!c) return void out.add(path, 'a colour is "#RRGGBB", "#RRGGBBAA" or [r, g, b, a] in 0…1');
			return c;
		}
		default:
			// media / curve / mesh: JSON values the effect validates
			if (v === undefined || typeof v === 'function') return void out.add(path, 'expected a value');
			return JSON.parse(JSON.stringify(v)) as SceneValueR;
	}
}

function effects(
	layer: SceneLayer,
	li: number,
	rate: Rational,
	ctx: ResolveContext,
	out: Issues,
): SceneEffectR[] | undefined {
	if (!layer.effects) return undefined;
	const res: SceneEffectR[] = [];
	layer.effects.forEach((fx, i) => {
		const base: ScenePath = ['layers', li, 'effects', i];
		const spec = ctx.registries.effects.get(fx.effect);
		if (!spec || spec.internal || spec.appliesTo !== 'video') {
			const needle = fx.effect.toLowerCase().replace(/^jasper\./, '');
			const near = ctx.registries.effects
				.list()
				.filter(
					(s) =>
						!s.internal &&
						s.appliesTo === 'video' &&
						(s.id.includes(needle) || s.label.toLowerCase().includes(needle)),
				)
				.slice(0, 5)
				.map((s) => s.id);
			out.add(
				[...base, 'effect'],
				`unknown video effect "${fx.effect}"${near.length ? `; did you mean ${near.join(', ')}?` : ' (list_effects lists them)'}`,
			);
			return;
		}
		const params: Record<string, SceneAnimR> = {};
		const names = new Set(spec.params.map((p) => p.name));
		for (const name of [...Object.keys(fx.params ?? {}), ...Object.keys(fx.keyframes ?? {})])
			if (!names.has(name))
				out.add(
					[...base, fx.params && name in fx.params ? 'params' : 'keyframes', name],
					`${spec.id} has no param "${name}" (${[...names].join(', ')})`,
				);
		for (const p of spec.params) {
			const given = fx.params?.[p.name];
			const keyed = fx.keyframes?.[p.name];
			if (given !== undefined && keyed) {
				out.add([...base, 'keyframes', p.name], `give params.${p.name} or keyframes.${p.name}, not both`);
				continue;
			}
			if (keyed) {
				if (!p.animatable) {
					out.add([...base, 'keyframes', p.name], `${p.name} cannot be animated`);
					continue;
				}
				params[p.name] = {
					kind: 'keys',
					keys: keys(keyed, rate, [...base, 'keyframes', p.name], out, (v, at) => paramValue(p, v, at, out), {
						hold: !CONTINUOUS_PARAM_TYPES.has(p.type),
					}),
				};
			} else if (given !== undefined) {
				const v = paramValue(p, given, [...base, 'params', p.name], out);
				if (v !== undefined) params[p.name] = { kind: 'static', value: v };
			} else if (!spec.instanceDefaults) params[p.name] = { kind: 'static', value: p.default as SceneValueR };
		}
		res.push({ effectId: spec.id, enabled: fx.enabled ?? true, params });
	});
	return res;
}

/** Ellipse through four vertices with the circle's Bézier handles (κ = 0.5523). */
function ellipseVertices([x, y, w, h]: readonly number[]): SceneMaskVertexR[] {
	const k = 0.5522847498307936;
	const rx = w! / 2;
	const ry = h! / 2;
	const cx = x! + rx;
	const cy = y! + ry;
	return [
		{ p: [cx, y!], in: [-k * rx, 0], out: [k * rx, 0] },
		{ p: [x! + w!, cy], in: [0, -k * ry], out: [0, k * ry] },
		{ p: [cx, y! + h!], in: [k * rx, 0], out: [-k * rx, 0] },
		{ p: [x!, cy], in: [0, k * ry], out: [0, -k * ry] },
	];
}

function masks(layer: SceneLayer, li: number, out: Issues): SceneMaskR[] | undefined {
	if (!layer.masks) return undefined;
	return layer.masks.flatMap((m: SceneMask, i) => {
		const base: ScenePath = ['layers', li, 'masks', i];
		const given = (['ellipse', 'rect', 'path'] as const).filter((k) => m[k] !== undefined);
		if (given.length !== 1) {
			out.add(base, 'a mask has exactly one of ellipse, rect or path');
			return [];
		}
		let vertices: SceneMaskVertexR[];
		let shape: SceneMaskR['shape'];
		let closed = true;
		if (m.ellipse) {
			vertices = ellipseVertices(m.ellipse);
			shape = 'ellipse';
		} else if (m.rect) {
			const [x, y, w, h] = m.rect;
			vertices = [
				[x, y],
				[x + w, y],
				[x + w, y + h],
				[x, y + h],
			].map((p) => ({ p: p as Vec2, in: [0, 0] as Vec2, out: [0, 0] as Vec2 }));
			shape = 'polygon';
		} else {
			const path = m.path!;
			closed = path.closed ?? true;
			if (closed && path.points.length < 3)
				out.add([...base, 'path', 'points'], 'a closed path has at least 3 points');
			vertices = path.points.map((v) =>
				Array.isArray(v)
					? { p: [v[0], v[1]] as Vec2, in: [0, 0] as Vec2, out: [0, 0] as Vec2 }
					: { p: [v.p[0], v.p[1]] as Vec2, in: (v.in ?? [0, 0]) as Vec2, out: (v.out ?? [0, 0]) as Vec2 },
			);
			shape = 'bezier';
		}
		return [
			{
				shape,
				mode: m.mode ?? 'add',
				inverted: m.inverted ?? false,
				feather: m.feather ?? 10,
				opacity: m.opacity ?? 100,
				expansion: m.expansion ?? 0,
				falloff: m.falloff ?? 'smooth',
				closed,
				vertices,
			},
		];
	});
}

function stroke(
	s: { color: SceneColor; width: number; position?: 'inside' | 'center' | 'outside' } | null,
	fallback: SceneStrokeR['position'],
): SceneStrokeR | null {
	return s === null
		? null
		: { color: parseSceneColor(s.color), width: s.width, position: s.position ?? fallback };
}

function animator(
	side: 'in' | 'out',
	a: SceneAnimator | null,
	rate: Rational,
	path: ScenePath,
	out: Issues,
): SceneAnimatorR | null | undefined {
	if (a === null) return null;
	const o = typeof a === 'string' ? { preset: a } : a;
	const spec = latestTextAnimationSpec(o.preset);
	if (!spec) {
		out.add(
			typeof a === 'string' ? path : [...path, 'preset'],
			`unknown text animation "${o.preset}" (list_text_animations)`,
		);
		return undefined;
	}
	if (!spec.phases.includes(side)) {
		out.add(path, `${spec.id} cannot be used as ${side}`);
		return undefined;
	}
	const durationFrames =
		'duration' in o && o.duration !== undefined
			? frames(o.duration, rate, [...path, 'duration'], out)
			: scaleAnimationFrames(spec.defaultDurationFrames, rate);
	if (durationFrames !== null && durationFrames < 1) out.add([...path, 'duration'], 'at least one frame');
	const parsed = spec.paramsSchema.safeParse({
		...spec.defaults,
		...('params' in o ? (o.params ?? {}) : {}),
	});
	if (!parsed.success) {
		for (const i of parsed.error.issues)
			out.add([...path, 'params', ...i.path.map((p) => (typeof p === 'symbol' ? String(p) : p))], i.message);
		return undefined;
	}
	if (durationFrames === null) return undefined;
	return {
		preset: spec.id,
		version: spec.version,
		durationFrames: Math.max(1, durationFrames),
		params: parsed.data as Record<string, unknown>,
	};
}

function text(
	layer: Extract<SceneLayer, { type: 'text' }>,
	li: number,
	rate: Rational,
	out: Issues,
): SceneTextR {
	const t: SceneTextR = { text: layer.text };
	if (layer.font !== undefined) t.font = layer.font;
	if (layer.size !== undefined) t.sizePx = layer.size;
	if (layer.weight !== undefined) t.weight = layer.weight;
	if (layer.italic !== undefined) t.italic = layer.italic;
	if (layer.color !== undefined) t.fill = parseSceneColor(layer.color);
	if (layer.align !== undefined) t.align = layer.align;
	if (layer.lineHeight !== undefined) t.lineHeight = layer.lineHeight;
	if (layer.tracking !== undefined) t.trackingEm = layer.tracking;
	if (layer.allCaps !== undefined) t.allCaps = layer.allCaps;
	if (layer.stroke !== undefined) t.stroke = stroke(layer.stroke, 'outside');
	if (layer.shadow !== undefined)
		t.shadow =
			layer.shadow === null
				? null
				: {
						color: parseSceneColor(layer.shadow.color),
						angleDeg: layer.shadow.angle ?? 135,
						distancePx: layer.shadow.distance ?? 6,
						blurPx: layer.shadow.blur ?? 8,
						spreadPx: layer.shadow.spread ?? 0,
					};
	if (layer.background !== undefined)
		t.background =
			layer.background === null
				? null
				: {
						color: parseSceneColor(layer.background.color),
						paddingPx: layer.background.padding ?? 0,
						radiusPx: layer.background.radius ?? 0,
					};
	if (layer.box && layer.width !== undefined) out.add(['layers', li, 'width'], 'give box or width, not both');
	else if (layer.box) t.box = { mode: 'box', width: layer.box[0], height: layer.box[1] };
	else if (layer.width !== undefined) t.box = { mode: 'paragraph', width: layer.width };
	if (layer.animation !== undefined) {
		if (layer.animation === null) {
			t.animIn = null;
			t.animOut = null;
		} else {
			for (const side of ['in', 'out'] as const) {
				const a = layer.animation[side];
				if (a === undefined) continue;
				const r = animator(side, a, rate, ['layers', li, 'animation', side], out);
				if (r !== undefined) t[side === 'in' ? 'animIn' : 'animOut'] = r;
			}
		}
	}
	return t;
}

const TRACK_RE = /^V(\d{1,2})$/;

/** Resolves a validated scene file against a project. Never throws. */
export function resolveScene(
	file: SceneFile,
	ctx: ResolveContext,
): { ok: true; scene: ResolvedScene } | { ok: false; issues: SceneIssue[] } {
	const out = new Issues();
	const existing = findSceneSequence(ctx.doc, file.sequence.name);
	if (existing.error) out.add(['sequence', 'name'], existing.error);
	let rate = existing.seq?.settings.frameRate ?? SCENE_DEFAULT_RATE;
	const seqOut: ResolvedScene['sequence'] = { name: file.sequence.name };
	if (file.sequence.fps !== undefined) {
		const r = parseSceneRate(file.sequence.fps);
		if (!r) out.add(['sequence', 'fps'], `${file.sequence.fps} is not a frame rate`);
		else {
			rate = r;
			seqOut.frameRate = r;
		}
	}
	if (file.sequence.size) [seqOut.width, seqOut.height] = file.sequence.size;
	if (file.sequence.background) seqOut.background = parseSceneColor(file.sequence.background);
	const seqDuration =
		file.sequence.duration !== undefined
			? frames(file.sequence.duration, rate, ['sequence', 'duration'], out)
			: null;
	const seen = new Map<string, number>();
	const layers: ResolvedSceneLayer[] = [];
	file.layers.forEach((layer, li) => {
		const base: ScenePath = ['layers', li];
		const prevIdx = seen.get(layer.id);
		if (prevIdx !== undefined) out.add([...base, 'id'], `id "${layer.id}" is also layers[${prevIdx}]`);
		seen.set(layer.id, li);
		const start = layer.start !== undefined ? frames(layer.start, rate, [...base, 'start'], out) : 0;
		let duration: number | null;
		if (layer.duration !== undefined) duration = frames(layer.duration, rate, [...base, 'duration'], out);
		else if (seqDuration !== null && start !== null) duration = seqDuration - start;
		else {
			out.add([...base, 'duration'], 'needed (or give sequence.duration)');
			duration = null;
		}
		if (duration !== null && duration < 1) out.add([...base, 'duration'], 'a layer lasts at least one frame');
		const track =
			layer.track === undefined
				? li + 1
				: typeof layer.track === 'number'
					? layer.track
					: Number(TRACK_RE.exec(layer.track)![1]);
		if (track < 1) out.add([...base, 'track'], 'tracks start at V1');
		const kind = layer.type === 'svg' ? 'image' : layer.type;
		const allowed = new Set<SceneProp>([
			...SCENE_COMMON_PROPS,
			...(kind === 'shape' ? SCENE_SHAPE_PROPS : []),
		]);
		for (const p of Object.keys(layer.keyframes ?? {}))
			if (!allowed.has(p as SceneProp))
				out.add(
					[...base, 'keyframes', p],
					`"${p}" cannot be keyed on a ${layer.type} layer (${[...allowed].join(', ')})`,
				);
		const props: ResolvedSceneLayer['props'] = {};
		for (const p of allowed) {
			const st = (layer as Record<string, unknown>)[p];
			const keyed = layer.keyframes?.[p];
			if (st !== undefined && keyed) {
				out.add([...base, 'keyframes', p], `give ${p} or keyframes.${p}, not both`);
				continue;
			}
			if (keyed)
				props[p] = {
					kind: 'keys',
					keys: keys(keyed, rate, [...base, 'keyframes', p], out, (v, at) => propValue(p, v, at, out), {
						point: p === 'position',
					}),
				};
			else if (st !== undefined) {
				const v = propValue(p, st, [...base, p], out);
				if (v !== undefined) props[p] = { kind: 'static', value: v };
			}
		}
		const r: ResolvedSceneLayer = {
			id: layer.id,
			name: layer.name ?? layer.id,
			kind,
			start: start ?? 0,
			duration: Math.max(1, duration ?? 1),
			track,
			props,
			index: li,
		};
		if (layer.clip) r.clipPin = layer.clip;
		if (layer.blend) r.blend = layer.blend;
		const fx = effects(layer, li, rate, ctx, out);
		if (fx) r.effects = fx;
		const mk = masks(layer, li, out);
		if (mk) r.masks = mk;
		switch (layer.type) {
			case 'text':
				r.text = text(layer, li, rate, out);
				break;
			case 'image':
			case 'svg': {
				const id = ctx.mediaFor(layer.src, 'image');
				if (!id) out.add([...base, 'src'], `no such media "${layer.src}" in the project`);
				else {
					const m = ctx.doc.media[id];
					if (m && m.kind !== 'image')
						out.add([...base, 'src'], `"${layer.src}" is ${m.kind} media, not an image`);
					r.mediaId = id;
				}
				break;
			}
			case 'shape':
				r.shape = { type: layer.shape };
				if (layer.stroke !== undefined) r.shape.stroke = stroke(layer.stroke, 'center');
				if (layer.shape === 'ellipse' && props.radius)
					out.add([...base, 'radius'], 'an ellipse has no corner radius');
				break;
			case 'composition': {
				const id = ctx.mediaFor(layer.bundle, 'bundle');
				const m = id ? ctx.doc.media[id] : undefined;
				if (!id || !m || m.kind !== 'mg-bundle') {
					out.add([...base, 'bundle'], `no Remotion bundle "${layer.bundle}" in the project`);
					break;
				}
				const comps = m.mgBundle?.compositions ?? [];
				if (!comps.some((c) => c.id === layer.composition))
					out.add(
						[...base, 'composition'],
						`the bundle has no composition "${layer.composition}" (${comps.map((c) => c.id).join(', ') || 'none'})`,
					);
				r.composition = {
					mediaId: id,
					id: layer.composition,
					...(layer.props ? { props: layer.props } : {}),
				};
				break;
			}
		}
		layers.push(r);
	});
	// Two layers on one track must not overlap (the timeline holds one clip per track and frame).
	const byTrack = new Map<number, ResolvedSceneLayer[]>();
	for (const l of layers) byTrack.set(l.track, [...(byTrack.get(l.track) ?? []), l]);
	for (const list of byTrack.values()) {
		const sorted = [...list].sort((a, b) => a.start - b.start);
		for (let i = 1; i < sorted.length; i++) {
			const a = sorted[i - 1]!;
			const b = sorted[i]!;
			if (b.start < a.start + a.duration)
				out.add(
					['layers', b.index, 'track'],
					`overlaps layers[${a.index}] ("${a.id}") on V${b.track}; give one of them another track`,
				);
		}
	}
	if (out.list.length) return { ok: false, issues: out.list };
	return { ok: true, scene: { sequence: seqOut, layers } };
}
