// Spec 19 TL-013 / TL-020: what INV-APPEARANCE checks and what `repairAppearance` does. Appearances are read leniently
// (`z.custom`): a damaged one never stops a project opening, the load repairs it conservatively and reports what it
// changed. Commands validate strictly and refuse with `E_*`. Everything here reads the layer catalogue of
// `registry/fx/title-look/registry.ts`, so a new layer type or finish is validated without touching this file.
import { ID_PREFIXES, idPrefixOf, isValidId } from '../ids.ts';
import {
	isPaintParam,
	type TitleLayerType,
	type TitleParamSpec,
} from '../registry/fx/title-look/contract.ts';
import { paramSpec, titleLayerType } from '../registry/fx/title-look/registry.ts';
import type { ProjectDocument } from '../schema/document.ts';
import { isKeyframedParamValid } from './keyframes.ts';
import {
	type Appearance,
	type AppearanceLayer,
	AppearanceSchema,
	appearanceBytes,
	COLOR_ROLES,
	DEFAULT_LIGHT_ALTITUDE,
	DEFAULT_LIGHT_ANGLE,
	GlobalLightSchema,
	isPlainObject,
	type LayerParamValue,
	LookColorSchema,
	MAX_APPEARANCE_BYTES,
	MAX_APPEARANCE_LAYERS,
	MAX_GRADIENT_STOPS,
	MAX_TITLE_LOOK_NAME,
	MAX_TITLE_LOOKS,
	type Paint,
	PaintSchema,
	staticAnim,
	TITLE_LOOK_CLIP_KINDS,
	TITLE_LOOK_EFFECT_ID,
	type TitleLook,
	TitleLookSchema,
} from './model.ts';

export type Note = (action: string, entity: string, detail: string) => void;

const NUM = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Why a paint is unusable, or null. `E_LIMIT` material is named by `paintLimitProblem`. */
export function paintProblem(v: unknown): string | null {
	const r = PaintSchema.safeParse(v);
	if (!r.success) return `unreadable paint: ${r.error.issues[0]?.message ?? 'invalid'}`;
	return paintLimitProblem(r.data);
}

/** TL-013: a gradient with too many stops. */
export function paintLimitProblem(p: Paint): string | null {
	if (p.kind === 'gradient' && p.gradient.stops.length > MAX_GRADIENT_STOPS)
		return `a gradient holds at most ${MAX_GRADIENT_STOPS} stops (has ${p.gradient.stops.length})`;
	return null;
}

/** Why a value does not fit a param spec, or null. */
export function paramValueProblem(p: TitleParamSpec, v: unknown): string | null {
	if (isPaintParam(p)) return paintProblem(v);
	switch (p.type) {
		case 'number':
			if (!NUM(v)) return 'not a number';
			if ((p.range?.min !== undefined && v < p.range.min) || (p.range?.max !== undefined && v > p.range.max))
				return `${v} is out of range`;
			return null;
		case 'boolean':
			return typeof v === 'boolean' ? null : 'not a boolean';
		case 'enum':
			return typeof v === 'string' && (p.options ?? []).includes(v) ? null : 'not one of the options';
		case 'string':
			return typeof v === 'string' ? null : 'not a string';
		case 'vec2':
			return Array.isArray(v) && v.length === 2 && v.every(NUM) ? null : 'not a pair of numbers';
		case 'color':
			return LookColorSchema.safeParse(v).success ? null : 'not a colour';
		case 'media':
			return isPlainObject(v) && typeof v.mediaId === 'string' ? null : 'not a media reference';
		default:
			return null;
	}
}

/** Why a stored layer is unusable, or null. */
function layerProblem(l: AppearanceLayer): string | null {
	const def = titleLayerType(l.type);
	if (!def) return `unknown layer type ${l.type}`;
	for (const [name, anim] of Object.entries(l.params)) {
		const p = paramSpec(def, name);
		if (!p) return `${l.type} has no parameter ${name}`;
		for (const v of [anim.value, ...anim.keyframes.map((k) => k.value)]) {
			const bad = paramValueProblem(p, v);
			if (bad) return `${l.type}.${name}: ${bad}`;
		}
		if (!p.animatable && anim.keyframes.some((k) => k.interpolation !== 'hold'))
			return `${l.type}.${name} is hold-only`;
	}
	return null;
}

/** Why an appearance fails INV-APPEARANCE (TL-011, TL-013), or null. */
export function appearanceProblem(raw: unknown): string | null {
	const r = AppearanceSchema.safeParse(raw);
	if (!r.success) {
		const i = r.error.issues[0]!;
		return `${i.path.join('.') || 'appearance'}: ${i.message}`;
	}
	const a = r.data as unknown as Appearance;
	if (a.layers.length > MAX_APPEARANCE_LAYERS) return `more than ${MAX_APPEARANCE_LAYERS} layers`;
	if (appearanceBytes(a) > MAX_APPEARANCE_BYTES) return `larger than ${MAX_APPEARANCE_BYTES} bytes`;
	if (a.lookId !== undefined && !isValidId(a.lookId, ID_PREFIXES.titleLook))
		return `malformed look id ${a.lookId}`;
	const ids = new Set<string>();
	for (const l of a.layers) {
		if (!isValidId(l.id, ID_PREFIXES.appearanceLayer)) return `malformed layer id ${l.id}`;
		if (ids.has(l.id)) return `layer id ${l.id} used twice`;
		ids.add(l.id);
		const bad = layerProblem(l);
		if (bad) return bad;
	}
	return null;
}

const animValid = (v: unknown): v is { value: unknown; keyframes: unknown[] } =>
	isPlainObject(v) && 'value' in v && Array.isArray(v.keyframes);

/** The closest legal value of a param, or null when there is none. */
function repairedValue(p: TitleParamSpec, v: unknown): LayerParamValue | null {
	if (!paramValueProblem(p, v)) return v as LayerParamValue;
	if (isPaintParam(p)) {
		const parsed = PaintSchema.safeParse(v);
		if (parsed.success && parsed.data.kind === 'gradient')
			return {
				kind: 'gradient',
				gradient: { ...parsed.data.gradient, stops: parsed.data.gradient.stops.slice(0, MAX_GRADIENT_STOPS) },
			};
		return null;
	}
	if (p.type === 'number' && NUM(v))
		return Math.min(p.range?.max ?? Number.POSITIVE_INFINITY, Math.max(p.range?.min ?? Number.NEGATIVE_INFINITY, v));
	return null;
}

/** One stored param made legal: keys that cannot be kept go, a value with no reading takes the default. */
function repairParam(p: TitleParamSpec, raw: unknown, who: string, note: Note): LayerParamValue | undefined | object {
	if (!animValid(raw)) {
		note('repair-appearance', who, `${p.name}: unreadable value reset`);
		return undefined;
	}
	const value = repairedValue(p, raw.value);
	if (value === null) note('repair-appearance', who, `${p.name}: unreadable value reset to the default`);
	else if (value !== raw.value) note('repair-appearance', who, `${p.name}: value corrected`);
	const keyframes = (raw.keyframes as Record<string, unknown>[]).filter((k) => {
		const ok = isKeyframedParamValid(k);
		if (!ok) note('repair-appearance', who, `${p.name}: unreadable keyframe removed`);
		return ok;
	});
	const kept: unknown[] = [];
	for (const k of keyframes) {
		const fixed = repairedValue(p, k.value);
		if (fixed === null) {
			note('repair-appearance', who, `${p.name}: keyframe with an unreadable value removed`);
			continue;
		}
		kept.push({
			...k,
			value: fixed,
			...(p.animatable ? {} : { interpolation: 'hold' }),
		});
	}
	return { ...raw, value: value ?? p.default, keyframes: kept };
}

function repairLayer(raw: unknown, def: TitleLayerType, id: string, note: Note): AppearanceLayer {
	const r = raw as Record<string, unknown>;
	const params: Record<string, unknown> = {};
	for (const [name, a] of Object.entries(isPlainObject(r.params) ? r.params : {})) {
		const p = paramSpec(def, name);
		if (!p) {
			note('repair-appearance', id, `${def.type} has no parameter ${name}: removed`);
			continue;
		}
		const fixed = repairParam(p, a, id, note);
		if (fixed !== undefined) params[name] = fixed;
	}
	const name = typeof r.name === 'string' ? r.name.slice(0, MAX_TITLE_LOOK_NAME) : undefined;
	return {
		id,
		type: def.type,
		enabled: r.enabled !== false,
		...(name ? { name } : {}),
		params: params as AppearanceLayer['params'],
	};
}

/**
 * The readable part of an appearance (TL-020), or null when nothing is. Conservative: only what cannot be read goes;
 * every change is reported. Idempotent. When over the limits the top of the stack stays (the title itself is
 * there), and the excess layers are dropped and reported.
 */
export function repairAppearance(
	raw: unknown,
	newLayerId: () => string,
	who: string,
	note: Note,
): Appearance | null {
	if (!isPlainObject(raw)) return null;
	const a: Record<string, unknown> = { ...raw };
	if (a.v !== 1) {
		if (typeof a.v === 'number' && a.v > 1) return null;
		a.v = 1;
		note('repair-appearance', who, 'version set to 1');
	}
	if (a.lookId !== undefined && !isValidId(a.lookId, ID_PREFIXES.titleLook)) {
		delete a.lookId;
		delete a.lookOverrides;
		note('repair-appearance', who, 'unreadable look link removed');
	}
	if (a.lookOverrides !== undefined && (!isPlainObject(a.lookOverrides) || a.lookId === undefined)) {
		delete a.lookOverrides;
		note('repair-appearance', who, 'unreadable look overrides removed');
	}
	if (a.colorwayId !== undefined && typeof a.colorwayId !== 'string') {
		delete a.colorwayId;
		note('repair-appearance', who, 'unreadable colourway removed');
	}
	if (a.font !== undefined && !(isPlainObject(a.font) && typeof a.font.family === 'string' && a.font.family)) {
		delete a.font;
		note('repair-appearance', who, 'unreadable font removed');
	}
	const seed = Number.isSafeInteger(a.seed) && (a.seed as number) >= 0 ? (a.seed as number) : null;
	if (seed === null || seed > 0xffff_ffff) {
		a.seed = NUM(a.seed) ? Math.abs(Math.trunc(a.seed)) % 2 ** 32 : 0;
		note('repair-appearance', who, 'unreadable seed reset');
	}
	const palette: Record<string, unknown> = {};
	for (const [role, v] of Object.entries(isPlainObject(a.palette) ? a.palette : {})) {
		const good =
			(COLOR_ROLES as readonly string[]).includes(role) &&
			animValid(v) &&
			LookColorSchema.safeParse(v.value).success &&
			(v.keyframes as { value?: unknown }[]).every(
				(k) => LookColorSchema.safeParse(k?.value).success && isKeyframedParamValid(k),
			);
		if (good) palette[role] = v;
		else note('repair-appearance', who, `palette role ${role} removed`);
	}
	if (a.palette !== undefined && !isPlainObject(a.palette))
		note('repair-appearance', who, 'unreadable palette removed');
	a.palette = palette;
	const light = isPlainObject(a.light) ? a.light : {};
	const lightAnim = (k: 'angle' | 'altitude', d: number) => {
		const v = light[k] as { value?: unknown; keyframes?: unknown[] } | undefined;
		const good =
			animValid(v) &&
			NUM(v.value) &&
			(v.keyframes as { value?: unknown }[]).every((x) => NUM(x?.value) && isKeyframedParamValid(x));
		if (good) return v;
		note('repair-appearance', who, `light ${k} reset`);
		return staticAnim(d);
	};
	const lightSource = light.source === 'sequence' ? 'sequence' : 'look';
	if (a.light !== undefined && light.source !== lightSource)
		note('repair-appearance', who, 'light source reset');
	a.light = {
		...light,
		source: lightSource,
		angle: lightAnim('angle', DEFAULT_LIGHT_ANGLE),
		altitude: lightAnim('altitude', DEFAULT_LIGHT_ALTITUDE),
	};
	const seen = new Set<string>();
	const layers: AppearanceLayer[] = [];
	for (const l of Array.isArray(a.layers) ? a.layers : []) {
		const def = isPlainObject(l) && typeof l.type === 'string' ? titleLayerType(l.type) : undefined;
		if (!isPlainObject(l) || !def) {
			note(
				'drop-appearance-layer',
				who,
				`layer of ${isPlainObject(l) ? `unknown type ${String(l.type)}` : 'no type'} removed`,
			);
			continue;
		}
		let id = l.id as string;
		if (!isValidId(id, ID_PREFIXES.appearanceLayer) || seen.has(id)) {
			id = newLayerId();
			note('repair-appearance', who, `layer ${String(l.id)} got a new id`);
		}
		seen.add(id);
		layers.push(repairLayer(l, def, id, note));
	}
	if (layers.length > MAX_APPEARANCE_LAYERS) {
		note(
			'drop-appearance-layer',
			who,
			`${layers.length - MAX_APPEARANCE_LAYERS} excess layers removed (at most ${MAX_APPEARANCE_LAYERS})`,
		);
		layers.splice(0, layers.length - MAX_APPEARANCE_LAYERS);
	}
	a.layers = layers;
	while (layers.length > 0 && appearanceBytes(a) > MAX_APPEARANCE_BYTES) {
		layers.shift();
		note('drop-appearance-layer', who, `a layer removed: larger than ${MAX_APPEARANCE_BYTES} bytes`);
	}
	if (appearanceBytes(a) > MAX_APPEARANCE_BYTES) return null;
	return appearanceProblem(a) ? null : (a as unknown as Appearance);
}

/** Why one stored project look is unreadable (key = record key), or null. */
export function titleLookProblem(key: string, v: unknown): string | null {
	const r = TitleLookSchema.safeParse(v);
	if (!r.success) {
		const i = r.error.issues[0]!;
		return `${i.path.join('.') || 'entry'}: ${i.message}`;
	}
	if (r.data.id !== key) return `record key ${key} differs from id ${r.data.id}`;
	if (!isValidId(key) || idPrefixOf(key) !== ID_PREFIXES.titleLook) return `malformed id ${key}`;
	if (!r.data.name.trim()) return 'empty name';
	return appearanceProblem(r.data.appearance);
}

/** The readable project looks. */
export function titleLooksOf(doc: Pick<ProjectDocument, 'titleLooks'>): TitleLook[] {
	const rec = (doc as { titleLooks?: unknown }).titleLooks;
	if (!isPlainObject(rec)) return [];
	return Object.entries(rec)
		.filter(([k, v]) => !titleLookProblem(k, v))
		.map(([, v]) => v as TitleLook);
}

/** One readable project look, or null. */
export function titleLookOf(doc: Pick<ProjectDocument, 'titleLooks'>, id: string): TitleLook | null {
	const rec = (doc as { titleLooks?: unknown }).titleLooks;
	if (!isPlainObject(rec) || !Object.hasOwn(rec, id)) return null;
	return titleLookProblem(id, rec[id]) ? null : (rec[id] as TitleLook);
}

/** INV-APPEARANCE over `doc.titleLooks`: [message, path] pairs. */
export function titleLooksRecordIssues(doc: ProjectDocument): [string, string[]][] {
	const rec = (doc as { titleLooks?: unknown }).titleLooks;
	if (rec === undefined) return [];
	if (!isPlainObject(rec)) return [['titleLooks is not a record', ['titleLooks']]];
	const out: [string, string[]][] = [];
	if (Object.keys(rec).length > MAX_TITLE_LOOKS)
		out.push([`more than ${MAX_TITLE_LOOKS} project looks`, ['titleLooks']]);
	for (const [k, v] of Object.entries(rec)) {
		const bad = titleLookProblem(k, v);
		if (bad) out.push([`Look ${k}: ${bad}`, ['titleLooks', k]]);
	}
	return out;
}

/** The readable project looks, keyed by id (TL-020). Idempotent. */
export function repairTitleLooks(doc: ProjectDocument, newLayerId: () => string, newLookId: () => string, note: Note): void {
	const d = doc as { titleLooks?: unknown };
	if (d.titleLooks === undefined) return;
	if (!isPlainObject(d.titleLooks)) {
		delete d.titleLooks;
		note('drop-title-looks', 'titleLooks', 'unreadable look record removed');
		return;
	}
	const rec = d.titleLooks;
	for (const key of Object.keys(rec)) {
		let v = rec[key];
		if (!isPlainObject(v)) {
			delete rec[key];
			note('drop-title-look', key, 'unreadable look removed');
			continue;
		}
		let k = key;
		if (!isValidId(k, ID_PREFIXES.titleLook)) {
			delete rec[k];
			k = isValidId(v.id, ID_PREFIXES.titleLook) && !Object.hasOwn(rec, v.id) ? v.id : newLookId();
			rec[k] = v;
			note('fix-id', key, `look re-keyed as ${k}`);
		}
		if (v.id !== k) {
			v = { ...v, id: k };
			rec[k] = v;
			note('fix-id', k, 'look id set to its key');
		}
		const fixed = repairAppearance((v as Record<string, unknown>).appearance, newLayerId, k, note);
		if (!fixed) {
			delete rec[k];
			note('drop-title-look', k, 'look with an unreadable appearance removed');
			continue;
		}
		const next = { ...(v as object), appearance: fixed } as Record<string, unknown>;
		if (typeof next.name === 'string') next.name = next.name.slice(0, MAX_TITLE_LOOK_NAME);
		if (typeof next.name !== 'string' || !next.name.trim()) {
			next.name = 'Look';
			note('repair-appearance', k, 'look name reset');
		}
		rec[k] = next;
		if (titleLookProblem(k, next)) {
			delete rec[k];
			note('drop-title-look', k, 'unreadable look removed');
		}
	}
	const keys = Object.keys(rec);
	for (const k of keys.slice(MAX_TITLE_LOOKS)) {
		delete rec[k];
		note('drop-title-look', k, `more than ${MAX_TITLE_LOOKS} project looks`);
	}
	if (Object.keys(rec).length === 0) delete d.titleLooks;
}

/** Why a clip's look instances fail INV-APPEARANCE (TL-010), or null. */
export function clipLookProblem(clip: { kind: string; effects?: readonly { effectId: string }[] }): string | null {
	const n = (clip.effects ?? []).filter((fx) => fx.effectId === TITLE_LOOK_EFFECT_ID).length;
	if (n === 0) return null;
	if (n > 1) return 'a clip holds at most one look';
	if (!(TITLE_LOOK_CLIP_KINDS as readonly string[]).includes(clip.kind)) return `${clip.kind} clips take no look`;
	return null;
}

/** Why a sequence's global light fails INV-APPEARANCE, or null. */
export function globalLightProblem(v: unknown): string | null {
	if (v === undefined) return null;
	return GlobalLightSchema.safeParse(v).success ? null : 'unreadable global light';
}
