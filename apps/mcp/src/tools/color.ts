import { existsSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import {
	type Animatable,
	type Clip,
	clipContentTime,
	defaultEffectRegistry,
	type EffectInstance,
	type EffectSpec,
	evaluate,
	isColorEffect,
	isKnownClipKind,
	kindCapabilities,
	LUMETRI_EFFECT_ID,
	LUMETRI_PARAMS,
	MAX_CURVE_POINTS,
	type MediaAsset,
	normalizeCurve,
	type ParamSpec,
	type ProjectDocument,
	type Rational,
	retimeKeyframes,
	sequenceTimecode,
} from '@jasper/project';
import { z } from 'zod';
import {
	DESTRUCTIVE,
	defineTool,
	EDIT,
	findClip,
	frameOf,
	loadDoc,
	READ_ONLY,
	requireOk,
	type ToolContext,
	transact,
} from '../context.ts';
import { jsonResult, ToolError } from '../errors.ts';
import { mediaRegisterCommand } from '../media.ts';
import { timeArg } from './editing.ts';
import { ProjectIdArg } from './projects.ts';

// ---------------------------------------------------------------- the grade_clip shape ↔ Lumetri params

type GradeSection = 'basic' | 'creative' | 'curves' | 'wheels';

/** grade_clip / get_grade field → `jasper.lumetri` param name (S06:CG-002 is the contract). */
const GRADE_FIELDS: readonly { section: GradeSection; key: string; param: string }[] = [
	{ section: 'basic', key: 'inputLut', param: 'inputLut' },
	{ section: 'basic', key: 'temperature', param: 'temperature' },
	{ section: 'basic', key: 'tint', param: 'tint' },
	{ section: 'basic', key: 'exposure', param: 'exposure' },
	{ section: 'basic', key: 'contrast', param: 'contrast' },
	{ section: 'basic', key: 'highlights', param: 'highlights' },
	{ section: 'basic', key: 'shadows', param: 'shadows' },
	{ section: 'basic', key: 'whites', param: 'whites' },
	{ section: 'basic', key: 'blacks', param: 'blacks' },
	{ section: 'basic', key: 'saturation', param: 'saturation' },
	{ section: 'creative', key: 'look', param: 'look' },
	{ section: 'creative', key: 'intensity', param: 'lookIntensity' },
	{ section: 'creative', key: 'vibrance', param: 'vibrance' },
	{ section: 'curves', key: 'master', param: 'curveMaster' },
	{ section: 'curves', key: 'red', param: 'curveRed' },
	{ section: 'curves', key: 'green', param: 'curveGreen' },
	{ section: 'curves', key: 'blue', param: 'curveBlue' },
	{ section: 'wheels', key: 'shadows', param: 'shadowsWheel' },
	{ section: 'wheels', key: 'midtones', param: 'midtonesWheel' },
	{ section: 'wheels', key: 'highlights', param: 'highlightsWheel' },
	{ section: 'wheels', key: 'shadowsLevel', param: 'shadowsLevel' },
	{ section: 'wheels', key: 'midtonesLevel', param: 'midtonesLevel' },
	{ section: 'wheels', key: 'highlightsLevel', param: 'highlightsLevel' },
];

function lumetriParam(name: string): ParamSpec {
	const p = LUMETRI_PARAMS.find((x) => x.name === name);
	if (!p) throw new Error(`jasper.lumetri has no parameter ${name}`);
	return p;
}

const fmt = (x: unknown) => (typeof x === 'number' ? String(x) : JSON.stringify(x));

/** "−100…100, default 0" style range text of a numeric param (from the registry). */
function rangeText(p: ParamSpec): string {
	const unit = p.unit === '%' ? ' %' : p.unit ? ` ${p.unit}` : '';
	return `${p.range?.min ?? '−∞'}…${p.range?.max ?? '∞'}${unit}, default ${fmt(p.default)}`;
}

const FIELD_HELP: Record<string, string> = {
	inputLut: 'LUT applied first at full strength (e.g. a camera log → Rec.709 LUT)',
	temperature: 'white balance, + warmer (red), − cooler (blue)',
	tint: 'white balance, + magenta, − green',
	exposure: 'stops of linear light (+1 doubles it)',
	contrast: 'around mid-grey',
	highlights: 'bright zone, + brighter / − darker',
	shadows: 'dark zone, + brighter / − darker',
	whites: 'white point',
	blacks: 'black point',
	saturation: '0 = monochrome, 100 = unchanged',
	look: 'creative LUT, mixed with intensity',
	lookIntensity: 'mix of the look LUT',
	vibrance: 'saturation that spares already saturated colours',
	curveMaster: 'tone curve on all channels',
	curveRed: 'red channel curve',
	curveGreen: 'green channel curve',
	curveBlue: 'blue channel curve',
	shadowsWheel: 'lift: hue/amount pushed into the shadows',
	midtonesWheel: 'gamma: hue/amount pushed into the midtones',
	highlightsWheel: 'gain: hue/amount pushed into the highlights',
	shadowsLevel: 'lift level (darker/brighter shadows)',
	midtonesLevel: 'gamma level (darker/brighter midtones)',
	highlightsLevel: 'gain level (darker/brighter highlights)',
};

const CurvePointsArg = z
	.array(z.tuple([z.number(), z.number()]))
	.min(2)
	.max(MAX_CURVE_POINTS)
	.nullable();

/** The zod schema of one grade field, derived from the Lumetri param spec. */
function fieldSchema(param: string): z.ZodType {
	const p = lumetriParam(param);
	const help = FIELD_HELP[param] ? `${FIELD_HELP[param]}. ` : '';
	switch (p.type) {
		case 'number':
			return z
				.number()
				.describe(`${p.label}: ${help}${rangeText(p)}; out-of-range values are clamped`)
				.optional();
		case 'media':
			return z
				.string()
				.min(1)
				.nullable()
				.describe(`${p.label}: ${help}LUT mediaId from import_lut (or its Project item name); null = none`)
				.optional();
		case 'curve':
			return CurvePointsArg.describe(
				`${p.label}: ${help}[[x, y], …] control points in 0…1 (input → output), 2–${MAX_CURVE_POINTS} points, identity [[0,0],[1,1]]; monotone cubic through the points, flat outside the first/last; values are clamped to 0…1 and sorted; null = reset to identity`,
			).optional();
		case 'vec2':
			return z
				.tuple([z.number(), z.number()])
				.describe(
					`${p.label}: ${help}[x, y] in the unit disc (angle = hue: 0° red, 120° green, 240° blue; length = amount), default [0, 0]; longer vectors are scaled to length 1`,
				)
				.optional();
		default:
			return z.unknown().optional();
	}
}

function sectionSchema(section: GradeSection, what: string) {
	const shape: Record<string, z.ZodType> = {};
	for (const f of GRADE_FIELDS) if (f.section === section) shape[f.key] = fieldSchema(f.param);
	return z.strictObject(shape).optional().describe(what);
}

/** grade_clip input. */
const GradeClipInput = {
	projectId: ProjectIdArg,
	clipId: z.string().min(1).describe('Clip id ("clp_…") of a visual clip (video, still, title, graphic…)'),
	basic: sectionSchema('basic', 'Basic Correction (steps 1–7 of the order of operations)'),
	creative: sectionSchema('creative', 'Creative: look LUT + intensity, vibrance (steps 8–9)'),
	curves: sectionSchema('curves', 'RGB curves (step 10)'),
	wheels: sectionSchema('wheels', 'Colour wheels lift/gamma/gain with their levels (step 11)'),
	instance: z
		.enum(['first', 'new'])
		.optional()
		.describe(
			"first (default): edit the clip's first Lumetri Color instance (added when it has none); new: add another instance at the end of the stack (a stacked grade)",
		),
	at: timeArg(
		'Only for params that are already keyframed: the time (inside the clip) where the value is set as a keyframe; default the editor playhead when it is on the clip',
	).optional(),
};
type Clamped = { field: string; given: unknown; applied: unknown };

/**
 * Validates and clamps the grade sections to the registry ranges: numbers to [min, max], curves normalised
 * (clamped to 0…1, sorted, one point per x), wheel vectors scaled into the unit disc. LUT references stay
 * `{lutRef}` until `resolveLutRefs`. Returns the values keyed by param name and what had to be clamped.
 */
function normalizeGrade(args: Partial<Record<GradeSection, Record<string, unknown> | undefined>>): {
	params: Record<string, unknown>;
	clamped: Clamped[];
} {
	const params: Record<string, unknown> = {};
	const clamped: Clamped[] = [];
	for (const f of GRADE_FIELDS) {
		const raw = args[f.section]?.[f.key];
		if (raw === undefined) continue;
		const p = lumetriParam(f.param);
		const field = `${f.section}.${f.key}`;
		switch (p.type) {
			case 'number': {
				if (typeof raw !== 'number' || !Number.isFinite(raw))
					throw new ToolError('E_INVALID_PARAM', `${field} must be a number (${rangeText(p)})`);
				const v = Math.min(
					p.range?.max ?? Number.POSITIVE_INFINITY,
					Math.max(p.range?.min ?? Number.NEGATIVE_INFINITY, raw),
				);
				if (v !== raw) clamped.push({ field, given: raw, applied: v });
				params[f.param] = v;
				break;
			}
			case 'media':
				params[f.param] = { lutRef: raw === null || raw === '' ? null : String(raw) };
				break;
			case 'curve': {
				if (raw === null) {
					params[f.param] = JSON.parse(JSON.stringify(p.default));
					break;
				}
				const pts = normalizeCurve(raw as number[][]);
				if (!pts)
					throw new ToolError(
						'E_INVALID_PARAM',
						`${field} needs at least two points with different x in 0…1`,
						'Example: [[0, 0], [0.25, 0.2], [0.75, 0.8], [1, 1]] (a gentle S-curve).',
					);
				const given = raw as number[][];
				if (pts.length !== given.length || pts.some((q, i) => q[0] !== given[i]![0] || q[1] !== given[i]![1]))
					clamped.push({ field, given: raw, applied: pts });
				params[f.param] = { curve: pts };
				break;
			}
			case 'vec2': {
				const [x, y] = raw as [number, number];
				const m = Math.hypot(x, y);
				const v: [number, number] = m > 1 ? [x / m, y / m] : [x, y];
				if (m > 1) clamped.push({ field, given: raw, applied: v });
				params[f.param] = v;
				break;
			}
		}
	}
	return { params, clamped };
}

const lutMedia = (doc: ProjectDocument) => Object.values(doc.media).filter((m) => m.kind === 'lut');

function itemNameOf(doc: ProjectDocument, mediaId: string): string | undefined {
	for (const item of Object.values(doc.items))
		if (item.kind === 'media' && item.mediaId === mediaId) return item.name;
	return undefined;
}

/** A LUT by mediaId, Project item name or file name; throws a ToolError naming the available LUTs. */
function resolveLut(doc: ProjectDocument, ref: string): MediaAsset {
	const byId = doc.media[ref];
	const found =
		byId ??
		lutMedia(doc).find((m) => itemNameOf(doc, m.id) === ref) ??
		lutMedia(doc).find((m) => m.originalName === ref);
	const available = lutMedia(doc)
		.map((m) => `${m.id} (${itemNameOf(doc, m.id) ?? m.originalName})`)
		.join(', ');
	if (!found)
		throw new ToolError(
			'E_NOT_FOUND',
			`No LUT "${ref}" in this project`,
			available ? `Available LUTs: ${available}.` : 'Import the .cube file with import_lut first.',
		);
	if (found.kind !== 'lut')
		throw new ToolError(
			'E_INVALID_PARAM',
			`${ref} is a ${found.kind} asset, not a LUT`,
			available ? `Available LUTs: ${available}.` : 'Import the .cube file with import_lut first.',
		);
	return found;
}

/** Replaces `{lutRef}` placeholders with `{mediaId}` param values (`''` = none). */
function resolveLutRefs(doc: ProjectDocument, params: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(params)) {
		if (v && typeof v === 'object' && 'lutRef' in v) {
			const ref = (v as { lutRef: string | null }).lutRef;
			out[k] = { mediaId: ref === null ? '' : resolveLut(doc, ref).id };
		} else out[k] = v;
	}
	return out;
}

// ---------------------------------------------------------------- document helpers

const effectsOf = (clip: Clip): EffectInstance[] => (clip as { effects?: EffectInstance[] }).effects ?? [];

/** Visual clips that take effects can carry a grade (the same rule as the Lumetri panel). */
function gradeEligible(clip: Clip): boolean {
	if (!isKnownClipKind(clip.kind)) return false;
	const caps = kindCapabilities(clip.kind);
	return !!caps?.visual && !!caps.supportsEffects;
}

function requireEligible(clip: Clip): void {
	if (!gradeEligible(clip))
		throw new ToolError(
			'E_INVALID_PARAM',
			`${clip.kind} clip ${clip.id} cannot be graded`,
			'Grade video, still, title, graphic or colour-matte clips (not audio clips).',
		);
}

function isColorInstance(fx: EffectInstance): boolean {
	return isColorEffect(defaultEffectRegistry.get(fx.effectId, fx.effectVersion));
}

const round = (x: number, d = 3) => {
	const k = 10 ** d;
	return Math.round(x * k) / k;
};

function tidy(v: unknown): unknown {
	if (typeof v === 'number') return round(v);
	if (Array.isArray(v)) return v.map((x) => (typeof x === 'number' ? round(x, 4) : tidy(x)));
	if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, tidy(x)]));
	return v;
}

/** Content time of a sequence frame for a clip, the frame clamped to the clip's visible frames. */
function contentTimeAt(
	clip: Clip,
	frame: number,
	rate: Rational,
): { time: number; frame: number; outside: boolean } {
	const f = Math.min(clip.start + clip.duration - 1, Math.max(clip.start, frame));
	return { time: clipContentTime(clip, f, rate), frame: f, outside: f !== frame };
}

/** Params of an effect instance evaluated at content time `t` (missing params take the registry default). */
function evaluateEffect(fx: EffectInstance, spec: EffectSpec, t: number): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const p of spec.params) {
		const anim = fx.params[p.name] as Animatable<unknown> | undefined;
		out[p.name] = anim ? evaluate(anim, t, { holdOnly: !p.animatable }) : p.default;
	}
	return out;
}

const animatedParams = (fx: EffectInstance) =>
	Object.entries(fx.params)
		.filter(([, a]) => (a as Animatable<unknown>).keyframes?.length > 0)
		.map(([k]) => k);

type LutView = {
	param: string;
	mediaId: string;
	name: string;
	title?: string;
	size?: number;
	missing?: true;
};

function lutView(doc: ProjectDocument, param: string, value: unknown): LutView | null {
	const id = (value as { mediaId?: unknown } | null)?.mediaId;
	if (typeof id !== 'string' || !id) return null;
	const m = doc.media[id];
	if (!m) return { param, mediaId: id, name: id, missing: true };
	return {
		param,
		mediaId: id,
		name: itemNameOf(doc, id) ?? m.originalName,
		...(m.lut?.title ? { title: m.lut.title } : {}),
		...(m.lut?.size ? { size: m.lut.size } : {}),
	};
}

/** Evaluated Lumetri params in the grade_clip shape (LUTs as mediaId or null, curves as point arrays). */
function lumetriGradeView(values: Record<string, unknown>): Record<GradeSection, Record<string, unknown>> {
	const out = { basic: {}, creative: {}, curves: {}, wheels: {} } as Record<
		GradeSection,
		Record<string, unknown>
	>;
	for (const f of GRADE_FIELDS) {
		const v = values[f.param];
		const p = lumetriParam(f.param);
		out[f.section][f.key] =
			p.type === 'media'
				? (v as { mediaId?: string } | null)?.mediaId || null
				: p.type === 'curve'
					? tidy((v as { curve?: unknown } | null)?.curve ?? null)
					: tidy(v);
	}
	return out;
}

// ---------------------------------------------------------------- copy_grade

/**
 * copy_grade commands: every target's colour effects are removed and the source's colour effects (stack
 * order, bypass state, keyframes re-timed) are inserted where the target's first colour effect was (appended
 * when it had none). Non-colour effects stay where they are. Params unknown to the effect spec are dropped.
 */
function planCopyGrade(
	doc: ProjectDocument,
	fromClipId: string,
	toClipIds: readonly string[],
): { commands: unknown[]; refs: { clipId: string; ref: string; effectId: string }[]; removed: number } {
	const src = findClip(doc, fromClipId);
	const grade = effectsOf(src.clip).filter(isColorInstance);
	if (!grade.length)
		throw new ToolError(
			'E_INVALID_PARAM',
			`Clip ${fromClipId} has no colour effects to copy`,
			'Grade it first (grade_clip) or pick another source clip (get_grade shows what a clip has).',
		);
	const commands: unknown[] = [];
	const refs: { clipId: string; ref: string; effectId: string }[] = [];
	let removed = 0;
	const seen = new Set<string>();
	for (const clipId of toClipIds) {
		if (seen.has(clipId)) continue;
		seen.add(clipId);
		if (clipId === fromClipId)
			throw new ToolError(
				'E_INVALID_PARAM',
				'toClipIds must not contain the source clip',
				'Remove it from toClipIds.',
			);
		const dst = findClip(doc, clipId);
		requireEligible(dst.clip);
		const rate = dst.seq.settings.frameRate as Rational;
		const effects = effectsOf(dst.clip);
		const firstColor = effects.findIndex(isColorInstance);
		const at = firstColor < 0 ? effects.length : firstColor;
		for (const fx of effects)
			if (isColorInstance(fx)) {
				commands.push({ type: 'effect.remove', effectInstanceId: fx.id });
				removed++;
			}
		grade.forEach((fx, i) => {
			const spec = defaultEffectRegistry.get(fx.effectId, fx.effectVersion)!;
			const params: Record<string, unknown> = {};
			for (const p of spec.params) {
				const a = fx.params[p.name] as Animatable<unknown> | undefined;
				if (!a) continue;
				params[p.name] = {
					value: a.value,
					keyframes: retimeKeyframes(a.keyframes, src.clip, dst.clip, rate).map((k) => ({
						time: k.time,
						value: k.value,
						interpolation: k.interpolation,
						easeIn: k.easeIn,
						easeOut: k.easeOut,
					})),
				};
			}
			const ref = `$grade_${refs.length}`;
			refs.push({ clipId, ref, effectId: fx.effectId });
			commands.push({
				type: 'effect.add',
				target: { clipId },
				effectId: fx.effectId,
				index: at + i,
				params,
				ref,
			});
			if (!fx.enabled) commands.push({ type: 'effect.setEnabled', effectInstanceId: ref, enabled: false });
		});
	}
	return { commands, refs, removed };
}

// ---------------------------------------------------------------- guide

const ORDER =
	'Order of operations inside one Lumetri Color instance: 1 input LUT, 2 white balance (temperature/tint, linear light), 3 exposure, 4 contrast, 5 highlights/shadows, 6 whites/blacks, 7 saturation, 8 look LUT × intensity, 9 vibrance, 10 curves (master, then R/G/B), 11 wheels (lift/gamma/gain), 12 clamp. Several colour effects on a clip run top to bottom.';

/** Appended to the server instructions (EDITING_GUIDE). */
export const COLOR_GUIDE = `Colour grading (Lumetri Color):
- grade_clip sets any subset of the grade in one undoable step: basic (exposure in stops −5…5, saturation 0…200 %, the others −100…100), creative (look LUT + intensity 0…100 %, vibrance), curves ([[x,y],…] in 0…1) and wheels ([x,y] in the unit disc, levels −100…100). Unspecified params keep their values. Start with small moves (exposure ±0.5, contrast ±20, temperature ±15).
- ${ORDER}
- LUTs: import_lut with a .cube path → mediaId; use it as basic.inputLut (technical/log conversion) or creative.look (creative look). null removes it.
- get_grade reads a clip's colour effects (evaluated at the playhead or a time); copy_grade matches other clips to it.
- Always check the result with render_frame at a time inside the clip (and compare with an ungraded frame if unsure).`;

// ---------------------------------------------------------------- tools

function checkFile(path: string): void {
	if (!isAbsolute(path))
		throw new ToolError(
			'NOT_ABSOLUTE',
			`Not an absolute path: ${path}`,
			'Pass the absolute path of the .cube file.',
		);
	if (!existsSync(path) || !statSync(path).isFile())
		throw new ToolError('FILE_NOT_FOUND', `No such file on this machine: ${path}`, 'Check the path.');
}

/** The editor playhead when an editor has the project open and shows this clip's sequence, else null. */
async function livePlayhead(ctx: ToolContext, projectId: string, seqId: string): Promise<number | null> {
	try {
		const q = await ctx.engine((c) => c.agentQuery({ projectId, query: 'playhead.get', args: {} }));
		const r = q.result as { sequenceId?: string | null; frame?: number } | undefined;
		if (r && typeof r.frame === 'number' && (!r.sequenceId || r.sequenceId === seqId)) return r.frame;
	} catch {
		// No editor session (headless): no playhead.
	}
	return null;
}

export function registerColorTools(ctx: ToolContext): void {
	defineTool(
		ctx,
		'import_lut',
		{
			title: 'Import LUT',
			description:
				'Imports a colour lookup table (.cube file: 3D or 1D, Adobe/Resolve dialect) into a project by absolute path. Returns its mediaId, lattice size and title; use the mediaId as grade_clip basic.inputLut or creative.look. An invalid file fails with the parser message including the line number. LUTs cannot be placed on the timeline.',
			input: {
				projectId: ProjectIdArg,
				path: z
					.string()
					.min(1)
					.describe('Absolute path of the .cube file, e.g. "/home/me/luts/teal-orange.cube"'),
			},
			annotations: { ...EDIT, idempotentHint: false },
		},
		async ({ projectId, path }, extra) => {
			checkFile(path);
			const reg = await ctx.engine((c) => c.registerMedia({ projectId, paths: [path] }));
			const err = reg.errors[0];
			if (err)
				throw new ToolError(
					err.code,
					err.message,
					err.code === 'INVALID_LUT'
						? 'The file is not a valid .cube LUT; fix the reported line or export the LUT again (.cube, LUT_3D_SIZE ≤ 256).'
						: 'Check that the file is a readable .cube LUT.',
					{ path },
				);
			const item = reg.items[0];
			if (!item) throw new ToolError('INTERNAL', 'The engine registered nothing');
			if (item.kind !== 'lut' || !item.lut)
				throw new ToolError(
					'NOT_A_LUT',
					`${path} is a ${item.kind} file, not a LUT`,
					'Use import_media for video, audio and images; import_lut takes .cube files.',
				);
			const res = await transact(
				ctx,
				projectId,
				{ label: 'Import LUT', commands: [mediaRegisterCommand(item, '$lut', '$item')] },
				extra,
			);
			const r = requireOk(res);
			const out = r.results[0] as { mediaId?: string; itemId?: string; deduped?: boolean } | undefined;
			return jsonResult({
				mediaId: out?.mediaId ?? r.refs.$lut,
				itemId: out?.itemId ?? r.refs.$item,
				name: item.originalName,
				size: item.lut.size,
				dimensions: item.lut.dimensions,
				title: item.lut.title ?? null,
				...(out?.deduped ? { deduped: true } : {}),
				revision: r.revision,
				appliedBy: res.appliedBy,
			});
		},
	);

	const params = (section: GradeSection) =>
		GRADE_FIELDS.filter((f) => f.section === section)
			.map((f) => {
				const p = lumetriParam(f.param);
				return p.type === 'number'
					? `${f.key} ${p.range?.min}…${p.range?.max}${p.unit === '%' ? ' %' : ''} (${fmt(p.default)})`
					: f.key;
			})
			.join(', ');

	defineTool(
		ctx,
		'grade_clip',
		{
			title: 'Grade clip',
			description: `Colour-grades a clip with a Lumetri Color effect (jasper.lumetri) in ONE transaction (one "Agent: Grade clip" History entry). Edits the clip's first Lumetri instance, adding one when it has none (instance "new" always adds another). Only the params you pass change; the rest keep their values. Ranges (default): basic: ${params('basic')}; creative: ${params('creative')}; curves: ${params('curves')} as [[x,y],…] in 0…1; wheels: ${params('wheels')} with wheels as [x,y] in the unit disc. Out-of-range values are clamped and reported. LUT fields take a mediaId from import_lut (or null for none). ${ORDER} Params that already have keyframes get a keyframe at \`at\` (or the editor playhead on the clip) instead of a new static value; without either the call is rejected. Returns the effect instance id and the applied values; check the result with render_frame.`,
			input: GradeClipInput,
			annotations: EDIT,
		},
		async (args, extra) => {
			const { params: pending, clamped } = normalizeGrade(args);
			const names = Object.keys(pending);
			const instance = args.instance ?? 'first';
			const { doc, live } = await loadDoc(ctx, args.projectId);
			const { seq, clip } = findClip(doc, args.clipId);
			requireEligible(clip);
			const values = resolveLutRefs(doc, pending);
			const existing =
				instance === 'first' ? effectsOf(clip).find((e) => e.effectId === LUMETRI_EFFECT_ID) : undefined;
			if (!names.length && existing)
				throw new ToolError(
					'E_INVALID_PARAM',
					'Nothing to change',
					'Pass at least one of basic, creative, curves or wheels (get_grade shows the current grade).',
				);
			const commands: unknown[] = [];
			const keyframed: string[] = [];
			let frame: number | null = null;
			if (!existing) {
				commands.push({
					type: 'effect.add',
					target: { clipId: clip.id },
					effectId: LUMETRI_EFFECT_ID,
					...(names.length ? { params: values } : {}),
					ref: '$grade',
				});
			} else {
				const animated = names.filter(
					(n) => (existing.params[n] as Animatable<unknown> | undefined)?.keyframes?.length,
				);
				if (animated.length) {
					if (args.at !== undefined) frame = frameOf(seq, args.at);
					else if (live) frame = await livePlayhead(ctx, args.projectId, seq.id);
					const end = clip.start + clip.duration;
					if (frame === null || frame < clip.start || frame >= end)
						throw new ToolError(
							'E_INVALID_PARAM',
							`${animated.join(', ')} ${animated.length === 1 ? 'is' : 'are'} keyframed on this clip; ${frame === null ? 'say where to set the value' : `frame ${frame} is outside the clip (frames ${clip.start}–${end - 1})`}`,
							`Pass "at" with a time inside the clip (frames ${clip.start}–${end - 1}) to set a keyframe there, or remove the animation first with apply_commands param.setAnimated {target: ["effect", "${existing.id}", "<param>"], animated: false}.`,
						);
					keyframed.push(...animated);
				}
				for (const n of names)
					commands.push({
						type: 'param.set',
						target: ['effect', existing.id, n],
						value: values[n],
						...(keyframed.includes(n) && frame !== null ? { at: { sequenceFrame: frame } } : {}),
					});
			}
			const res = await transact(ctx, args.projectId, { label: 'Grade clip', commands }, extra);
			const r = requireOk(res);
			const applied: Partial<Record<GradeSection, Record<string, unknown>>> = {};
			for (const f of GRADE_FIELDS) {
				if (!(f.param in values)) continue;
				const v = values[f.param];
				applied[f.section] ??= {};
				applied[f.section]![f.key] =
					f.section === 'curves'
						? (v as { curve: unknown }).curve
						: v && typeof v === 'object' && 'mediaId' in v
							? (v as { mediaId: string }).mediaId || null
							: v;
			}
			return jsonResult({
				ok: true,
				clipId: clip.id,
				effectInstanceId: existing?.id ?? r.refs.$grade,
				created: !existing,
				applied,
				...(clamped.length ? { clamped } : {}),
				...(keyframed.length && frame !== null
					? { keyframed: { params: keyframed, frame, timecode: sequenceTimecode(seq, frame) } }
					: {}),
				revision: r.revision,
				appliedBy: res.appliedBy,
				...(r.warnings.length
					? { warnings: r.warnings.map((w) => ({ code: w.code, message: w.message })) }
					: {}),
			});
		},
	);

	defineTool(
		ctx,
		'get_grade',
		{
			title: 'Get grade',
			description:
				"Every colour effect of a clip in stack (processing) order — Lumetri Color instances in the grade_clip shape (basic, creative, curves, wheels) and the simple colour effects (Brightness & Contrast, Hue/Saturation, Black & White) with their params — evaluated at `at` when given, else at the editor playhead when it is on the clip, else at the clip's first frame. Includes bypass state, which params are keyframed and the names/sizes of referenced LUTs.",
			input: {
				projectId: ProjectIdArg,
				clipId: z.string().min(1).describe('Clip id ("clp_…")'),
				at: timeArg(
					'Evaluate at this time (default: the playhead when on the clip, else the clip start)',
				).optional(),
			},
			annotations: READ_ONLY,
		},
		async ({ projectId, clipId, at }) => {
			const { doc, live } = await loadDoc(ctx, projectId);
			const { seq, clip } = findClip(doc, clipId);
			const rate = seq.settings.frameRate as Rational;
			let frame: number;
			let source: 'argument' | 'playhead' | 'clip-start';
			if (at !== undefined) {
				frame = frameOf(seq, at);
				source = 'argument';
			} else {
				const ph = live ? await livePlayhead(ctx, projectId, seq.id) : null;
				if (ph !== null && ph >= clip.start && ph < clip.start + clip.duration) {
					frame = ph;
					source = 'playhead';
				} else {
					frame = clip.start;
					source = 'clip-start';
				}
			}
			const t = contentTimeAt(clip, frame, rate);
			const effects = effectsOf(clip)
				.map((fx, stackIndex) => ({ fx, stackIndex }))
				.filter(({ fx }) => isColorInstance(fx))
				.map(({ fx, stackIndex }) => {
					const spec = defaultEffectRegistry.get(fx.effectId, fx.effectVersion)!;
					const values = evaluateEffect(fx, spec, t.time);
					const luts = spec.params
						.filter((p) => p.type === 'media')
						.map((p) => lutView(doc, p.name, values[p.name]))
						.filter((x): x is LutView => x !== null);
					const animated = animatedParams(fx);
					return {
						effectInstanceId: fx.id,
						effectId: fx.effectId,
						label: spec.label,
						stackIndex,
						...(fx.enabled ? {} : { enabled: false }),
						...(fx.effectId === LUMETRI_EFFECT_ID
							? lumetriGradeView(values)
							: { params: tidy(values) as Record<string, unknown> }),
						...(animated.length ? { keyframed: animated } : {}),
						...(luts.length ? { luts } : {}),
					};
				});
			return jsonResult({
				clipId: clip.id,
				clipName: clip.name,
				frame: t.frame,
				timecode: sequenceTimecode(seq, t.frame),
				evaluatedAt: source,
				...(t.outside ? { note: `Frame ${frame} is outside the clip; evaluated at its nearest frame.` } : {}),
				effects,
				...(effects.length
					? {}
					: { hint: 'No colour effects on this clip; grade_clip adds a Lumetri Color grade.' }),
			});
		},
	);

	defineTool(
		ctx,
		'copy_grade',
		{
			title: 'Copy grade',
			description:
				"Copies all colour effects of one clip (Lumetri Color instances and the simple colour effects, in stack order, with bypass state and keyframes — keyframes keep their offset from the clip start) to other clips in ONE transaction. Policy: each target's existing colour effects are REPLACED (removed, the copies go where its first colour effect was, else at the end); its other effects (crop, blur, transform…) are untouched. The source must have at least one colour effect.",
			input: {
				projectId: ProjectIdArg,
				fromClipId: z.string().min(1).describe('Clip whose grade is copied'),
				toClipIds: z.array(z.string().min(1)).min(1).max(500).describe('Clips that receive the grade'),
			},
			annotations: DESTRUCTIVE,
		},
		async ({ projectId, fromClipId, toClipIds }, extra) => {
			const { doc } = await loadDoc(ctx, projectId);
			const plan = planCopyGrade(doc, fromClipId, toClipIds);
			const n = new Set(toClipIds).size;
			const res = await transact(
				ctx,
				projectId,
				{ label: n > 1 ? `Copy grade (${n} clips)` : 'Copy grade', commands: plan.commands },
				extra,
			);
			const r = requireOk(res);
			const targets: Record<string, { effectInstanceId: string; effectId: string }[]> = {};
			for (const x of plan.refs)
				(targets[x.clipId] ??= []).push({ effectInstanceId: r.refs[x.ref]!, effectId: x.effectId });
			return jsonResult({
				ok: true,
				fromClipId,
				targets: Object.entries(targets).map(([clipId, effects]) => ({ clipId, effects })),
				replacedEffects: plan.removed,
				revision: r.revision,
				appliedBy: res.appliedBy,
			});
		},
	);
}
