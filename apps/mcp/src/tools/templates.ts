import type {
	EngineJob,
	MgTemplateCatalogEntry,
	MgTemplatePresetEntry,
	MgTemplatesResponse,
} from '@jasper/api';
import { EngineError } from '@jasper/engine-client';
import {
	applyTransaction,
	createEmptyProject,
	createRandomIdSource,
	createStaticMgRegistry,
	defaultRegistries,
	formatSchemaIssues,
	type JsonSchemaNode,
	type MotionGraphicClip,
	makeSequenceSettings,
	type ProjectDocument,
	parseMgTemplateRef,
	type Sequence,
	TEMPLATE_MEDIA_KIND,
	TEMPLATE_MEDIA_KINDS_KEY,
	TEMPLATE_PARAM_KIND_KEY,
	validateJsonSchema,
} from '@jasper/project';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { ProjectIdArg, timeArg } from '../arguments.ts';
import {
	defineTool,
	EDIT_IDEMPOTENT,
	type Extra,
	frameOf,
	loadDoc,
	requireOk,
	type ToolContext,
	transact,
	txBody,
	waitJob,
} from '../context.ts';
import { toolEnvelope } from '../envelope.ts';
import { jsonResult, type RenderCapsHint, renderHint, ToolError } from '../errors.ts';

export const TEMPLATES_GUIDE = `Motion-graphic templates (add_motion_graphic):
- list_motion_templates shows every template with renderer ("fframes" = native jasper-mg renderer, "anime" = drawn by Remotion), its params (type, range, default, keyframable) and the full paramsSchema.
- Templates may declare presets (named param sets, e.g. one per look): list_motion_templates lists them with a ready-made ref. Pass "<id>:<preset>" (or "<id>@<version>:<preset>") as template to add_motion_graphic or render_motion_graphic_preview: the preset's params apply over the defaults and your params over the preset.
- Anime templates (title-reveal, lower-third-anim, callout, counter…) need no fframes renderer: render_motion_graphic_preview, render_frame and exports draw them with Remotion in a headless Chrome.
- set_motion_graphic_params {clipId, params} changes params of a placed template clip (one undo step). Numeric and colour params of anime templates are keyframable: pass at and keyframe: true to animate them (a keyframe per call); once a param is animated, pass at to set its value at that time.
- Media params (type "media image" / "media image|video", e.g. an avatar) take {mediaId} of a medium in the project (import or register it first) or null for none. A missing medium is refused (E_NOT_FOUND), so is one of another kind (E_INVALID_PARAM). Deleting a medium a template shows clears the param (the clip stays).`;

/**
 * Bounds at or beyond the safe-integer range are no bounds (zod's `.int()` writes ±MAX_SAFE_INTEGER into the JSON
 * Schema); real ranges as wide as the counter's ±1e12 are kept.
 */
const num = (v: unknown) => (typeof v === 'number' && Math.abs(v) < Number.MAX_SAFE_INTEGER ? v : undefined);

/** `anyOf`/`oneOf` of one schema plus `null` (zod `.nullable()`) → that schema. */
function unwrapNullable(s: JsonSchemaNode): JsonSchemaNode {
	for (const key of ['anyOf', 'oneOf'] as const) {
		const list = s[key];
		if (!Array.isArray(list)) continue;
		const rest = list.filter((x) => !(x && typeof x === 'object' && (x as JsonSchemaNode).type === 'null'));
		if (rest.length === 1 && rest[0] && typeof rest[0] === 'object') return rest[0] as JsonSchemaNode;
	}
	return s;
}

function range(min: number | undefined, max: number | undefined): string {
	if (min !== undefined && max !== undefined) return ` ${min}…${max}`;
	if (min !== undefined) return ` ≥${min}`;
	if (max !== undefined) return ` ≤${max}`;
	return '';
}

type ParamKind = 'string' | 'number' | 'integer' | 'boolean' | 'enum' | 'rgba' | 'vec2' | 'json' | 'media';

/** Kind of one params-schema property (mirrors the property specs of @jasper/project `paramsPropertySpecs`). */
function paramKind(s0: JsonSchemaNode): { kind: ParamKind; type: string } {
	// Template media params (`mediaParam()`): `{mediaId} | null` of the listed media kinds.
	if (s0[TEMPLATE_PARAM_KIND_KEY] === TEMPLATE_MEDIA_KIND) {
		const kinds = Array.isArray(s0[TEMPLATE_MEDIA_KINDS_KEY])
			? (s0[TEMPLATE_MEDIA_KINDS_KEY] as unknown[])
			: [];
		return { kind: 'media', type: `media ${kinds.map(String).join('|') || 'any'}` };
	}
	const s = unwrapNullable(s0);
	const t = Array.isArray(s.type) ? (s.type as string[]).find((x) => x !== 'null') : s.type;
	const options = Array.isArray(s.enum)
		? (s.enum as unknown[]).map(String)
		: Array.isArray(s.anyOf) &&
				(s.anyOf as JsonSchemaNode[]).every((x) => x && typeof x === 'object' && typeof x.const === 'string')
			? (s.anyOf as JsonSchemaNode[]).map((x) => String(x.const))
			: null;
	if (options) return { kind: 'enum', type: `enum ${options.join('|')}` };
	if (t === 'integer') return { kind: 'integer', type: `integer${range(num(s.minimum), num(s.maximum))}` };
	if (t === 'number') return { kind: 'number', type: `number${range(num(s.minimum), num(s.maximum))}` };
	if (t === 'boolean') return { kind: 'boolean', type: 'boolean' };
	if (t === 'string') {
		const max = num(s.maxLength);
		return { kind: 'string', type: max !== undefined ? `string ≤${max}` : 'string' };
	}
	if (t === 'array' && s.minItems === 4 && s.maxItems === 4) return { kind: 'rgba', type: 'rgba' };
	if (t === 'array' && s.minItems === 2 && s.maxItems === 2) return { kind: 'vec2', type: 'vec2' };
	return { kind: 'json', type: typeof t === 'string' ? t : 'json' };
}

type ParamSummary = {
	name: string;
	type: string;
	default: unknown;
	keyframable: boolean;
	description?: string;
	/** UI hints: the label the editor shows, its group and when the editor shows the param. */
	label?: string;
	group?: string;
	visibleWhen?: { param: string; in: unknown[] };
};

type TemplateLike = Pick<MgTemplateCatalogEntry, 'paramsSchema' | 'defaults' | 'renderer' | 'ui'>;

/**
 * Compact params of a template. keyframable = anime template and a non-integer number or an RGBA colour
 * (S11:ATP-006, the same rule as `isKeyframableTemplateParam`).
 */
function paramsSummary(t: TemplateLike): ParamSummary[] {
	const props = ((t.paramsSchema as JsonSchemaNode).properties ?? {}) as Record<string, JsonSchemaNode>;
	const anime = t.renderer === 'anime';
	const groupOf = new Map<string, string>();
	for (const g of t.ui?.groups ?? []) for (const p of g.params) if (!groupOf.has(p)) groupOf.set(p, g.label);
	return Object.entries(props).map(([name, s]) => {
		const { kind, type } = paramKind(s ?? {});
		const hint = t.ui?.params?.[name];
		const description = hint?.description ?? s?.description;
		return {
			name,
			type,
			default: t.defaults[name] !== undefined ? t.defaults[name] : s?.default,
			keyframable: anime && (kind === 'number' || kind === 'rgba'),
			...(typeof description === 'string' ? { description } : {}),
			...(hint?.label ? { label: hint.label } : {}),
			...(groupOf.has(name) ? { group: groupOf.get(name) } : {}),
			...(hint?.visibleWhen ? { visibleWhen: hint.visibleWhen } : {}),
		};
	});
}

/** One list_motion_templates entry. */
export function templateSummary(t: MgTemplateCatalogEntry) {
	return {
		id: t.id,
		version: t.version,
		name: t.name,
		category: t.category,
		renderer: t.renderer ?? 'fframes',
		native: t.native ?? false,
		...(t.description ? { description: t.description } : {}),
		...(t.defaultDurationSeconds ? { defaultDurationSeconds: t.defaultDurationSeconds } : {}),
		...(t.presets?.length
			? {
					presets: t.presets.map((p) => ({
						ref: `${t.id}:${p.id}`,
						id: p.id,
						name: p.name,
						...(p.description ? { description: p.description } : {}),
						params: p.params,
					})),
				}
			: {}),
		params: paramsSummary(t),
		defaults: t.defaults,
		paramsSchema: t.paramsSchema,
	};
}

/**
 * The catalogue entry and preset a template ref names: `"<id>"`, `"<id>@<version>"`, `"<id>:<preset>"` or
 * `"<id>@<version>:<preset>"` (the newest version without `@`). E_INVALID_PARAM for a malformed ref, E_NOT_FOUND
 * (listing what exists) for an unknown template, version or preset.
 */
export function resolveTemplateRef(
	cat: MgTemplatesResponse,
	spec: string,
	hint = '',
): { template: MgTemplateCatalogEntry; preset: MgTemplatePresetEntry | null } {
	const ref = parseMgTemplateRef(spec);
	if (!ref)
		throw new ToolError(
			'E_INVALID_PARAM',
			`Malformed template reference "${spec}"`,
			'Use "<id>", "<id>@<version>", "<id>:<preset>" or "<id>@<version>:<preset>" (list_motion_templates).',
		);
	const t = cat.templates
		.filter((x) => x.id === ref.id && (ref.version === undefined || x.version === ref.version))
		.sort((x, y) => y.version - x.version)[0];
	if (!t)
		throw new ToolError(
			'E_NOT_FOUND',
			`Unknown motion template "${spec}"`,
			`Available: ${cat.templates.map((x) => `${x.id}@${x.version}`).join(', ')}${hint}.`,
		);
	if (ref.preset === undefined) return { template: t, preset: null };
	const preset = t.presets?.find((p) => p.id === ref.preset);
	if (!preset)
		throw new ToolError(
			'E_NOT_FOUND',
			`Template ${t.id}@${t.version} has no preset "${ref.preset}"`,
			t.presets?.length
				? `Presets: ${t.presets.map((p) => `${t.id}:${p.id}`).join(', ')}.`
				: `${t.id} has no presets; pass "${t.id}" and set params instead.`,
		);
	return { template: t, preset };
}

/** Engine errors that are not render failures (their own hints in errors.ts apply). */
const NOT_RENDER = new Set([
	'NETWORK',
	'UNAUTHORIZED',
	'PROJECT_NOT_FOUND',
	'NOT_FOUND',
	'JOB_NOT_FOUND',
	'VALIDATION_FAILED',
	'NO_SESSION',
	'LOCAL_MODE_ONLY',
]);

/** The engine's Remotion capability, fetched only after a failure (never on the happy path). */
async function renderCaps(ctx: ToolContext): Promise<RenderCapsHint | undefined> {
	return ctx
		.engine((c) => c.capabilities())
		.then((caps) => caps.render as RenderCapsHint)
		.catch(() => undefined);
}

/** renderHint plus the engine's Remotion state (lazily fetched). */
export async function renderErrorHint(
	ctx: ToolContext,
	code: string,
	message: string,
	detail?: unknown,
): Promise<string | undefined> {
	return renderHint(code, message, await renderCaps(ctx), detail);
}

/** Rethrows a render-call failure as a ToolError with an actionable hint when there is one. */
export async function renderToolError(ctx: ToolContext, e: unknown): Promise<never> {
	if (!(e instanceof EngineError)) throw e;
	const inner = (e.detail as { code?: unknown } | undefined)?.code;
	if (NOT_RENDER.has(e.code) || (typeof inner === 'string' && inner.startsWith('E_'))) throw e;
	const hint = await renderErrorHint(ctx, e.code, e.message, e.detail);
	if (!hint) throw e;
	const detail = e.detail && typeof e.detail === 'object' ? (e.detail as Record<string, unknown>) : {};
	const { hint: _engineHint, ...rest } = detail;
	throw new ToolError(e.code, e.message, hint, {
		...rest,
		...(e.status ? { httpStatus: e.status } : {}),
	});
}

/** A ToolError for a job that ended without succeeding (hint from its error code/message). */
export async function failedJobError(
	ctx: ToolContext,
	job: EngineJob,
	fallbackHint: string | undefined,
	details?: unknown,
): Promise<ToolError> {
	const code = job.error?.code ?? `JOB_${job.state.toUpperCase()}`;
	const message = job.error?.message ?? `The job ${job.state}`;
	if (job.state === 'cancelled') return new ToolError(code, message, undefined, details);
	const hint = await renderErrorHint(ctx, code, message);
	return new ToolError(code, message, hint ?? fallbackHint, details);
}

/** Even, ≥ 2 (encoders and the still path want even frame sizes). */
const evenSize = (n: number) => Math.max(2, Math.round(n / 2) * 2);

type AnimePreviewSpec = {
	params: Record<string, unknown>;
	width: number;
	height: number;
	fps: number;
	durationFrames: number;
};

/** Validates params against the template's JSON Schema (E_INVALID_PARAM listing the issues). */
function checkParams(t: MgTemplateCatalogEntry, params: Record<string, unknown>): void {
	const issues = validateJsonSchema(t.paramsSchema as JsonSchemaNode, params);
	if (issues.length)
		throw new ToolError(
			'E_INVALID_PARAM',
			`Invalid params for ${t.id}@${t.version}: ${formatSchemaIssues(issues)}`,
			`Fix: ${formatSchemaIssues(issues, 10)}. list_motion_templates shows each param's type, range and default.`,
			{ issues },
		);
}

/**
 * A one-sequence document (width×height at fps) holding just the template clip on V1 from frame 0, with the
 * template's defaults merged under `params`. The template registry is built from the catalogue entry (params
 * were validated against its JSON Schema already, so its zod schema is permissive).
 */
function animePreviewDocument(
	t: MgTemplateCatalogEntry,
	spec: AnimePreviewSpec,
): { doc: ProjectDocument; sequenceId: string; clipId: string } {
	const ids = createRandomIdSource();
	const fresh = createEmptyProject({ ids, name: `Preview ${t.id}@${t.version}` });
	const seq = Object.values(fresh.sequences)[0] as Sequence;
	seq.settings = makeSequenceSettings(evenSize(spec.width), evenSize(spec.height), { num: spec.fps, den: 1 });
	const registry = createStaticMgRegistry([
		{
			id: t.id,
			version: t.version,
			name: t.name,
			category: t.category,
			paramsSchema: z.record(z.string(), z.unknown()),
			defaults: t.defaults,
			introFrames: t.introFrames ?? 0,
			outroFrames: t.outroFrames ?? 0,
			canvasDefault: 'sequence',
			renderer: t.renderer ?? 'fframes',
		},
	]);
	const { document, result } = applyTransaction(
		fresh,
		{
			protocol: 'jasper.tx/1',
			label: 'Preview',
			origin: 'user',
			commands: [
				{
					type: 'clip.addMotionGraphic',
					at: 0,
					duration: spec.durationFrames,
					track: 'V1',
					template: { id: t.id, version: t.version },
					params: spec.params,
					canvas: 'sequence',
					ref: '$mg',
				},
			],
		},
		{ ids, now: () => new Date().toISOString(), revision: 0, registries: defaultRegistries(registry) },
	);
	if (!result.ok)
		throw new ToolError(
			result.errors[0]?.code ?? 'E_INVALID_PARAM',
			`Could not build the preview: ${result.errors.map((e) => e.message).join('; ')}`,
			'Check the params against list_motion_templates.',
		);
	return { doc: document, sequenceId: seq.id, clipId: result.refs.$mg ?? result.created[0]! };
}

/** `introFrames`/`outroFrames` of the catalogue are written at this rate (`ANIME_REFERENCE_FPS`, @jasper/mg-templates). */
const ANIME_REFERENCE_FPS = 30;

/**
 * Intro and outro of a `durationFrames` clip at `fps`, in whole frames: the catalogue's lengths converted from the
 * reference rate and compressed proportionally when they do not both fit (the rule of `animeTemplateTiming` in
 * @jasper/mg-templates, which this package does not depend on).
 */
function previewPhases(
	durationFrames: number,
	t: { introFrames?: number; outroFrames?: number; fps: number },
): { intro: number; outro: number } {
	const d = Math.max(1, Math.round(durationFrames));
	const at = (f: number | undefined) => Math.max(0, Math.round(((f ?? 0) * t.fps) / ANIME_REFERENCE_FPS));
	let intro = at(t.introFrames);
	let outro = at(t.outroFrames);
	if (intro + outro > d) {
		const sum = intro + outro;
		intro = Math.floor((d * intro) / sum);
		outro = d - intro;
	}
	return { intro, outro };
}

/**
 * Poster frames of a `durationFrames` clip. Without the template's timing: `count` evenly spaced frames. With it,
 * one frame per phase in the order intro, hold, outro: count 1 = the hold's middle (the rest state); 2 = intro
 * middle + hold; 3 = intro middle, hold middle, `d − ceil(outro/2)` (the outro middle); more frames go to the
 * intro and the outro alternately (evenly spaced inside each). A phase without frames (no intro / outro, or no
 * hold left after compression) hands its share to the hold, or to the whole clip.
 */
function previewFrames(
	durationFrames: number,
	count = 1,
	timing?: { introFrames?: number; outroFrames?: number; fps: number },
): number[] {
	const d = Math.max(1, Math.round(durationFrames));
	const n = Math.max(1, Math.round(count));
	const spread = (start: number, len: number, k: number, fromEnd = false) =>
		Array.from({ length: k }, (_, i) =>
			fromEnd
				? start + len - Math.ceil((len * (i + 1)) / (k + 1))
				: start + Math.floor((len * (i + 1)) / (k + 1)),
		);
	const out: number[] = [];
	if (!timing) out.push(...spread(0, d, n));
	else {
		const { intro, outro } = previewPhases(d, timing);
		const hold = d - intro - outro;
		let nIntro = n >= 2 ? Math.ceil((n - 1) / 2) : 0;
		let nOutro = n >= 3 ? Math.floor((n - 1) / 2) : 0;
		let nHold = n - nIntro - nOutro;
		if (intro === 0) [nHold, nIntro] = [nHold + nIntro, 0];
		if (outro === 0) [nHold, nOutro] = [nHold + nOutro, 0];
		if (nIntro) out.push(...spread(0, intro, nIntro));
		if (nHold) out.push(...(hold > 0 ? spread(intro, hold, nHold) : spread(0, d, nHold)));
		// the outro's samples counted back from the end: 1 sample = d − ceil(outro/2)
		if (nOutro) out.push(...spread(d - outro, outro, nOutro, true).reverse());
	}
	return [...new Set(out.map((f) => Math.min(d - 1, Math.max(0, f))))].sort((a, b) => a - b);
}

/** Waits up to this long per still: the first Remotion render bundles the compositions (and may download Chrome). */
const STILL_TIMEOUT_MS = 300_000;

/** render_motion_graphic_preview for an anime template: Remotion stills of a one-clip document. */
export async function animeTemplatePreview(
	ctx: ToolContext,
	t: MgTemplateCatalogEntry,
	a: {
		params?: Record<string, unknown>;
		width?: number;
		height?: number;
		durationSeconds?: number;
		fps?: number;
		frames?: number;
	},
	extra?: Extra,
): Promise<CallToolResult> {
	const params = { ...t.defaults, ...(a.params ?? {}) };
	checkParams(t, params);
	const fps = a.fps ?? 30;
	const width = evenSize(a.width ?? 960);
	const height = evenSize(a.height ?? 540);
	const durationFrames = Math.max(1, Math.round((a.durationSeconds ?? t.defaultDurationSeconds ?? 5) * fps));
	const { doc, sequenceId } = animePreviewDocument(t, { params, width, height, fps, durationFrames });
	const envelope = toolEnvelope(doc, 0);
	const frames = previewFrames(durationFrames, a.frames ?? 1, {
		introFrames: t.introFrames,
		outroFrames: t.outroFrames,
		fps,
	});
	const images: CallToolResult['content'] = [];
	const jobs: string[] = [];
	let renderedBy = 'remotion';
	for (const frame of frames) {
		const job = await ctx
			.engine((c) => c.requestStill({ envelope, sequenceId, frame, width }))
			.catch((e) => renderToolError(ctx, e));
		const { job: done, timedOut } = await waitJob(ctx, job.id, STILL_TIMEOUT_MS, extra);
		jobs.push(done.id);
		if (timedOut)
			throw new ToolError(
				'RENDER_TIMEOUT',
				`The preview still is still rendering after ${STILL_TIMEOUT_MS / 1000} s`,
				'The first Remotion render bundles the compositions and may download a browser: wait_for_job with this jobId, then call render_motion_graphic_preview again.',
				{ jobId: done.id },
			);
		if (done.state !== 'succeeded')
			throw await failedJobError(
				ctx,
				done,
				'Check the params against the template (list_motion_templates).',
				{ jobId: done.id },
			);
		const result = done.result as { url: string; renderPath?: string };
		// The still path's own report ('native' | 'hybrid' | 'remotion'); several stills agree (one document).
		if (result.renderPath) renderedBy = result.renderPath;
		const { bytes, contentType } = await ctx.engine((c) => c.fetchBytes(result.url));
		images.push({
			type: 'image',
			data: Buffer.from(bytes).toString('base64'),
			mimeType: contentType.startsWith('image/') ? contentType : 'image/png',
		});
	}
	return jsonResult(
		{
			template: `${t.id}@${t.version}`,
			renderer: 'anime',
			renderedBy,
			size: `${width}x${height}`,
			fps,
			durationFrames,
			...(frames.length === 1 ? { frame: frames[0], jobId: jobs[0] } : { frames, jobIds: jobs }),
		},
		images,
	);
}

function findMgClip(doc: ProjectDocument, clipId: string): { seq: Sequence; clip: MotionGraphicClip } {
	for (const seq of Object.values(doc.sequences)) {
		const c = seq.clips[clipId];
		if (!c) continue;
		if (c.kind !== 'motion-graphic')
			throw new ToolError(
				'E_INVALID_PARAM',
				`Clip ${clipId} is a ${c.kind} clip, not a motion graphic`,
				'Use get_timeline for the ids of motion-graphic clips (kind motion-graphic).',
			);
		return { seq: seq as Sequence, clip: c as MotionGraphicClip };
	}
	throw new ToolError('E_NOT_FOUND', `Clip ${clipId} not found`, 'Use get_timeline for clip ids.');
}

type ParamsPlan = { commands: unknown[]; staticParams: string[]; keyframed: string[] };

/**
 * The commands of set_motion_graphic_params: params that are neither keyframed nor animated go into one
 * `clip.update {params}` (merged and validated by the template schema); with `keyframe: true` each param gets
 * `param.setAnimated {animated: true}` (when not animated yet) and `param.set {value, at}`; already animated
 * params given with `at` get `param.set {value, at}` (a keyframe there).
 */
function planParamCommands(
	clip: Pick<MotionGraphicClip, 'id' | 'params' | 'paramKeyframes' | 'template'>,
	t: TemplateLike & Pick<MgTemplateCatalogEntry, 'id' | 'version'>,
	params: Record<string, unknown>,
	opts: { atFrame?: number; keyframe?: boolean },
): ParamsPlan {
	const summary = paramsSummary({ ...t, renderer: clip.template.renderer ?? t.renderer });
	const known = new Map(summary.map((p) => [p.name, p]));
	const unknown = Object.keys(params).filter((n) => !known.has(n));
	if (unknown.length)
		throw new ToolError(
			'E_INVALID_PARAM',
			`Unknown param(s) for ${t.id}@${t.version}: ${unknown.join(', ')}`,
			`Valid params: ${summary.map((p) => p.name).join(', ')}.`,
		);
	const keyframable = summary.filter((p) => p.keyframable).map((p) => p.name);
	const animated = new Set(
		Object.entries(clip.paramKeyframes ?? {})
			.filter(([, k]) => (k?.length ?? 0) > 0)
			.map(([n]) => n),
	);
	if (opts.keyframe) {
		if (opts.atFrame === undefined)
			throw new ToolError('E_INVALID_PARAM', 'keyframe: true needs at', 'Pass at: the time of the keyframe.');
		const bad = Object.keys(params).filter((n) => !known.get(n)!.keyframable);
		if (bad.length)
			throw new ToolError(
				'E_INVALID_PARAM',
				`Not keyframable: ${bad.join(', ')}`,
				keyframable.length
					? `Only numeric and colour params of anime templates are keyframable; here: ${keyframable.join(', ')}. Set the others without keyframe.`
					: `${t.id}@${t.version} has no keyframable params (only numeric and colour params of anime templates are); set them without keyframe.`,
			);
	}
	const staticParams: Record<string, unknown> = {};
	const keyCommands: unknown[] = [];
	const keyframed: string[] = [];
	for (const [name, value] of Object.entries(params)) {
		const isAnimated = animated.has(name);
		if (opts.keyframe || isAnimated) {
			if (opts.atFrame === undefined)
				throw new ToolError(
					'E_INVALID_PARAM',
					`Param "${name}" is animated (keyframes override its static value)`,
					'Pass at to set its value at that time (adds or updates a keyframe), or remove the animation with apply_commands param.setAnimated {animated: false}.',
				);
			const target = ['clip', clip.id, 'params', name];
			const at = { sequenceFrame: opts.atFrame };
			if (!isAnimated) keyCommands.push({ type: 'param.setAnimated', target, animated: true, at });
			keyCommands.push({ type: 'param.set', target, value, at });
			keyframed.push(name);
		} else staticParams[name] = value;
	}
	const commands: unknown[] = [];
	if (Object.keys(staticParams).length)
		commands.push({ type: 'clip.update', clipId: clip.id, patch: { params: staticParams } });
	commands.push(...keyCommands);
	return { commands, staticParams: Object.keys(staticParams), keyframed };
}

export function registerTemplateTools(ctx: ToolContext): void {
	defineTool(
		ctx,
		'set_motion_graphic_params',
		{
			title: 'Set motion-graphic params',
			description:
				'Changes params of a motion-graphic template clip (from add_motion_graphic) in one undoable step. Without keyframe the values become the static params (merged into the current ones, validated by the template schema: wrong types or ranges fail with E_INVALID_PARAM). Numeric and colour params of anime templates are keyframable (list_motion_templates: keyframable): pass at and keyframe: true to animate a param and set its keyframe at that time; call again with another at for the next keyframe. Params already animated need at (their value at that time). Returns the clip with its template, renderer, params and keyframed params.',
			input: {
				projectId: ProjectIdArg,
				clipId: z.string().min(1).describe('Motion-graphic clip id ("clp_…") from get_timeline'),
				params: z
					.record(z.string(), z.unknown())
					.refine((p) => Object.keys(p).length > 0, 'Give at least one param')
					.describe('Param values by name, e.g. {"title": "Hello", "titleSize": 140}'),
				at: timeArg('Keyframe time on the sequence (within the clip)').optional(),
				keyframe: z
					.boolean()
					.optional()
					.describe(
						'Animate the given params (anime templates, keyframable params only): add/update a keyframe at `at`',
					),
				dryRun: z.boolean().optional().describe('Validate without changing anything'),
			},
			annotations: EDIT_IDEMPOTENT,
		},
		async ({ projectId, clipId, params, at, keyframe, dryRun }, extra) => {
			const { doc } = await loadDoc(ctx, projectId);
			const { seq, clip } = findMgClip(doc, clipId);
			const cat = await ctx.engine((c) => c.mgTemplates());
			const t = cat.templates.find((x) => x.id === clip.template.id && x.version === clip.template.version);
			if (!t)
				throw new ToolError(
					'TEMPLATE_NOT_INSTALLED',
					`Motion-graphic template ${clip.template.id}@${clip.template.version} is not installed`,
					'Update JasperEditor, or replace or delete the clip (delete_clips) and add another template.',
				);
			const renderer = clip.template.renderer ?? t.renderer ?? 'fframes';
			let atFrame: number | undefined;
			if (at !== undefined) {
				atFrame = frameOf(seq, at);
				if (atFrame < clip.start || atFrame >= clip.start + clip.duration)
					throw new ToolError(
						'E_INVALID_PARAM',
						`Frame ${atFrame} is outside the clip (frames ${clip.start}–${clip.start + clip.duration - 1})`,
						'Keyframes go inside the clip: pass a time between its start and end (get_timeline).',
					);
			}
			if (keyframe && renderer !== 'anime')
				throw new ToolError(
					'E_INVALID_PARAM',
					`${t.id}@${t.version} is an fframes template: its params cannot be keyframed`,
					'Only anime templates (list_motion_templates renderer "anime") have keyframable params; set these without keyframe.',
				);
			// Unknown names first (listing the valid ones), then the values against the template's JSON Schema.
			const plan = planParamCommands(clip, { ...t, renderer }, params, { atFrame, keyframe });
			checkParams(t, { ...t.defaults, ...clip.params, ...params });
			const res = await transact(
				ctx,
				projectId,
				{
					label: `${plan.keyframed.length ? 'Keyframe' : 'Edit'} ${clip.name} params`,
					commands: plan.commands,
					sequenceId: seq.id,
					...(dryRun ? { dryRun: true } : {}),
				},
				extra,
			);
			const r = requireOk(res);
			const after = dryRun ? doc : (await loadDoc(ctx, projectId)).doc;
			const now = (after.sequences[seq.id]?.clips[clipId] ?? clip) as MotionGraphicClip;
			const keyframes = Object.fromEntries(
				Object.entries(now.paramKeyframes ?? {})
					.filter(([, k]) => (k?.length ?? 0) > 0)
					.map(([n, k]) => [n, k.length]),
			);
			return jsonResult({
				...txBody(res, r, dryRun),
				clip: {
					id: clipId,
					template: `${t.id}@${t.version}`,
					renderer,
					params: now.params,
					...(Object.keys(keyframes).length ? { keyframes } : {}),
				},
				...(plan.staticParams.length ? { staticParams: plan.staticParams } : {}),
				...(plan.keyframed.length ? { keyframed: plan.keyframed, atFrame } : {}),
			});
		},
	);
}
