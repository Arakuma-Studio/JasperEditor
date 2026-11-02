// Spec 19 §12 for agents: layered PSD, alpha delivery and Export Title, layer-style import, image split and the gamut
// check. The engine does the work in cancellable jobs; these tools plan, wait, and report what the people get in dialogs.
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import {
	type AlphaDeliveryResult,
	DEFAULT_TRIM_MARGIN_PX,
	type EngineJob,
	type GamutCheckResult,
	type LayerStyleFile,
	MAX_ALPHA_FRAMES,
	MAX_SPLIT_PARTS,
	MAX_STYLE_FILE_BYTES,
	MAX_TRIM_MARGIN_PX,
	mediaRegisterCommand,
	type PsdPlan,
	type PsdResult,
	type RegisteredMedia,
	type SplitImageAnalysis,
	type SplitImageResult,
} from '@jasper/api';
import {
	clusterIslands,
	DEFAULT_MERGE,
	mapPsStyle,
	OUTPUT_SPACE_IDS,
	type ProjectDocument,
	PsStyleSchema,
	type Sequence,
} from '@jasper/project';
import { z } from 'zod';
import { ProjectIdArg, SequenceIdArg, timeArg } from '../arguments.ts';
import {
	applyCommands,
	cancelIfAborted,
	defineTool,
	EDIT,
	type Extra,
	findClip,
	frameOf,
	isTerminal,
	loadDoc,
	READ_ONLY,
	requireOk,
	type ToolContext,
	transact,
	waitJob,
} from '../context.ts';
import { toolEnvelope } from '../envelope.ts';
import { jsonResult, ToolError } from '../errors.ts';

export const DELIVERY_GUIDE = `Delivery and Photoshop:
- send_to_photoshop writes the frame as a layered 8-bit PSD: one raster layer per clip, registered to the frame, blend mode and opacity on the layer. Text is rasterised: it arrives as pixels. dryRun returns the layers, what is baked and any blockers, and writes nothing; call it first when the frame has adjustment layers or 3D. splitTitles makes a group per title with a look: rims and face (hidden) and fx (the whole look, shown).
- export_alpha writes PNGs with straight alpha: one frame (start + 1 = end, or at), or a sequence (a ZIP, or a folder with folder + name). It also covers transparent stills; export_frame stays for opaque formats. With clipIds it exports those clips alone; trimMarginPx trims every frame to what they paint across the whole range plus that margin, rendering past the sequence frame so glows do not clip. The result's origin says where the picture's corner sits in the sequence.
- import_layer_styles reads a .asl or .psd and returns one report per style: mapped, approximated, unsupported. dryRun reads without saving; without it the styles become project looks (look.apply {lookId}). A style holds pixels and a look percentages, so pass refPx, the text size the style was made for, when the report says the size is unknown.
- split_image cuts a still clip into connected parts: one clip per part, grouped, one undo step. dryRun lists the parts. mergePercent is the gap, in percent of the long side, under which islands stay one part (1.5 keeps a word together).
- check_gamut measures a frame against an output space: gamutPercent (colours the output cannot hold) and legalPercent (EBU R 103 limits after 4:2:0; R 103 tolerates under 1 %). Video gamuts only.`;

const NO_FOLDER_HINT = 'Omit folder to get the file as a URL.';

function seqOf(doc: ProjectDocument, sequenceId?: string): Sequence {
	const seq = sequenceId ? doc.sequences[sequenceId] : Object.values(doc.sequences)[0];
	if (!seq)
		throw new ToolError('E_NOT_FOUND', `Sequence not found: ${sequenceId ?? '(none)'}`, 'Call get_project.');
	return seq as Sequence;
}

async function finished<T>(
	ctx: ToolContext,
	job: EngineJob,
	seconds: number,
	extra: Extra,
	hint: string,
): Promise<T> {
	await cancelIfAborted(ctx, extra, job.id);
	const { job: done, timedOut } = await waitJob(ctx, job.id, seconds * 1000, extra);
	if (timedOut || !isTerminal(done))
		throw new ToolError(
			'JOB_RUNNING',
			`${done.title} is still running`,
			'Call wait_for_job with this jobId.',
			{
				jobId: job.id,
			},
		);
	if (done.state !== 'succeeded')
		throw new ToolError(
			done.error?.code ?? 'JOB_FAILED',
			done.error?.message ?? `The job ${done.state}`,
			hint,
			{
				jobId: job.id,
			},
		);
	return done.result as T;
}

const Destination = {
	folder: z.string().min(1).optional().describe('Absolute folder on the engine host; nothing is overwritten'),
	name: z.string().min(1).max(200).optional().describe('File name without extension'),
};

const destinationOf = (folder: string | undefined, name: string | undefined, fallback: string) =>
	folder ? { destination: { folder, name: name ?? fallback } } : {};

export function registerDeliveryTools(ctx: ToolContext): void {
	defineTool(
		ctx,
		'send_to_photoshop',
		{
			title: 'Send to Photoshop',
			description:
				'The frame as a layered, registered, rasterised 8-bit PSD. dryRun returns layers, what is baked and blockers without writing. Text arrives as pixels.',
			input: {
				projectId: ProjectIdArg,
				at: timeArg('Time of the frame'),
				sequenceId: SequenceIdArg,
				splitTitles: z.boolean().optional().describe('Group each title with a look into rims, face and fx'),
				dryRun: z.boolean().optional(),
				timeoutSeconds: z.number().int().min(1).max(3600).optional(),
				...Destination,
			},
			annotations: EDIT,
		},
		async ({ projectId, at, sequenceId, splitTitles, dryRun, timeoutSeconds, folder, name }, extra) => {
			const loaded = await loadDoc(ctx, projectId);
			const seq = seqOf(loaded.doc, sequenceId);
			const body = {
				envelope: toolEnvelope(loaded.doc, loaded.revision),
				sequenceId: seq.id,
				frame: frameOf(seq, at),
				...(splitTitles ? { splitTitles: true } : {}),
				...destinationOf(folder, name, 'Frame'),
			};
			const plan: PsdPlan = await ctx.engine((c) => c.call('psdPlan', { body: body as never }));
			if (dryRun || plan.blockers.length)
				return jsonResult({
					written: false,
					...plan,
					next: plan.blockers.length ? 'Fix the blockers.' : 'Call again without dryRun.',
				});
			const job = await ctx.engine((c) => c.call('psdExport', { body: body as never }));
			const r = await finished<PsdResult>(ctx, job, timeoutSeconds ?? 900, extra, NO_FOLDER_HINT);
			return jsonResult({ written: true, jobId: job.id, ...r });
		},
	);

	defineTool(
		ctx,
		'export_alpha',
		{
			title: 'Export PNGs with alpha',
			description:
				'Transparent PNG frames: a still or a numbered sequence, the sequence or some clips alone (clipIds), optionally trimmed to their content with a margin so glows do not clip.',
			input: {
				projectId: ProjectIdArg,
				start: timeArg('First frame'),
				end: timeArg('End of the range, exclusive (default: one frame)').optional(),
				sequenceId: SequenceIdArg,
				clipIds: z
					.array(z.string().min(1))
					.min(1)
					.max(256)
					.optional()
					.describe('Only these clips (Export Title)'),
				trimMarginPx: z
					.number()
					.int()
					.min(0)
					.max(MAX_TRIM_MARGIN_PX)
					.optional()
					.describe(`Trim to content with this margin (Export Title's default is ${DEFAULT_TRIM_MARGIN_PX})`),
				timeoutSeconds: z.number().int().min(1).max(7200).optional(),
				...Destination,
			},
			annotations: EDIT,
		},
		async (
			{ projectId, start, end, sequenceId, clipIds, trimMarginPx, timeoutSeconds, folder, name },
			extra,
		) => {
			const loaded = await loadDoc(ctx, projectId);
			const seq = seqOf(loaded.doc, sequenceId);
			const s = frameOf(seq, start);
			const e = end === undefined ? s + 1 : frameOf(seq, end);
			if (e <= s || e - s > MAX_ALPHA_FRAMES)
				throw new ToolError(
					'E_INVALID_PARAM',
					`The range must hold 1 to ${MAX_ALPHA_FRAMES} frames`,
					'Check start and end.',
				);
			const job = await ctx.engine((c) =>
				c.call('alphaDelivery', {
					body: {
						envelope: toolEnvelope(loaded.doc, loaded.revision),
						sequenceId: seq.id,
						range: { start: s, end: e },
						...(clipIds ? { clipIds } : {}),
						...(trimMarginPx !== undefined ? { trim: { marginPx: trimMarginPx } } : {}),
						...destinationOf(folder, name, 'Title'),
					} as never,
				}),
			);
			const r = await finished<AlphaDeliveryResult>(ctx, job, timeoutSeconds ?? 900, extra, NO_FOLDER_HINT);
			return jsonResult({ jobId: job.id, ...r });
		},
	);

	defineTool(
		ctx,
		'import_layer_styles',
		{
			title: 'Import layer styles',
			description:
				'The layer styles of a Photoshop .asl or .psd as project looks, with a report per style of what was mapped, approximated and not supported. dryRun saves nothing.',
			input: {
				projectId: ProjectIdArg,
				path: z.string().min(1).describe('Absolute path of the .asl or .psd'),
				names: z.array(z.string().min(1)).max(500).optional().describe('Only these styles'),
				refPx: z
					.number()
					.positive()
					.max(4000)
					.optional()
					.describe('Text size the styles were made for (default: read from the file, else suggested)'),
				dryRun: z.boolean().optional(),
			},
			annotations: EDIT,
		},
		async ({ projectId, path, names, refPx, dryRun }, extra) => {
			if (!isAbsolute(path))
				throw new ToolError('NOT_ABSOLUTE', `Not an absolute path: ${path}`, 'Pass an absolute path.');
			const st = statSync(path, { throwIfNoEntry: false });
			if (!st?.isFile())
				throw new ToolError('FILE_NOT_FOUND', `No such file on this machine: ${path}`, 'Check the path.');
			if (st.size > MAX_STYLE_FILE_BYTES)
				throw new ToolError(
					'STYLE_FILE_TOO_LARGE',
					`Style files are read up to ${MAX_STYLE_FILE_BYTES / 1024 ** 2} MiB`,
					'Export the styles as an .asl.',
				);
			const file: LayerStyleFile = await ctx.engine((c) =>
				c.call('layerStylesRead', {
					body: readFileSync(path),
					query: { name: path.split(/[\\/]/).pop() ?? 'styles' },
				}),
			);
			const wanted = file.styles.filter((s) => !names || names.includes(s.name));
			const looks = wanted.map((s) => {
				const size = refPx ?? s.refPx;
				const { recipe, report } = mapPsStyle(PsStyleSchema.parse(s.style), size);
				return {
					name: s.name,
					origin: s.origin,
					refPx: size,
					refKnown: s.refKnown,
					refNote: s.refNote,
					recipe,
					report,
				};
			});
			if (dryRun || !looks.length)
				return jsonResult({
					saved: false,
					skipped: file.skipped,
					styles: looks.map(({ recipe: _r, ...l }) => l),
				});
			const res = await transact(
				ctx,
				projectId,
				{
					label: 'Import Layer Styles',
					commands: looks.map((l) => ({ type: 'look.create', name: l.name, recipe: l.recipe, link: false })),
				},
				extra,
			);
			const r = requireOk(res);
			return jsonResult({
				saved: true,
				skipped: file.skipped,
				styles: looks.map(({ recipe: _r, ...l }, i) => ({
					...l,
					lookId: (r.results[i] as { lookId?: string } | undefined)?.lookId,
				})),
				revision: r.revision,
				next: 'look.apply {clipIds, lookId}',
			});
		},
	);

	defineTool(
		ctx,
		'split_image',
		{
			title: 'Split image into parts',
			description:
				'A still clip into its connected parts as separate, grouped clips, one undo step, registered where they were. dryRun lists the parts; colour under low alpha is kept exactly.',
			input: {
				projectId: ProjectIdArg,
				clipId: z.string().min(1),
				mergePercent: z
					.number()
					.min(0)
					.max(100)
					.optional()
					.describe(`Gap under which islands stay one part, % of the long side (default ${DEFAULT_MERGE})`),
				dryRun: z.boolean().optional(),
				timeoutSeconds: z.number().int().min(1).max(3600).optional(),
			},
			annotations: EDIT,
		},
		async ({ projectId, clipId, mergePercent, dryRun, timeoutSeconds }, extra) => {
			const { doc } = await loadDoc(ctx, projectId);
			const { clip } = findClip(doc, clipId);
			if (clip.kind !== 'still')
				throw new ToolError(
					'E_INVALID_PARAM',
					'Only a still image can be split',
					'Pick a still clip from get_timeline.',
				);
			const asset = doc.media[clip.mediaId];
			const key = asset?.locators.find((l) => l.type === 'engine-store')?.key;
			if (!key) throw new ToolError('E_NOT_FOUND', 'The picture is not on the engine', 'Relink the media.');
			const seconds = timeoutSeconds ?? 300;
			const a = await finished<SplitImageAnalysis>(
				ctx,
				await ctx.engine((c) => c.call('splitImageAnalyze', { params: { key } })),
				seconds,
				extra,
				'Check the media with get_media_info.',
			);
			const parts = clusterIslands(a, mergePercent ?? DEFAULT_MERGE);
			const body = parts.map((p) => p.box);
			if (dryRun)
				return jsonResult({ islands: a.islands.length, parts: body, bitDepth: a.bitDepth, split: false });
			if (parts.length < 2)
				throw new ToolError(
					'SPLIT_ONE_PART',
					'The picture is one part at this distance',
					'Lower mergePercent.',
				);
			if (parts.length > MAX_SPLIT_PARTS)
				throw new ToolError(
					'E_LIMIT',
					`${parts.length} parts; at most ${MAX_SPLIT_PARTS}`,
					'Raise mergePercent.',
				);
			const done = await finished<SplitImageResult>(
				ctx,
				await ctx.engine((c) =>
					c.call('splitImage', {
						params: { key },
						body: { groups: parts.map((p) => p.islands), projectId },
					}),
				),
				seconds,
				extra,
				'Check the media with get_media_info.',
			);
			return applyCommands(
				ctx,
				projectId,
				'Split Image',
				[
					...done.parts.map((p, i) =>
						mediaRegisterCommand(p.media as RegisteredMedia, `$m${i}`, `$i${i}`, `${clip.name} ${i + 1}`),
					),
					{
						type: 'clip.splitImage',
						clipId,
						parts: done.parts.map((p, i) => ({
							mediaId: `$m${i}`,
							box: p.box,
							name: `${clip.name} ${i + 1}`,
						})),
					},
				],
				extra,
			);
		},
	);

	defineTool(
		ctx,
		'check_gamut',
		{
			title: 'Check gamut and legal range',
			description:
				'Percent of a frame outside an output gamut, and outside the EBU R 103 legal range after 4:2:0. Video gamuts only. Returns a mask URL of the flagged pixels.',
			input: {
				projectId: ProjectIdArg,
				at: timeArg('Time of the frame'),
				sequenceId: SequenceIdArg,
				output: z
					.enum(['working', ...OUTPUT_SPACE_IDS])
					.optional()
					.describe('Output space (default: the working space)'),
			},
			annotations: READ_ONLY,
		},
		async ({ projectId, at, sequenceId, output }, extra) => {
			const loaded = await loadDoc(ctx, projectId);
			const seq = seqOf(loaded.doc, sequenceId);
			const job = await ctx.engine((c) =>
				c.call('gamutCheck', {
					body: {
						envelope: toolEnvelope(loaded.doc, loaded.revision),
						sequenceId: seq.id,
						frame: frameOf(seq, at),
						...(output ? { output } : {}),
					} as never,
				}),
			);
			const r = await finished<GamutCheckResult>(ctx, job, 300, extra, 'Check the frame with render_frame.');
			return jsonResult({ jobId: job.id, ...r });
		},
	);
}
