// Hybrid text layers (M3, wp-m3-mgtext, S08:MGC-036…039): the texts a Remotion composition exposes as props,
// found in its props schema, with the props that style them (font, size, colour, alignment…), soft limits and
// the checks behind the overflow warnings. Pure: the Properties panel, the on-canvas editor, the engine and the
// MCP tools share it.
//
// A text layer is a string prop (any depth) that is
//   1. declared in `jasper.mg.json` → `compositions.<id>.texts.<prop.path>` (explicit; `false` excludes), or
//   2. annotated `"x-jasper-text": true | {…}` in the JSON Schema (zod 4: `.meta({'x-jasper-text': true})`), or
//   3. hinted `ui.<path>.control: "text" | "textarea"`, or
//   4. a plain string (no enum/pattern/format, not a colour or asset path, not named like a URL, id, font…) —
//      MGC-011's inference maps strings to text, so these are texts too.
// Style props are linked by the manifest (`style: {color: "titleColor"}`), else by convention:
//   - text object  `{headline: {text, color, fontSize, fontFamily, fontWeight, align, …}}` (the text key is
//     `text`; its siblings style it; the layer is labelled by the object's name);
//   - sibling prefix `title` + `titleColor` / `titleFontSize` / `titleSize` / `titleFont` / `titleFontFamily` /
//     `titleWeight` / `titleAlign` / `titleItalic` / `titleLineHeight` / `titleLetterSpacing` (also `title_color`).

import { compositionPropsPropertySpecs, type PropertySpec } from '../registry/properties.ts';
import type { MgCompositionInfo, MgTextDecl } from '../schema/media.ts';
import { isCssColor, type JsonSchemaNode, validateJsonSchema } from './json-schema.ts';
import { getPropAt, mergeProps, setPropOverride } from './props.ts';

export const TEXT_STYLE_ROLES = [
	'fontFamily',
	'fontSize',
	'fontWeight',
	'italic',
	'color',
	'align',
	'lineHeight',
	'letterSpacing',
] as const;
export type TextStyleRole = (typeof TEXT_STYLE_ROLES)[number];

/** Prop names that play a style role (object convention) / suffixes (sibling-prefix convention). */
const ROLE_NAMES: Record<TextStyleRole, readonly string[]> = {
	fontFamily: ['fontFamily', 'font', 'family', 'typeface'],
	fontSize: ['fontSize', 'size', 'textSize'],
	fontWeight: ['fontWeight', 'weight'],
	italic: ['italic'],
	color: ['color', 'colour', 'textColor', 'fill'],
	align: ['align', 'textAlign', 'alignment'],
	lineHeight: ['lineHeight', 'leading'],
	letterSpacing: ['letterSpacing', 'tracking'],
};

/** Names of string props that are not copy (only excluded when nothing marks them as text). */
const NOT_TEXT_NAME =
	/(?:^|[a-z_])(?:url|uri|src|href|path|file|filename|id|key|slug|font|fontfamily|family|typeface|image|img|video|audio|icon|asset|footage|classname|class|mode|variant|theme|preset|style|kind|type|layout|position|anchor|direction|side|shape|format|codec|align|alignment|easing|color|colour|bg|background|lang|locale)$/i;

export type CompositionTextLayer = {
	/** Prop path of the text (`['title']`, `['headline', 'text']`). */
	path: string[];
	/** Property key (`props.title`): param.set target `["clip", id, "props", …path]`. */
	key: string;
	label: string;
	multiline: boolean;
	/** How it was found (explicit declarations first). */
	source: 'manifest' | 'schema' | 'ui' | 'inferred';
	/** Hard limits from the JSON Schema (validated by the commands). */
	minLength?: number;
	maxLength?: number;
	/** Soft limits (warnings). */
	maxChars?: number;
	maxLines?: number;
	/** Safe area in composition pixels. */
	box?: { x: number; y: number; width: number; height: number };
	/** Composition frame where the text is laid out (manifest), else the composition's thumbnail frame. */
	frame?: number;
	hint?: string;
	/** Accent markup: `*…*` spans render in this colour (CSS colour, or the dotted path of a colour prop). */
	accent?: string;
	description?: string;
	/** Props that style this text, by role. */
	style: Partial<Record<TextStyleRole, StyleLink>>;
};

/** A prop that styles a text: its path and the spec the Properties form uses for it. */
export type StyleLink = { path: string[]; key: string; spec: PropertySpec };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const snake = (s: string) => s.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
const humanize = (name: string) =>
	name
		.replace(/[_-]+/g, ' ')
		.replace(/([a-z])([A-Z])/g, '$1 $2')
		.replace(/^./, (c) => c.toUpperCase());

/** Whether a spec can carry a style role. */
function fitsRole(role: TextStyleRole, s: PropertySpec): boolean {
	switch (role) {
		case 'color':
			return s.kind === 'string' && s.ui.control === 'color';
		case 'fontSize':
		case 'lineHeight':
		case 'letterSpacing':
			return s.kind === 'number';
		case 'fontWeight':
			return s.kind === 'number' || s.kind === 'enum' || (s.kind === 'string' && s.ui.control === 'text');
		case 'fontFamily':
			return s.kind === 'enum' || (s.kind === 'string' && s.ui.control === 'text');
		case 'align':
			return s.kind === 'enum' || (s.kind === 'string' && s.ui.control === 'text');
		case 'italic':
			return s.kind === 'boolean';
	}
}

/** The `x-jasper-text` annotation of a spec's schema: undefined (none), false, or a declaration. */
function schemaDecl(s: PropertySpec): MgTextDecl | false | undefined {
	const v = (s.valueSchema as JsonSchemaNode | undefined)?.['x-jasper-text'];
	if (v === false) return false;
	if (v === true) return {};
	return isObj(v) ? (v as MgTextDecl) : undefined;
}

type InfoForTexts = Pick<MgCompositionInfo, 'propsSchema' | 'defaultProps' | 'ui' | 'thumbnailFrame'> & {
	texts?: MgCompositionInfo['texts'];
};

const cache = new WeakMap<object, CompositionTextLayer[]>();

/**
 * The text layers of a composition (S08:MGC-036), explicit declarations first (manifest order), then in schema
 * order. Cached per composition info object.
 */
export function compositionTextLayers(info: InfoForTexts): CompositionTextLayer[] {
	const hit = cache.get(info);
	if (hit) return hit;
	const out = computeTextLayers(info);
	cache.set(info, out);
	return out;
}

function computeTextLayers(info: InfoForTexts): CompositionTextLayer[] {
	const specs = compositionPropsPropertySpecs(info);
	const byPath = new Map(specs.map((s) => [s.storagePath.slice(1).join('.'), s]));
	const decls = (info.texts ?? {}) as Record<string, MgTextDecl | false>;
	const ui = (info.ui ?? {}) as Record<string, { control?: string } | undefined>;

	type Cand = { spec: PropertySpec; decl: MgTextDecl; source: CompositionTextLayer['source'] };
	const cands: Cand[] = [];
	const seen = new Set<string>();
	const add = (path: string, decl: MgTextDecl, source: Cand['source']) => {
		const spec = byPath.get(path);
		if (!spec || seen.has(path) || spec.kind !== 'string') return;
		seen.add(path);
		cands.push({ spec, decl, source });
	};
	// 1. manifest declarations, in their order
	for (const [path, d] of Object.entries(decls)) if (d) add(path, d, 'manifest');
	// 2–4. the schema's string leaves
	for (const s of specs) {
		const path = s.storagePath.slice(1).join('.');
		if (seen.has(path) || decls[path] === false || s.kind !== 'string') continue;
		const ann = schemaDecl(s);
		if (ann === false) continue;
		if (ann) {
			add(path, ann, 'schema');
			continue;
		}
		const control = ui[path]?.control;
		if (control === 'text' || control === 'textarea') {
			add(path, control === 'textarea' ? { multiline: true } : {}, 'ui');
			continue;
		}
		if (control || s.ui.control === 'color') continue; // colour, asset, json, select…
		const vs = (s.valueSchema ?? {}) as JsonSchemaNode;
		if (vs.pattern !== undefined || vs.format !== undefined || vs.const !== undefined) continue;
		const name = s.storagePath[s.storagePath.length - 1]!;
		if (NOT_TEXT_NAME.test(name)) continue;
		add(path, {}, 'inferred');
	}

	// Style links. Paths used as a style of some text are not texts themselves.
	const styled = new Set<string>();
	const layers = cands.map(({ spec, decl, source }) => {
		const path = spec.storagePath.slice(1) as string[];
		const name = path[path.length - 1]!;
		const parent = path.slice(0, -1);
		const style: CompositionTextLayer['style'] = {};
		const link = (role: TextStyleRole, p: string): boolean => {
			const s = byPath.get(p);
			if (!s || style[role] || !fitsRole(role, s) || p === path.join('.')) return false;
			style[role] = { path: p.split('.'), key: s.key, spec: s };
			styled.add(p);
			return true;
		};
		for (const [role, p] of Object.entries(decl.style ?? {}))
			if ((TEXT_STYLE_ROLES as readonly string[]).includes(role)) link(role as TextStyleRole, p);
		const textObject = name === 'text' && parent.length > 0;
		for (const role of TEXT_STYLE_ROLES) {
			if (style[role]) continue;
			for (const n of ROLE_NAMES[role]) {
				const candidates = textObject
					? [[...parent, n].join('.')]
					: [[...parent, `${name}${cap(n)}`].join('.'), [...parent, `${snake(name)}_${snake(n)}`].join('.')];
				if (candidates.some((p) => link(role, p))) break;
			}
		}
		const vs = (spec.valueSchema ?? {}) as JsonSchemaNode;
		const dflt = getPropAt(info.defaultProps, path);
		const label =
			decl.label ?? (textObject && spec.label === 'Text' ? humanize(parent[parent.length - 1]!) : spec.label);
		const maxLines = decl.maxLines;
		const multiline =
			decl.multiline ??
			(spec.ui.multiline ||
				(maxLines !== undefined && maxLines > 1) ||
				(typeof dflt === 'string' && (dflt.includes('\n') || dflt.length > 80)));
		const layer: CompositionTextLayer = {
			path,
			key: spec.key,
			label,
			multiline,
			source,
			style,
			...(typeof vs.minLength === 'number' ? { minLength: vs.minLength } : {}),
			...(typeof vs.maxLength === 'number' ? { maxLength: vs.maxLength } : {}),
			...(decl.maxChars !== undefined ? { maxChars: decl.maxChars } : {}),
			...(maxLines !== undefined ? { maxLines } : {}),
			...(decl.box ? { box: decl.box } : {}),
			...(decl.frame !== undefined
				? { frame: decl.frame }
				: info.thumbnailFrame !== undefined
					? { frame: info.thumbnailFrame }
					: {}),
			...(decl.hint ? { hint: decl.hint } : {}),
			...(decl.accent ? { accent: decl.accent } : {}),
			...(spec.description ? { description: spec.description } : {}),
		};
		return layer;
	});
	return layers.filter((l) => l.source === 'manifest' || !styled.has(l.path.join('.')));
}

/** Property keys handled by the text editors (texts and their style props): the generic form skips them. */
export function textLayerPropertyKeys(layers: readonly CompositionTextLayer[]): Set<string> {
	const keys = new Set<string>();
	for (const l of layers) {
		keys.add(l.key);
		for (const s of Object.values(l.style)) if (s) keys.add(s.key);
	}
	return keys;
}

/** Finds a text layer by prop path (`title`, `headline.text`), property key (`props.title`) or label. */
export function findTextLayer(
	layers: readonly CompositionTextLayer[],
	ref: string,
): CompositionTextLayer | undefined {
	const r = ref.startsWith('props.') ? ref.slice('props.'.length) : ref;
	return (
		layers.find((l) => l.path.join('.') === r) ??
		layers.find((l) => l.label === ref) ??
		layers.find((l) => l.label.toLowerCase() === ref.toLowerCase())
	);
}

// ---------------------------------------------------------------- checks (S08:MGC-037)

export type TextIssueCode =
	| 'MG_TEXT_TOO_LONG'
	| 'MG_TEXT_TOO_SHORT'
	| 'MG_TEXT_LONG'
	| 'MG_TEXT_LINES'
	| 'MG_TEXT_OFF_FRAME'
	| 'MG_TEXT_CLIPPED'
	| 'MG_TEXT_OUTSIDE_BOX'
	| 'MG_TEXT_TRUNCATED'
	| 'MG_TEXT_NOT_FOUND';
export type TextIssue = {
	code: TextIssueCode;
	/** `error` = the edit is refused (schema); `warning` = allowed, may not fit; `info` = cannot check. */
	severity: 'error' | 'warning' | 'info';
	message: string;
};

/** Characters as the user counts them (code points; combining marks are rare in titles). */
export const textLength = (s: string): number => [...s].length;

/** Static checks of a value (no layout): schema length (errors), soft character and line limits (warnings). */
export function checkCompositionText(layer: CompositionTextLayer, value: string): TextIssue[] {
	const out: TextIssue[] = [];
	const n = textLength(value);
	const q = `«${layer.label}»`;
	if (layer.maxLength !== undefined && n > layer.maxLength)
		out.push({
			code: 'MG_TEXT_TOO_LONG',
			severity: 'error',
			message: `${q} has ${n} characters; the composition allows at most ${layer.maxLength}.`,
		});
	if (layer.minLength !== undefined && n < layer.minLength)
		out.push({
			code: 'MG_TEXT_TOO_SHORT',
			severity: 'error',
			message:
				layer.minLength === 1
					? `${q} cannot be empty.`
					: `${q} needs at least ${layer.minLength} characters.`,
		});
	if (layer.maxChars !== undefined && n > layer.maxChars)
		out.push({
			code: 'MG_TEXT_LONG',
			severity: 'warning',
			message: `${q} has ${n} characters (designed for ${layer.maxChars}): it may not fit.`,
		});
	const lines = value.split('\n').length;
	if (layer.maxLines !== undefined && lines > layer.maxLines)
		out.push({
			code: 'MG_TEXT_LINES',
			severity: 'warning',
			message: `${q} has ${lines} lines (designed for ${layer.maxLines}).`,
		});
	if (!layer.multiline && value.includes('\n'))
		out.push({
			code: 'MG_TEXT_LINES',
			severity: 'warning',
			message: `${q} is a single-line text: the line breaks may not show.`,
		});
	return out;
}

/** Layout of one text in a rendered composition frame (the host page's text probe, mg-host/text-probe.ts). */
export type MgTextMeasurement = {
	/** Caller's id (the text's prop path). */
	id: string;
	/** The text was found in the page (its characters, ignoring whitespace, case and `*_~` markup). */
	found: boolean;
	/** Found and drawn at this frame (not transparent, not hidden). */
	visible: boolean;
	/** Union of the text's boxes, composition pixels. */
	rect: { x: number; y: number; width: number; height: number } | null;
	/** Line boxes (one per rendered line). */
	lines: { x: number; y: number; width: number; height: number }[];
	/** The box of the nearest ancestor that clips the text (overflow hidden/clip), when the text exceeds it. */
	clippedBy: { x: number; y: number; width: number; height: number } | null;
	/** An ancestor shows an ellipsis because the text does not fit. */
	truncated: boolean;
	/** Computed style of the text's element (for the on-canvas editor). */
	style: {
		fontFamily: string;
		fontSize: number;
		fontWeight: string;
		fontStyle: string;
		color: string;
		lineHeight: number | null;
		letterSpacing: number;
		textAlign: string;
		textTransform: string;
		whiteSpace: string;
	} | null;
};

/** Layout checks of a measured text (S08:MGC-037): off frame, clipped, outside its safe box, extra lines. */
export function measuredTextIssues(
	layer: CompositionTextLayer,
	m: MgTextMeasurement,
	frame: { width: number; height: number },
): TextIssue[] {
	const q = `«${layer.label}»`;
	if (!m.found || !m.rect)
		return [
			{
				code: 'MG_TEXT_NOT_FOUND',
				severity: 'info',
				message: `${q} is not drawn at the checked frame${layer.frame !== undefined ? ` (${layer.frame})` : ''}; its layout cannot be checked.`,
			},
		];
	const out: TextIssue[] = [];
	// A clipped text is reported as clipped; what is left of it is checked against the frame and the box.
	const c = m.clippedBy;
	const r = c
		? (() => {
				const x = Math.max(m.rect.x, c.x);
				const y = Math.max(m.rect.y, c.y);
				const right = Math.min(m.rect.x + m.rect.width, c.x + c.width);
				const bottom = Math.min(m.rect.y + m.rect.height, c.y + c.height);
				return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
			})()
		: m.rect;
	const tol = 1;
	const over: string[] = [];
	if (r.x < -tol) over.push(`left by ${Math.round(-r.x)} px`);
	if (r.x + r.width > frame.width + tol) over.push(`right by ${Math.round(r.x + r.width - frame.width)} px`);
	if (r.y < -tol) over.push(`top by ${Math.round(-r.y)} px`);
	if (r.y + r.height > frame.height + tol)
		over.push(`bottom by ${Math.round(r.y + r.height - frame.height)} px`);
	if (over.length)
		out.push({
			code: 'MG_TEXT_OFF_FRAME',
			severity: 'warning',
			message: `${q} runs off the frame (${over.join(', ')}).`,
		});
	if (m.clippedBy)
		out.push({ code: 'MG_TEXT_CLIPPED', severity: 'warning', message: `${q} is cut off by its box.` });
	if (m.truncated)
		out.push({
			code: 'MG_TEXT_TRUNCATED',
			severity: 'warning',
			message: `${q} is shortened with an ellipsis.`,
		});
	const b = layer.box;
	if (
		b &&
		(r.x < b.x - tol ||
			r.y < b.y - tol ||
			r.x + r.width > b.x + b.width + tol ||
			r.y + r.height > b.y + b.height + tol)
	)
		out.push({
			code: 'MG_TEXT_OUTSIDE_BOX',
			severity: 'warning',
			message: `${q} goes outside its safe area (${Math.round(r.width)}×${Math.round(r.height)} px in a ${b.width}×${b.height} px box).`,
		});
	if (layer.maxLines !== undefined && m.lines.length > layer.maxLines)
		out.push({
			code: 'MG_TEXT_LINES',
			severity: 'warning',
			message: `${q} wraps to ${m.lines.length} lines (designed for ${layer.maxLines}).`,
		});
	return out;
}

// ---------------------------------------------------------------- edits (S08:MGC-038)

/** The colour of a text's accent spans: the declared CSS colour, or the value of the declared colour prop. */
export function textAccentColor(
	layer: Pick<CompositionTextLayer, 'accent'>,
	effective: Record<string, unknown>,
): string | null {
	const a = layer.accent;
	if (!a) return null;
	if (isCssColor(a)) return a;
	const v = getPropAt(effective, a.split('.'));
	return typeof v === 'string' && isCssColor(v) ? v : null;
}

/**
 * The accent markup of a value as runs (`*…*` = accent; an unclosed `*` runs to the end): offsets into the raw
 * string, the asterisks as `mark` runs. Concatenating the runs gives the value back.
 */
export function accentRuns(
	value: string,
): { start: number; end: number; kind: 'plain' | 'mark' | 'accent' }[] {
	const out: { start: number; end: number; kind: 'plain' | 'mark' | 'accent' }[] = [];
	let inside = false;
	let i = 0;
	while (i < value.length) {
		if (value[i] === '*') {
			out.push({ start: i, end: i + 1, kind: 'mark' });
			inside = !inside;
			i++;
			continue;
		}
		let j = i;
		while (j < value.length && value[j] !== '*') j++;
		out.push({ start: i, end: j, kind: inside ? 'accent' : 'plain' });
		i = j;
	}
	return out;
}

/** The current value of a text (effective props), '' when unset or not a string. */
export function textLayerValue(effective: Record<string, unknown>, layer: CompositionTextLayer): string {
	const v = getPropAt(effective, layer.path);
	return typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v);
}

export type TextEdit = { path: readonly string[]; value: unknown };

/**
 * New props overrides with several values written at once (texts and their style props): one `clip.update`
 * = one History step. Containers are copied from the effective props so siblings keep their values.
 */
export function overridesWithEdits(
	defaults: Record<string, unknown> | undefined,
	overrides: Record<string, unknown>,
	edits: readonly TextEdit[],
): Record<string, unknown> {
	let next = overrides;
	for (const e of edits) next = setPropOverride(next, mergeProps(defaults, next), e.path, e.value);
	return next;
}

/** Validates one prospective value against the composition schema (issues as errors, for live editors). */
export function validateTextEdit(
	info: Pick<MgCompositionInfo, 'propsSchema' | 'defaultProps'>,
	overrides: Record<string, unknown>,
	edits: readonly TextEdit[],
): string[] {
	if (!info.propsSchema) return [];
	const effective = mergeProps(info.defaultProps, overridesWithEdits(info.defaultProps, overrides, edits));
	return validateJsonSchema(info.propsSchema as JsonSchemaNode, effective).map(
		(i) => `${i.path}: ${i.message}`,
	);
}
