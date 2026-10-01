// M2 MCP tools: motion-graphics bundles as clips (S08:MGA-001/002). Owner: wp-m2-mg (ARCHITECTURE §19.9).
//   import_mg_bundle       a Remotion 4.0.499 project folder (or built bundle folder) → mg-bundle media
//   list_compositions      the compositions of the project's bundles with their props schemas
//   add_composition        clip.addComposition (default duration = the composition length)
//   set_composition_props  props overrides of a composition clip (merge or replace; validated by the schema)
//   prerender_composition  the clip's preview or ProRes 4444 master as an engine job
//   scaffold_mg_project    (P1) a new Remotion project from the template, imported and watched
// `render_frame` (render.ts) renders composition clips through the same pre-render path (a native still).
import type { MgPrerenderRequest, RegisteredMedia } from '@jasper/api';
import { EngineError } from '@jasper/engine-client';
import {
	buildRenderSnapshot,
	type CompositionClip,
	compositionClipRenderRange,
	compositionSequenceFrames,
	type JsonSchemaNode,
	type MediaAsset,
	type MgCompositionInfo,
	mergeProps,
	type ProjectDocument,
	type RenderCompositionSource,
	TimeInputSchema,
	TrackRefSchema,
} from '@jasper/project';
import { z } from 'zod';
import {
	defineTool,
	EDIT,
	isTerminal,
	jobBody,
	loadDoc,
	READ_ONLY,
	requireOk,
	type ToolContext,
	transact,
	txBody,
	waitJob,
} from '../context.ts';
import { jsonResult, ToolError } from '../errors.ts';
import { clipSummary } from '../format.ts';
import { LOCAL_ENGINE_ID } from '../media.ts';
import { ProjectIdArg } from './projects.ts';

/** Appended to the server instructions (EDITING_GUIDE) when non-empty. */
export const COMPOSITION_GUIDE = `Motion graphics from Remotion projects (composition clips):
- import_mg_bundle {projectId, path} imports a Remotion project folder (remotion and every @remotion/* package pinned to exactly 4.0.499, dependencies installed; its own remotion.config.ts applies) or a built bundle folder. Each composition becomes placeable; watch: true rebuilds on save and the open editor relinks automatically.
- list_compositions shows ids, size, fps, length and the props schema (from jasper.mg.json, the project's jasper-schemas.ts zod module, or inferred from defaultProps).
- add_composition places one (default length = the composition's, at the sequence frame rate); set_composition_props edits its props (validated: wrong types fail with E_INVALID_PARAM); render_frame shows the result.
- Exports stay on the fast native path: each composition clip is pre-rendered once to a cached ProRes 4444 master (prerender_composition {quality: "master"} warms it); changing props or the bundle makes a new master.`;

const IdArg = z.string().min(1);
const TimeArg = (what: string) =>
	TimeInputSchema.describe(`${what}. Frames, {"seconds": x} or timecode "HH:MM:SS:FF"`);

/** Engine errors keep their actionable hint (e.g. MG_REMOTION_VERSION, S08:MGA-002). */
function engineToolError(e: unknown): never {
	if (e instanceof EngineError) {
		const d = (e.detail ?? {}) as { hint?: string };
		throw new ToolError(e.code, e.message, d.hint ?? undefined, e.detail);
	}
	throw e;
}

const engineKey = (m: Pick<MediaAsset, 'locators'>) => {
	const l = m.locators.find((x) => x.type === 'engine-store');
	return l && l.type === 'engine-store' ? l.key : null;
};

/** Compact props schema: top-level props with type, default and constraints. */
export function propsSummary(info: MgCompositionInfo): Record<string, unknown> {
	const schema = (info.propsSchema ?? {}) as JsonSchemaNode;
	const props = (schema.properties ?? {}) as Record<string, JsonSchemaNode>;
	const required = new Set((schema.required as string[] | undefined) ?? []);
	const out: Record<string, unknown> = {};
	for (const [k, s] of Object.entries(props)) {
		const pick: Record<string, unknown> = {};
		for (const f of [
			'type',
			'enum',
			'minimum',
			'maximum',
			'minLength',
			'maxLength',
			'pattern',
			'description',
		])
			if (s[f] !== undefined) pick[f] = s[f];
		if (s.type === 'object' && s.properties) pick.properties = Object.keys(s.properties as object);
		if (s.type === 'array' && (s.items as JsonSchemaNode | undefined)?.type)
			pick.items = (s.items as JsonSchemaNode).type;
		pick.default = info.defaultProps[k];
		if (required.has(k)) pick.required = true;
		const ui = info.ui?.[k]?.control;
		if (ui) pick.control = ui;
		out[k] = pick;
	}
	return out;
}

function compositionSummary(info: MgCompositionInfo) {
	return {
		id: info.id,
		size: `${info.width}x${info.height}`,
		fps: info.fps,
		durationFrames: info.durationInFrames,
		durationSeconds: Math.round((info.durationInFrames / info.fps) * 1000) / 1000,
		schemaSource: info.schemaSource,
		...(info.category ? { category: info.category } : {}),
		props: propsSummary(info),
	};
}

function bundleSummary(m: MediaAsset) {
	return {
		mediaId: m.id,
		name: m.mgBundle?.source.name ?? m.originalName,
		source: m.mgBundle?.source.type,
		...(m.mgBundle?.source.path ? { path: m.mgBundle.source.path } : {}),
		remotionVersion: m.mgBundle?.remotionVersion,
		compositions: (m.mgBundle?.compositions ?? []).map((c) => compositionSummary(c as MgCompositionInfo)),
	};
}

/** media.register (new) or media.relink (a rebuilt version of a bundle already in the project). */
function importCommand(
	doc: ProjectDocument,
	reg: RegisteredMedia,
): { command: unknown; existing: string | null } {
	const same = Object.values(doc.media).find((m) => m.kind === 'mg-bundle' && engineKey(m) === reg.mediaKey);
	if (same) return { command: null, existing: same.id };
	const path = reg.mgBundle?.source.path ?? null;
	const prev = path
		? Object.values(doc.media).find((m) => m.kind === 'mg-bundle' && m.mgBundle?.source.path === path)
		: undefined;
	if (prev)
		return {
			existing: prev.id,
			command: {
				type: 'media.relink',
				mediaId: prev.id,
				locator: { type: 'engine-store', engineId: LOCAL_ENGINE_ID, key: reg.mediaKey },
				fingerprint: reg.fingerprint,
				mgBundle: reg.mgBundle,
				sizeBytes: reg.sizeBytes,
			},
		};
	return {
		existing: null,
		command: {
			type: 'media.register',
			asset: {
				kind: reg.kind,
				fingerprint: reg.fingerprint,
				originalName: reg.originalName,
				sizeBytes: reg.sizeBytes,
				container: reg.container,
				probe: reg.probe,
				locators: [{ type: 'engine-store', engineId: LOCAL_ENGINE_ID, key: reg.mediaKey }],
				...(reg.mgBundle ? { mgBundle: reg.mgBundle } : {}),
			},
			name: reg.mgBundle?.source.name ?? reg.originalName,
			label: 'magenta',
			ref: '$bundle',
		},
	};
}

async function commitImport(
	ctx: ToolContext,
	projectId: string,
	reg: RegisteredMedia,
	extra: Parameters<typeof transact>[3],
) {
	const { doc } = await loadDoc(ctx, projectId);
	const { command, existing } = importCommand(doc, reg);
	let mediaId = existing;
	let tx: Record<string, unknown> | null = null;
	if (command) {
		const res = await transact(
			ctx,
			projectId,
			{ label: existing ? 'Update Remotion bundle' : 'Import Remotion project', commands: [command] },
			extra,
		);
		const r = requireOk(res);
		mediaId =
			existing ?? r.refs.$bundle ?? (r.results[0] as { mediaId?: string } | undefined)?.mediaId ?? null;
		tx = txBody(res, r);
	}
	const after = (await loadDoc(ctx, projectId)).doc;
	const asset = mediaId ? after.media[mediaId] : undefined;
	return jsonResult({
		...(asset ? bundleSummary(asset) : { mediaId }),
		...(existing ? { updated: true } : {}),
		...(tx ? { revision: tx.revision, appliedLive: tx.appliedLive } : {}),
	});
}

/** The clip's composition source as the render snapshot sees it (effective props, handles). */
function clipSource(doc: ProjectDocument, clipId: string) {
	for (const seq of Object.values(doc.sequences)) {
		if (!seq.clips[clipId]) continue;
		const snap = buildRenderSnapshot(doc, seq.id, { resolveMedia: () => null, resolveFont: () => null });
		const clip = snap.videoTracks.flatMap((t) => t.clips).find((c) => c.clipId === clipId);
		if (!clip || !('composition' in clip.source)) break;
		return { seq, clip, src: clip.source.composition as RenderCompositionSource };
	}
	throw new ToolError(
		'E_NOT_FOUND',
		`Composition clip ${clipId} not found`,
		'Use get_timeline for clip ids.',
	);
}

export function registerCompositionTools(ctx: ToolContext): void {
	defineTool(
		ctx,
		'import_mg_bundle',
		{
			title: 'Import a Remotion project',
			description:
				'Imports a Remotion project folder (bundled with its own `remotion bundle`; remotion pinned to exactly 4.0.499, node_modules installed) or a built bundle folder (index.html + bundle.js) into a project, by absolute path on this machine. Its compositions become placeable clips (add_composition). watch: true rebuilds on source changes. Returns the mediaId and every composition with size, fps, length and props schema.',
			input: {
				projectId: ProjectIdArg,
				path: z.string().min(1).describe('Absolute path of the Remotion project (or built bundle) folder'),
				watch: z
					.boolean()
					.optional()
					.describe('Rebuild automatically when src/, public/ or the config change'),
			},
			annotations: { ...EDIT, idempotentHint: true },
		},
		async ({ projectId, path, watch }, extra) => {
			const reg = await ctx
				.engine((c) =>
					c.call('mgBundleImport', { body: { path, projectId, ...(watch ? { watch: true } : {}) } }),
				)
				.catch(engineToolError);
			return commitImport(ctx, projectId, reg, extra);
		},
	);

	defineTool(
		ctx,
		'list_compositions',
		{
			title: 'List compositions',
			description:
				'Lists the Remotion bundles of a project and their compositions: id, size, fps, length, props schema (type, default, constraints) and where the schema comes from.',
			input: {
				projectId: ProjectIdArg,
				mediaId: IdArg.optional().describe('Only this bundle (mediaId from import_mg_bundle)'),
			},
			annotations: READ_ONLY,
		},
		async ({ projectId, mediaId }) => {
			const { doc } = await loadDoc(ctx, projectId);
			const bundles = Object.values(doc.media).filter(
				(m) => m.kind === 'mg-bundle' && (!mediaId || m.id === mediaId),
			);
			if (mediaId && bundles.length === 0)
				throw new ToolError(
					'E_NOT_FOUND',
					`No Remotion bundle ${mediaId} in the project`,
					'Call list_compositions.',
				);
			return jsonResult({ bundles: bundles.map(bundleSummary) });
		},
	);

	defineTool(
		ctx,
		'add_composition',
		{
			title: 'Add composition clip',
			description:
				'Places a composition of an imported Remotion bundle on the timeline (clip.addComposition). Omitted props use the composition defaults; given props are validated against its schema. Default length = the composition length at the sequence frame rate (longer values are clamped).',
			input: {
				projectId: ProjectIdArg,
				mediaId: IdArg.describe('The bundle mediaId (import_mg_bundle / list_compositions)'),
				compositionId: IdArg.describe('Composition id, e.g. "Title"'),
				at: TimeArg('Start time'),
				track: TrackRefSchema.optional().describe('Video track (default V2)'),
				duration: TimeArg('Length (default: the composition length)').optional(),
				props: z.record(z.string(), z.unknown()).optional().describe('Props overrides'),
				sequenceId: z.string().optional().describe("Sequence id; default: the project's first sequence"),
			},
			annotations: EDIT,
		},
		async (a, extra) => {
			const res = await transact(
				ctx,
				a.projectId,
				{
					label: `Add ${a.compositionId}`,
					sequenceId: a.sequenceId,
					commands: [
						{
							type: 'clip.addComposition',
							composition: { mediaId: a.mediaId, id: a.compositionId },
							at: a.at,
							track: a.track ?? 'V2',
							...(a.duration !== undefined ? { duration: a.duration } : {}),
							...(a.props ? { props: a.props } : {}),
							...(a.sequenceId ? { sequenceId: a.sequenceId } : {}),
						},
					],
				},
				extra,
			);
			const r = requireOk(res);
			const { doc } = await loadDoc(ctx, a.projectId);
			const clips = [];
			for (const seq of Object.values(doc.sequences))
				for (const id of r.created) if (seq.clips[id]) clips.push(clipSummary(doc, seq, seq.clips[id]!));
			return jsonResult({ ...txBody(res, r), clips });
		},
	);

	defineTool(
		ctx,
		'set_composition_props',
		{
			title: 'Set composition props',
			description:
				'Edits the props of a composition clip. mode "merge" (default) deep-merges the given values into the current overrides (objects merge, arrays replace); "replace" makes them the whole override object ({} = back to the defaults). Validated against the composition schema (E_INVALID_PARAM with the failing prop).',
			input: {
				projectId: ProjectIdArg,
				clipId: IdArg.describe('Composition clip id ("clp_…")'),
				props: z.record(z.string(), z.unknown()).describe('Props values'),
				mode: z.enum(['merge', 'replace']).optional(),
			},
			annotations: EDIT,
		},
		async ({ projectId, clipId, props, mode }, extra) => {
			const { doc } = await loadDoc(ctx, projectId);
			let current: CompositionClip | undefined;
			for (const seq of Object.values(doc.sequences)) {
				const c = seq.clips[clipId];
				if (c?.kind === 'composition') current = c as CompositionClip;
			}
			if (!current)
				throw new ToolError(
					'E_NOT_FOUND',
					`Composition clip ${clipId} not found`,
					'Use get_timeline for clip ids.',
				);
			const next = mode === 'replace' ? props : mergeProps(current.props, props);
			const res = await transact(
				ctx,
				projectId,
				{ label: 'Edit Props', commands: [{ type: 'clip.update', clipId, patch: { props: next } }] },
				extra,
			);
			const r = requireOk(res);
			const after = (await loadDoc(ctx, projectId)).doc;
			const src = clipSource(after, clipId).src;
			return jsonResult({ ...txBody(res, r), overrides: next, effectiveProps: src.props });
		},
	);

	defineTool(
		ctx,
		'prerender_composition',
		{
			title: 'Pre-render a composition clip',
			description:
				'Renders a composition clip with its current props on the engine: quality "preview" (VP9 alpha, half size, whole composition) or "master" (ProRes 4444 straight alpha of the clip span incl. transition handles — what native exports use). Cached by props, size, frame rate, range and bundle content. wait: true waits for the job (bounded).',
			input: {
				projectId: ProjectIdArg,
				clipId: IdArg.describe('Composition clip id'),
				quality: z.enum(['preview', 'master']).optional().describe('Default master'),
				wait: z.boolean().optional().describe('Wait for the job (up to 600 s)'),
			},
			annotations: { ...EDIT, idempotentHint: true },
		},
		async ({ projectId, clipId, quality = 'master', wait }, extra) => {
			const { doc } = await loadDoc(ctx, projectId);
			const { seq, clip, src } = clipSource(doc, clipId);
			if (!src.info || !src.bundle?.key)
				throw new ToolError(
					'E_NOT_FOUND',
					`The bundle of ${clipId} or its composition ${src.compositionId} is missing`,
					'Re-import the Remotion project (import_mg_bundle).',
				);
			const fps = seq.settings.frameRate;
			const total = compositionSequenceFrames(src.info, fps);
			const range =
				quality === 'master'
					? compositionClipRenderRange(clip, fps, total)
					: { startFrame: 0, durationFrames: total };
			const req: MgPrerenderRequest = {
				projectId,
				mediaKey: src.bundle.key,
				compositionId: src.compositionId,
				props: src.props,
				width: src.canvas.width,
				height: src.canvas.height,
				fps: { num: fps.num, den: fps.den },
				startFrame: range.startFrame,
				durationFrames: range.durationFrames,
				quality,
			};
			const job = await ctx.engine((c) => c.call('mgBundlePrerender', { body: req })).catch(engineToolError);
			const base = ctx.link.target?.url ?? '';
			if (!wait || isTerminal(job)) return jsonResult({ job: jobBody(job, base) });
			const { job: done, timedOut } = await waitJob(ctx, job.id, 600_000, extra);
			return jsonResult({ job: jobBody(done, base), ...(timedOut ? { timedOut: true } : {}) });
		},
	);

	defineTool(
		ctx,
		'scaffold_mg_project',
		{
			title: 'New Remotion composition project',
			description:
				'Creates a new Remotion 4.0.499 project from the JasperEditor template in <dir>/<name> (one example composition with a zod props schema, jasper.mg.json), installs its dependencies, and imports it into the project with watch on: edit its src/ files and the editor rebuilds. Local engines only.',
			input: {
				projectId: ProjectIdArg,
				dir: z.string().min(1).describe('Absolute parent folder'),
				name: z.string().min(1).describe('Folder / package name (letters, digits, - and _)'),
				install: z.boolean().optional().describe('Install dependencies (default true)'),
			},
			annotations: EDIT,
		},
		async ({ projectId, dir, name, install }, extra) => {
			const reg = await ctx
				.engine((c) =>
					c.call('mgBundleScaffold', {
						body: { dir, name, projectId, ...(install === false ? { install: false } : {}) },
					}),
				)
				.catch(engineToolError);
			return commitImport(ctx, projectId, reg, extra);
		},
	);
}
