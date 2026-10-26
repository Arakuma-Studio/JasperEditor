// Keyframe easing for agents (docs/wp-notes/easing.md § Easing commands, docs/wp-notes/mcp-cli.md § Easing and Trim
// Paths): read eases back (get_keyframe_eases, list_ease_presets) and apply them (apply_ease, transfer_ease,
// transfer_keyframe_values, set_keyframe_velocity, create_path_controller, cleanup_motion_path). Every edit is one
// keyframe.* command in one transaction = one undoable History entry.
import {
	BUILTIN_EASE_GROUPS,
	builtinEasePresets,
	type CubicEase,
	CubicEaseSchema,
	clipKeyframesQuery,
	copyEase,
	copyValues,
	defaultRegistries,
	EASE_SECTIONS,
	EASE_Y_LIMIT,
	type EaseClip,
	type EaseCurve,
	type EasePreset,
	formatCubicBezier,
	keyframeEasesView,
	MAX_EASE_POINTS,
	type MultiEase,
	MultiEaseSchema,
	matchEasePreset,
	type ProjectDocument,
	PropertyQueryError,
} from '@jasper/project';
import { z } from 'zod';
import { ProjectIdArg, timeArg } from '../arguments.ts';
import {
	DESTRUCTIVE_IDEMPOTENT,
	defineTool,
	EDIT,
	EDIT_IDEMPOTENT,
	type Extra,
	frameOf,
	READ_ONLY,
	requireOk,
	type ToolContext,
	transact,
	txBody,
} from '../context.ts';
import { jsonResult, ToolError } from '../errors.ts';

export const EASE_GUIDE = `Keyframe easing (curves, presets, velocity):
- Read eases back: get_clip_properties lists each key with the segment leaving it — ease "hold" | "linear" | "cubic-bezier(x1, y1, x2, y2)" and easePreset when it matches a built-in preset (roving keys: roving: true, their run is eased on its first key). get_keyframe_eases {keyframeIds | clipId + properties? + from? + to?} gives the detail: per key in / out side type, influence % and speed (property units per second; sequence px/s along the path for Motion points, layer px/s for effect points), per segment the cubic-bezier, its two side types, the matched preset and average speed, and for 3+ keys of a property the preset the whole run matches (span.preset, e.g. a bounce). Every number is what renders: a segment uses its first key's outgoing side and its last key's incoming side (inInterpolation); it is linear only when both are Linear, and a Linear side of a curved segment counts as influence 16.67 % at the average speed.
- list_ease_presets {group?}: built-in curves by group (basic, penner, overshoot, elastic, bounce, spring, material); cubic ones carry their cubic-bezier, multi ones a point count.
- apply_ease {keyframeIds | clipId + properties? + from? + to?, curve, sections?}: curve = a preset id ("basic.easy-ease", "bounce.out-3"), "cubic-bezier(0.25, 0.1, 0.25, 1)", a CSS keyword (linear, ease, ease-in, ease-out, ease-in-out), {x1, y1, x2, y2} (x in 0…1, y in −${EASE_Y_LIMIT}…${EASE_Y_LIMIT}) or {points: [{x, y, in?, out?}…]} from (0,0) to (1,1). sections per property: "middle" = between consecutive selected keys (default for 2+ keys), "in" = into the first selected key, "out" = after the last (default for one key: in + out).
- A cubic curve shapes each chosen segment exactly (its first key's outgoing side and its last key's incoming side become Bezier; segments you did not choose keep their shape). A multi-point curve (bounce, elastic, overshoot, spring… or points) REBUILDS the span first … last selected key of each property: the keys strictly inside are deleted and new keys are made at the curve's points (point properties keep their drawn path and may get extra keys). It needs 2+ keys per property with different first / last values and numeric values (not paths); pieces whose ends have equal values are made linear (W_EASE_FLAT_SEGMENT); hold-only properties are skipped (W_EASE_SKIPPED).
- transfer_ease {fromKeyframeIds, toKeyframeIds, sections?, mode?}: copies eases and pastes them in one step — one source key → both of its sides (types and eases) onto every target key, as keyframe.setInterpolation would set them (Auto Bezier re-derives its eases on the target, Continuous Bezier keeps equal speeds on both sides); 2+ keys → their segment curves onto the target segments in order (one curve → all); 3+ keys of one property also carry the whole run as a curve, applied like a multi-point apply_ease unless mode "segments". transfer_keyframe_values {fromKeyframeIds, toKeyframeIds} pastes values in order (property, then time), keeping times and eases.
- set_keyframe_velocity {keyframeId, side in|out|both, speed?, influence? %}: the numeric velocity editor (a segment whose value does not change cannot take a nonzero speed).
- Motion paths: create_path_controller {keyframeIds | clipId + from/to} makes Position between the first and last key follow its path at a "Path Progress" slider's 0…100 (the keys between rove; the slider is keyed with Easy Ease; animate it with param.set on the returned target); cleanup_motion_path {…, tolerance? px — layer px for effect points} makes the timing linear and removes keys the drawn path does not need.
- Verify with get_keyframe_eases (apply a preset, read back its preset id) and render_frames / render_frame. Each call is one undoable "Agent: …" History entry (undo reverts it).`;

const IdArg = z.string().min(1);
const MAX_SELECTED = 100_000;
/** Most keys get_keyframe_eases (and the read-back after an edit) describes in one answer. */
const MAX_VIEW_KEYS = 2000;

const SectionsArg = z
	.array(z.enum(EASE_SECTIONS))
	.min(1)
	.max(3)
	.describe(
		'Segments per property: "middle" (between consecutive selected keys; default for 2+ keys), "in" (into the first selected key), "out" (after the last). Default for one key: ["in", "out"]',
	);

const unitArg = z.number().min(0).max(1);
const progressArg = z.number().min(-EASE_Y_LIMIT).max(EASE_Y_LIMIT);
const handleArg = z.tuple([unitArg, progressArg]);

/** The curve argument of apply_ease (and, cubic only, animate_trim_paths). */
export const CurveArg = z.union([
	z
		.string()
		.min(1)
		.max(200)
		.describe(
			'A preset id or name (list_ease_presets, e.g. "basic.easy-ease", "bounce.out-3"), "cubic-bezier(x1, y1, x2, y2)" or a CSS keyword: linear, ease, ease-in, ease-out, ease-in-out',
		),
	z
		.strictObject({
			kind: z.literal('cubic').optional(),
			x1: unitArg,
			y1: progressArg,
			x2: unitArg,
			y2: progressArg,
		})
		.describe(`CSS cubic-bezier handles: x1, x2 in 0…1, y1, y2 in −${EASE_Y_LIMIT}…${EASE_Y_LIMIT}`),
	z
		.strictObject({
			kind: z.literal('multi').optional(),
			points: z
				.array(
					z.strictObject({
						x: unitArg,
						y: progressArg,
						in: handleArg.optional().describe('Handle toward the previous point, absolute [x, y]'),
						out: handleArg.optional().describe('Handle toward the next point, absolute [x, y]'),
					}),
				)
				.min(3)
				.max(MAX_EASE_POINTS),
		})
		.describe(
			`A multi-point curve: ${MAX_EASE_POINTS} points at most, first (0, 0), last (1, 1), x strictly increasing; missing handles are linear`,
		),
]);
export type CurveInput = z.infer<typeof CurveArg>;

/** CSS easing keywords → the built-in preset with the same timing. */
const CSS_KEYWORDS: Record<string, string> = {
	linear: 'basic.linear',
	ease: 'basic.ease',
	'ease-in': 'basic.ease-in',
	'ease-out': 'basic.ease-out',
	'ease-in-out': 'basic.ease-in-out',
};

const NUMBER_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
const CUBIC_RE = /^cubic-bezier\s*\(([^()]*)\)$/i;
const PRESET_HINT = 'list_ease_presets lists the preset ids; or give "cubic-bezier(x1, y1, x2, y2)".';

function invalidCurve(message: string, hint = PRESET_HINT): ToolError {
	return new ToolError('E_INVALID_PARAM', message, hint);
}

function zodMessage(e: z.ZodError): string {
	return e.issues.map((i) => `${i.path.length ? `${i.path.join('.')}: ` : ''}${i.message}`).join('; ');
}

function presetById(id: string): EasePreset | undefined {
	const all = builtinEasePresets();
	return all.find((p) => p.id === id) ?? all.find((p) => p.name.toLowerCase() === id.trim().toLowerCase());
}

/** A parsed curve argument: the curve, a History-friendly name and the preset it came from. */
export type ParsedCurve = { curve: EaseCurve; name: string; presetId?: string };

/**
 * Parses apply_ease's `curve`: a preset id or name, "cubic-bezier(x1, y1, x2, y2)", a CSS keyword, cubic handles
 * or multi-curve points. Malformed input is an E_INVALID_PARAM ToolError naming the problem (never a crash).
 */
export function parseCurveArg(input: unknown): ParsedCurve {
	if (typeof input === 'string') {
		const text = input.trim();
		const m = CUBIC_RE.exec(text);
		if (m) {
			const parts = m[1]!.split(',').map((s) => s.trim());
			if (parts.length !== 4 || parts.some((p) => !NUMBER_RE.test(p)))
				throw invalidCurve(
					`Invalid cubic-bezier "${text}": it takes four numbers, e.g. cubic-bezier(0.25, 0.1, 0.25, 1)`,
				);
			const [x1, y1, x2, y2] = parts.map(Number) as [number, number, number, number];
			const parsed = CubicEaseSchema.safeParse({ kind: 'cubic', x1, y1, x2, y2 });
			if (!parsed.success)
				throw invalidCurve(
					`Invalid cubic-bezier "${text}": ${zodMessage(parsed.error)} (x1, x2 must be in 0…1, y1, y2 in −${EASE_Y_LIMIT}…${EASE_Y_LIMIT})`,
				);
			const c = parsed.data as CubicEase;
			return { curve: c, name: formatCubicBezier(c) };
		}
		const lower = text.toLowerCase();
		const keyword = Object.hasOwn(CSS_KEYWORDS, lower) ? CSS_KEYWORDS[lower] : undefined;
		const preset = presetById(keyword ?? text);
		if (!preset) {
			const needle = text.toLowerCase();
			const near = builtinEasePresets()
				.filter((p) => p.id.includes(needle) || p.name.toLowerCase().includes(needle))
				.slice(0, 8)
				.map((p) => p.id);
			throw new ToolError(
				'E_INVALID_PARAM',
				`Unknown ease preset "${text}"`,
				near.length ? `Did you mean ${near.join(', ')}? ${PRESET_HINT}` : PRESET_HINT,
			);
		}
		return { curve: preset.curve, name: preset.name, presetId: preset.id };
	}
	if (input && typeof input === 'object' && 'points' in input) {
		const parsed = MultiEaseSchema.safeParse({ ...(input as object), kind: 'multi' });
		if (!parsed.success) throw invalidCurve(`Invalid multi-point curve: ${zodMessage(parsed.error)}`);
		return { curve: parsed.data as MultiEase, name: `Custom Curve (${parsed.data.points.length} points)` };
	}
	const parsed = CubicEaseSchema.safeParse({ ...(input as object), kind: 'cubic' });
	if (!parsed.success) throw invalidCurve(`Invalid cubic curve: ${zodMessage(parsed.error)}`);
	return { curve: parsed.data as CubicEase, name: formatCubicBezier(parsed.data as CubicEase) };
}

/** `parseCurveArg` for commands that take one cubic segment curve (Trim Paths animations). */
export function parseCubicCurveArg(input: unknown): ParsedCurve & { curve: CubicEase } {
	const p = parseCurveArg(input);
	if (p.curve.kind !== 'cubic')
		throw invalidCurve(
			`"${p.name}" is a multi-point curve (${p.curve.points.length} points); this takes one cubic curve`,
			'Pick a cubic preset (list_ease_presets: kind "cubic") or give "cubic-bezier(x1, y1, x2, y2)".',
		);
	return p as ParsedCurve & { curve: CubicEase };
}

/** The stored document (no expression binding: ease commands address stored keys by id). */
async function rawDoc(ctx: ToolContext, projectId: string): Promise<ProjectDocument> {
	const r = await ctx.engine((c) => c.agentQuery({ projectId, query: 'doc.get', args: {} }));
	const doc = r.result as ProjectDocument;
	if (!doc || typeof doc !== 'object' || !doc.sequences)
		throw new ToolError('INTERNAL', 'The engine returned no document');
	return doc;
}

const REGISTRIES = defaultRegistries();

/** Key selection arguments shared by the ease tools. */
const selectionShape = (defaultProperties: string) => ({
	keyframeIds: z
		.array(IdArg)
		.min(1)
		.max(MAX_SELECTED)
		.optional()
		.describe('Keyframe ids ("kf_…") from get_clip_properties / get_keyframe_eases'),
	clipId: z
		.string()
		.min(1)
		.optional()
		.describe('Instead of keyframeIds: select the keys of this clip (narrow with properties, from, to)'),
	properties: z
		.array(z.string().min(1))
		.min(1)
		.max(200)
		.optional()
		.describe(
			`With clipId: property keys or key prefixes as get_clip_properties lists them, e.g. ["opacity"], ["transform.position"], ["shape.items.shp_…"] (default: ${defaultProperties})`,
		),
	from: timeArg('With clipId: only keys at or after this sequence time').optional(),
	to: timeArg('With clipId: only keys at or before this sequence time').optional(),
});

type Selection = {
	keyframeIds?: string[];
	clipId?: string;
	properties?: string[];
	from?: unknown;
	to?: unknown;
};

/** Resolves a key selection to keyframe ids (document order is the commands' business). */
function selectedIds(doc: ProjectDocument, a: Selection, defaultProperties?: string[]): string[] {
	if (!!a.keyframeIds === !!a.clipId)
		throw new ToolError(
			'E_INVALID_PARAM',
			'Give keyframeIds, or clipId (with optional properties / from / to)',
			'get_clip_properties lists keyframe ids per property.',
		);
	if (a.keyframeIds) {
		if (a.properties || a.from !== undefined || a.to !== undefined)
			throw new ToolError(
				'E_INVALID_PARAM',
				'properties / from / to narrow a clipId selection; they do not apply to keyframeIds',
				'Pass either keyframeIds alone or clipId with properties / from / to.',
			);
		return [...new Set(a.keyframeIds)];
	}
	let r: ReturnType<typeof clipKeyframesQuery>;
	try {
		const seq = Object.values(doc.sequences).find((s) => s.clips[a.clipId!]);
		r = clipKeyframesQuery(
			{ doc, effects: REGISTRIES.effects, mgTemplates: REGISTRIES.mgTemplates },
			{
				clipId: a.clipId!,
				keys: a.properties ?? defaultProperties,
				...(seq && a.from !== undefined ? { fromFrame: frameOf(seq, a.from) } : {}),
				...(seq && a.to !== undefined ? { toFrame: frameOf(seq, a.to) } : {}),
			},
		);
	} catch (e) {
		if (e instanceof PropertyQueryError)
			throw new ToolError(e.code, e.message, 'Call get_timeline for clip ids.');
		throw e;
	}
	if (r.unmatched.length)
		throw new ToolError(
			'E_NOT_FOUND',
			`Clip ${a.clipId} has no property ${r.unmatched.map((k) => `"${k}"`).join(', ')}`,
			'get_clip_properties lists the property keys of the clip.',
		);
	const ids = r.properties.flatMap((p) => p.keyframes.map((k) => k.id));
	if (!ids.length)
		throw new ToolError(
			'E_NOT_FOUND',
			`No keyframes selected on clip ${a.clipId}${a.from !== undefined || a.to !== undefined ? ' in that time range' : ''}`,
			'get_clip_properties shows which properties are keyframed and where.',
		);
	return ids;
}

/** The ease view of keys (frames, cubic-bezier strings, presets) as a tool error when the ids do not resolve. */
function easesOf(doc: ProjectDocument, ids: readonly string[]) {
	const r = keyframeEasesView(doc, ids, REGISTRIES);
	if (!r.ok) throw new ToolError(r.code, r.message, 'get_clip_properties lists keyframe ids per property.');
	return r.properties;
}

/** The read-back after an edit: the eases of the keys it left, unless there are too many to list. */
function readBack(doc: ProjectDocument, ids: readonly string[]) {
	const present = new Set(ids);
	if (present.size > MAX_VIEW_KEYS)
		return { easesOmitted: `${present.size} keys changed; read them with get_keyframe_eases` };
	const r = keyframeEasesView(doc, [...present], REGISTRIES);
	return r.ok ? { eases: r.properties } : {};
}

type EaseChanges = { affected?: string[]; created?: string[]; removed?: string[] };

/** Sends one ease command and answers with the transaction body, its result and the read-back. */
async function applyEaseCommand(
	ctx: ToolContext,
	projectId: string,
	label: string,
	command: Record<string, unknown>,
	extra: Extra,
	readIds: (result: EaseChanges & Record<string, unknown>) => string[],
	more: Record<string, unknown> = {},
) {
	const res = await transact(ctx, projectId, { label, commands: [command] }, extra);
	const r = requireOk(res);
	const result = (r.results[0] ?? {}) as EaseChanges & Record<string, unknown>;
	const doc = await rawDoc(ctx, projectId);
	const removed = new Set(result.removed ?? []);
	const ids = readIds(result).filter((id) => !removed.has(id));
	return jsonResult({ ...txBody(res, r), ...more, ...(ids.length ? readBack(doc, ids) : {}) });
}

const changedKeys = (r: EaseChanges) => [...(r.affected ?? []), ...(r.created ?? [])];

function clipSummary(clip: EaseClip) {
	if (clip.kind === 'key')
		return {
			kind: 'key',
			in: {
				interpolation: clip.inInterpolation ?? 'bezier',
				influence: Math.round(clip.easeIn.influence * 1e4) / 100,
				slope: clip.easeIn.slope,
			},
			out: {
				interpolation: clip.interpolation ?? 'bezier',
				influence: Math.round(clip.easeOut.influence * 1e4) / 100,
				slope: clip.easeOut.slope,
			},
		};
	const preset = clip.curve ? matchEasePreset(clip.curve, undefined, 2e-3) : null;
	return {
		kind: 'segments',
		segments: clip.segments.map((s) => formatCubicBezier(s)),
		...(clip.curve
			? { curve: { points: clip.curve.points.length, ...(preset ? { preset: preset.id } : {}) } }
			: {}),
	};
}

export function registerEaseTools(ctx: ToolContext): void {
	defineTool(
		ctx,
		'list_ease_presets',
		{
			title: 'List ease presets',
			description:
				'The built-in ease curves for apply_ease (and, cubic ones, animate_trim_paths): groups (id, name) and per preset id, name, group, kind (cubic = one segment, CSS cubic-bezier; multi = a curve over several keys that rebuilds the keys between) and the cubic-bezier string or the point count.',
			input: {
				group: z
					.string()
					.min(1)
					.optional()
					.describe(`Only this group: ${BUILTIN_EASE_GROUPS.map((g) => g.id).join(', ')}`),
			},
			annotations: READ_ONLY,
		},
		async ({ group }) => {
			if (group !== undefined && !BUILTIN_EASE_GROUPS.some((g) => g.id === group))
				throw new ToolError(
					'E_INVALID_PARAM',
					`Unknown ease preset group "${group}"`,
					`Groups: ${BUILTIN_EASE_GROUPS.map((g) => g.id).join(', ')}.`,
				);
			return jsonResult({
				groups: BUILTIN_EASE_GROUPS.filter((g) => group === undefined || g.id === group),
				presets: builtinEasePresets()
					.filter((p) => group === undefined || p.group === group)
					.map((p) => ({
						id: p.id,
						name: p.name,
						group: p.group,
						kind: p.curve.kind,
						...(p.curve.kind === 'cubic'
							? { cubicBezier: formatCubicBezier(p.curve) }
							: { points: p.curve.points.length }),
					})),
			});
		},
	);

	defineTool(
		ctx,
		'get_keyframe_eases',
		{
			title: 'Get keyframe eases',
			description: `The eases of keyframes, per property, exactly as they evaluate (each segment uses its first key's outgoing side and its last key's incoming side): each selected key (id, sequence frame, timecode, value, interpolation = outgoing type, inInterpolation = its own incoming type when it has one, roving) with in / out side type, influence %, speed (property units per second; sequence px/s along the path for Motion points, layer px/s for effect points; signed for numbers) and slope (1 = the segment's average speed); the segments into, between and out of the selection (fromId → toId, section, ease "hold" | "linear" | "cubic-bezier(…)", outInterpolation / inInterpolation = the two side types shaping it, the matched built-in preset id, average speed); and for 3+ keys of one property span.preset when the whole run matches a multi-point preset. Select by keyframeIds or clipId (+ properties, from, to). At most ${MAX_VIEW_KEYS} keys.`,
			input: { projectId: ProjectIdArg, ...selectionShape('every keyframed property') },
			annotations: READ_ONLY,
		},
		async (a) => {
			const doc = await rawDoc(ctx, a.projectId);
			const ids = selectedIds(doc, a);
			if (ids.length > MAX_VIEW_KEYS)
				throw new ToolError(
					'E_LIMIT',
					`${ids.length} keyframes selected; at most ${MAX_VIEW_KEYS} per call`,
					'Narrow the selection with properties / from / to, or pass fewer keyframeIds.',
				);
			return jsonResult({ selected: ids.length, properties: easesOf(doc, ids) });
		},
	);

	defineTool(
		ctx,
		'apply_ease',
		{
			title: 'Apply ease',
			description:
				'Applies an ease curve to keyframe segments (keyframe.applyEase, one undoable step). curve: a preset id ("basic.easy-ease", "penner.cubic-out", "bounce.out-3"; list_ease_presets), "cubic-bezier(x1, y1, x2, y2)", a CSS keyword, {x1, y1, x2, y2} or {points}. A cubic curve shapes every chosen segment exactly and keeps the others; a multi-point curve deletes the keys strictly between the first and last selected key of each property and creates keys at its points (needs 2+ keys with different end values). sections: middle (default for 2+ keys) | in | out. Returns {affected, created, removed} and the resulting eases (get_keyframe_eases view); warnings W_EASE_* say what was skipped or flattened.',
			input: {
				projectId: ProjectIdArg,
				...selectionShape('every keyframed property'),
				curve: CurveArg,
				sections: SectionsArg.optional(),
			},
			annotations: DESTRUCTIVE_IDEMPOTENT,
		},
		async (a, extra) => {
			const curve = parseCurveArg(a.curve);
			const doc = await rawDoc(ctx, a.projectId);
			const ids = selectedIds(doc, a);
			return applyEaseCommand(
				ctx,
				a.projectId,
				`Apply Ease: ${curve.name}`,
				{
					type: 'keyframe.applyEase',
					keyframeIds: ids,
					curve: curve.curve,
					...(a.sections ? { sections: a.sections } : {}),
				},
				extra,
				changedKeys,
				{ curve: { name: curve.name, ...(curve.presetId ? { presetId: curve.presetId } : {}) } },
			);
		},
	);

	defineTool(
		ctx,
		'transfer_ease',
		{
			title: 'Copy ease to keyframes',
			description:
				'Copies the ease of source keyframes and pastes it onto target keyframes in one undoable step (copy + keyframe.pasteEase). One source key → both of its sides (incoming and outgoing type and ease) onto every target key, as keyframe.setInterpolation would set them (the neighbours keep their own sides). 2+ source keys → the segment curves between them, pasted onto the target segments in order (property, then time; one curve → every target segment; a count mismatch pastes the first ones with W_EASE_COUNT_MISMATCH). 3+ source keys of one property also carry their whole run as a curve, applied like a multi-point apply_ease (the target keys between are rebuilt) unless mode is "segments". Returns what was copied and the resulting eases.',
			input: {
				projectId: ProjectIdArg,
				fromKeyframeIds: z.array(IdArg).min(1).max(MAX_SELECTED).describe('Keys to copy the ease from'),
				toKeyframeIds: z.array(IdArg).min(1).max(MAX_SELECTED).describe('Keys to paste it onto'),
				sections: SectionsArg.optional(),
				mode: z
					.enum(['segments', 'curve'])
					.optional()
					.describe(
						'segments = paste the segment curves only; curve = the whole-run curve (refused when none was copied); default: the curve when there is one',
					),
			},
			annotations: DESTRUCTIVE_IDEMPOTENT,
		},
		async (a, extra) => {
			const doc = await rawDoc(ctx, a.projectId);
			const copied = copyEase(doc, a.fromKeyframeIds, REGISTRIES);
			if (!copied.ok)
				throw new ToolError(
					copied.code,
					`Cannot copy the ease: ${copied.message}`,
					'Copy from one key, or from two or more keys of a property (get_clip_properties lists them).',
				);
			return applyEaseCommand(
				ctx,
				a.projectId,
				'Paste Ease',
				{
					type: 'keyframe.pasteEase',
					keyframeIds: a.toKeyframeIds,
					clip: copied.clip,
					...(a.sections ? { sections: a.sections } : {}),
					...(a.mode ? { mode: a.mode } : {}),
				},
				extra,
				(r) => [...a.toKeyframeIds, ...changedKeys(r)],
				{ copied: clipSummary(copied.clip) },
			);
		},
	);

	defineTool(
		ctx,
		'transfer_keyframe_values',
		{
			title: 'Copy keyframe values',
			description:
				'Copies the values of source keyframes onto target keyframes in order (property, then time) in one undoable step (copy + keyframe.pasteValues); target times and eases stay. Values are validated like keyframe.update (W_VALUE_CLAMPED; a wrong type is refused); a count mismatch pastes the first ones (W_EASE_COUNT_MISMATCH).',
			input: {
				projectId: ProjectIdArg,
				fromKeyframeIds: z.array(IdArg).min(1).max(10_000).describe('Keys to copy the values from'),
				toKeyframeIds: z.array(IdArg).min(1).max(10_000).describe('Keys to paste them onto'),
			},
			annotations: EDIT_IDEMPOTENT,
		},
		async (a, extra) => {
			const doc = await rawDoc(ctx, a.projectId);
			const copied = copyValues(doc, a.fromKeyframeIds, REGISTRIES);
			if (!copied.ok)
				throw new ToolError(
					copied.code,
					`Cannot copy the values: ${copied.message}`,
					'get_clip_properties lists keyframe ids per property.',
				);
			return applyEaseCommand(
				ctx,
				a.projectId,
				'Paste Keyframe Values',
				{ type: 'keyframe.pasteValues', keyframeIds: a.toKeyframeIds, values: copied.values },
				extra,
				() => a.toKeyframeIds,
			);
		},
	);

	defineTool(
		ctx,
		'set_keyframe_velocity',
		{
			title: 'Set keyframe velocity',
			description:
				"Sets the incoming and / or outgoing speed and influence of one keyframe (keyframe.setVelocity, the numeric velocity editor; one undoable step). speed: property units per second (sequence px/s along the path for points; signed for numbers); influence: percent 0.1…100. A segment whose value does not change cannot take a nonzero speed; hold segments and roving keys are refused. Returns the key's resulting eases.",
			input: {
				projectId: ProjectIdArg,
				keyframeId: IdArg.describe('Keyframe id ("kf_…")'),
				side: z
					.enum(['in', 'out', 'both'])
					.describe('in = arriving, out = leaving, both = the sides that exist'),
				speed: z.number().min(-1e9).max(1e9).optional().describe('Speed in property units per second'),
				influence: z.number().min(0.1).max(100).optional().describe('Influence in percent'),
			},
			annotations: EDIT_IDEMPOTENT,
		},
		async (a, extra) => {
			if (a.speed === undefined && a.influence === undefined)
				throw new ToolError(
					'E_INVALID_PARAM',
					'Give speed and / or influence',
					'get_keyframe_eases shows them.',
				);
			return applyEaseCommand(
				ctx,
				a.projectId,
				'Keyframe Velocity',
				{
					type: 'keyframe.setVelocity',
					keyframeId: a.keyframeId,
					side: a.side,
					...(a.speed !== undefined ? { speed: a.speed } : {}),
					...(a.influence !== undefined ? { influence: a.influence } : {}),
				},
				extra,
				() => [a.keyframeId],
			);
		},
	);

	defineTool(
		ctx,
		'create_path_controller',
		{
			title: 'Create path controller',
			description:
				'Makes a point property (Position by default) between its first and last selected key follow its drawn motion path at the progress of a new "Path Progress" Slider Control (keyframe.createPathController, one undoable step): the keys between rove (constant speed), the slider is keyed 0 → 100 with Easy Ease over the span, and an expression places the layer on the path at the slider\'s value. Retime or re-ease the motion by editing the slider keys (param.set / apply_ease on the returned slider target). Refused for non-point properties, several properties, or an existing expression without replaceExpression.',
			input: {
				projectId: ProjectIdArg,
				...selectionShape('["transform.position"]'),
				replaceExpression: z.boolean().optional().describe('Replace an expression the property already has'),
			},
			annotations: EDIT,
		},
		async (a, extra) => {
			const doc = await rawDoc(ctx, a.projectId);
			const ids = selectedIds(doc, a, ['transform.position']);
			const res = await transact(
				ctx,
				a.projectId,
				{
					label: 'Create Path Controller',
					commands: [
						{
							type: 'keyframe.createPathController',
							keyframeIds: ids,
							...(a.replaceExpression ? { replaceExpression: true } : {}),
						},
					],
				},
				extra,
			);
			const r = requireOk(res);
			const result = (r.results[0] ?? {}) as { effectInstanceId?: string };
			const after = await rawDoc(ctx, a.projectId);
			const clipId = Object.values(after.sequences)
				.flatMap((s) => Object.values(s.clips))
				.find((c) =>
					((c as { effects?: { id: string }[] }).effects ?? []).some((e) => e.id === result.effectInstanceId),
				)?.id;
			return jsonResult({
				...txBody(res, r),
				...(clipId && result.effectInstanceId
					? { sliderTarget: ['clip', clipId, 'effects', result.effectInstanceId, 'slider'] }
					: {}),
			});
		},
	);

	defineTool(
		ctx,
		'cleanup_motion_path',
		{
			title: 'Clean up motion path',
			description:
				'Clean Up Path for point properties (Position by default; keyframes.cleanupPath, one undoable step): makes the timing between the first and last selected key linear and removes every key the drawn motion path does not need within `tolerance` (sequence px for Motion, layer px for effect points; default 0.5), refitting the path handles across removed keys. Keys outside the span are unchanged. Returns per property the key counts before / after, the removed ids and the max error.',
			input: {
				projectId: ProjectIdArg,
				...selectionShape('["transform.position"]'),
				tolerance: z
					.number()
					.positive()
					.max(10_000)
					.optional()
					.describe('Allowed path deviation (default 0.5)'),
			},
			annotations: DESTRUCTIVE_IDEMPOTENT,
		},
		async (a, extra) => {
			const doc = await rawDoc(ctx, a.projectId);
			const ids = selectedIds(doc, a, ['transform.position']);
			return applyEaseCommand(
				ctx,
				a.projectId,
				'Clean Up Motion Path',
				{
					type: 'keyframes.cleanupPath',
					keyframeIds: ids,
					...(a.tolerance !== undefined ? { tolerance: a.tolerance } : {}),
				},
				extra,
				(r) => [...ids, ...changedKeys(r)],
			);
		},
	);
}
