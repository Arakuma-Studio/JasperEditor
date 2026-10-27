import { existsSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type {
	ImageSequenceRequest,
	LayeredExtractResult,
	LottieExportResult,
	RegisteredMedia,
	VectorPagesResponse,
} from '@jasper/api';
import { mediaRegisterCommand, toLayeredImportLayers } from '@jasper/api';
import {
	type Command,
	FLICKS_PER_SECOND,
	fileFieldOrder,
	fileFrameRate,
	filePixelAspect,
	interpretedFrameRate,
	isPictureMedia,
	isTimedMedia,
	type LayeredImportLayer,
	layeredImportCommands,
	type MediaAsset,
	mediaAlpha,
	mediaDisplaySize,
	mediaDurationFlicks,
	mediaFieldOrder,
	mediaLoopCount,
	mediaPixelAspect,
	type ProjectDocument,
	type Rational,
	rationalFromFps,
} from '@jasper/project';
import { z } from 'zod';
import { ProjectIdArg, timeArg } from '../arguments.ts';
import {
	defineTool,
	EDIT,
	EDIT_IDEMPOTENT,
	frameOf,
	loadDoc,
	READ_ONLY,
	requireOk,
	type ToolContext,
	transact,
	txBody,
	waitJob,
} from '../context.ts';
import { toolEnvelope } from '../envelope.ts';
import { jsonResult, ToolError } from '../errors.ts';
import { mediaSummary, pickSequence } from '../format.ts';

export const IMPORTS_GUIDE = `Imports (Lottie, SVG, PDF/AI, PSD, image sequences, still formats) and Interpret Footage:
- import_media takes Lottie (.json/.lottie: an animated clip drawn frame-exactly on every path), SVG/SVGZ and PDF/AI (vector stills, sharp at any scale; a PDF imports its first page — import_pdf_pages picks pages), PSD/PSB (flattened), EXR (half/float), TIFF (8/16-bit), TGA, BMP, DPX, HEIC/HEIF, JPEG XL, plus the usual video/audio/image files.
- svg_to_shape turns SVG markup into an editable vector shape layer (Premiere's/After Effects' Create Shapes from Vector Layer).
- import_image_sequence: numbered stills (shot_0001.exr …) become one clip at a frame rate; give one frame (its numbered siblings in the folder are found) or every frame. Missing numbers inside the range hold the previous frame (reported as missing). detect_image_sequence previews what a frame belongs to.
- PSD: list_document_layers shows the layer tree (index, kind, blend mode, opacity, visibility, clipping, bounds, notes for what cannot be carried such as adjustment layers and layer styles). import_layered_document mode merged-all = flattened picture, merged = the chosen layers merged into one picture, individual = a bin with one item per layer, sequence = a new sequence (document size) with every layer on its own track at its position, opacity, blend mode (Photoshop modes map to the same-named blend modes; Linear Dodge = Add), visibility, isolating groups as nested sequences and clipping masks as Track Matte Keys.
- interpret_footage (Premiere Modify ▸ Interpret Footage) on media: frameRate (assume this rate: the clip's speed and length follow), pixelAspect (conform to; non-square pixels are stretched on every path), fieldOrder (upper/lower = deinterlaced on every path, progressive = treated as progressive), alpha (straight / premultiplied with a matte colour / ignore, invert), loop (plays N times). null resets a field to the file's value. Clips that would run past the new media end are trimmed (warning W_CLIPS_TRIMMED). get_media_interpretation shows the file values next to the interpreted ones.
- export_lottie writes a sequence's graphics (vector shapes, shape/text/solid clips, stills, nested sequences, Lottie clips) as Lottie JSON or .lottie, with eases, spatial paths, masks, blend modes and text animators where Lottie can express them; everything it cannot express is listed in warnings.`;

const RationalArg = z.strictObject({
	num: z.number().int().min(1).max(1_000_000_000),
	den: z.number().int().min(1).max(1_000_000_000),
});
const FpsArg = z
	.union([z.number().min(1).max(1000), RationalArg])
	.describe(
		'Frames per second: a number (23.976, 25, 29.97…; NTSC rates become 1001 fractions) or {num, den}',
	);

function toRate(v: number | Rational): Rational {
	if (typeof v !== 'number') return v;
	const r = rationalFromFps(v);
	if (!r) throw new ToolError('E_INVALID_PARAM', `Not a frame rate: ${v}`, 'Use 1…1000 fps.');
	return r;
}

function checkFile(path: string): void {
	if (!isAbsolute(path))
		throw new ToolError(
			'NOT_ABSOLUTE',
			`Not an absolute path: ${path}`,
			'Pass the absolute path of the file.',
		);
	if (!existsSync(path) || !statSync(path).isFile())
		throw new ToolError('FILE_NOT_FOUND', `No such file on this machine: ${path}`, 'Check the path.');
}

const fps = (r: Rational | null) => (r ? Math.round((r.num / r.den) * 1000) / 1000 : null);
const ratio = (r: Rational) => Math.round((r.num / r.den) * 10000) / 10000;

/** What get_media_interpretation reports for one asset. */
function describeInterpretation(asset: MediaAsset) {
	const timed = isTimedMedia(asset);
	const picture = isPictureMedia(asset);
	const dur = mediaDurationFlicks(asset);
	const size = mediaDisplaySize(asset);
	const alpha = mediaAlpha(asset);
	return {
		mediaId: asset.id,
		kind: asset.kind,
		interpretation: asset.interpretation ?? null,
		file: {
			...(timed ? { frameRate: fileFrameRate(asset), fps: fps(fileFrameRate(asset)) } : {}),
			...(picture ? { pixelAspect: filePixelAspect(asset), fieldOrder: fileFieldOrder(asset) } : {}),
		},
		effective: {
			...(timed
				? {
						frameRate: interpretedFrameRate(asset),
						fps: fps(interpretedFrameRate(asset)),
						loop: mediaLoopCount(asset),
					}
				: {}),
			...(picture
				? {
						pixelAspect: ratio(mediaPixelAspect(asset)),
						fieldOrder: mediaFieldOrder(asset),
						alpha: {
							mode: alpha.mode,
							...(alpha.mode === 'premultiplied' ? { matte: alpha.matte } : {}),
							invert: alpha.invert,
						},
					}
				: {}),
			...(dur !== null ? { durationSeconds: Math.round((dur / FLICKS_PER_SECOND) * 1000) / 1000 } : {}),
			...(size ? { displaySize: [size.width, size.height] } : {}),
		},
		...(asset.vector ? { vector: asset.vector } : {}),
		...(asset.lottie ? { lottie: asset.lottie } : {}),
		...(asset.imageSequence ? { imageSequence: asset.imageSequence } : {}),
		...(asset.layered ? { layered: asset.layered } : {}),
		...(asset.layerSource ? { layerSource: asset.layerSource } : {}),
	};
}

async function finishedJob<T>(
	ctx: ToolContext,
	jobId: string,
	extra: Parameters<typeof waitJob>[3],
	what: string,
): Promise<T> {
	const { job, timedOut } = await waitJob(ctx, jobId, 30 * 60_000, extra);
	if (timedOut)
		throw new ToolError(
			'E_TIMEOUT',
			`${what} is still running (job ${jobId})`,
			'Call wait_for_job, then retry.',
		);
	if (job.state !== 'succeeded')
		throw new ToolError(
			job.error?.code ?? 'JOB_FAILED',
			`${what} failed: ${job.error?.message ?? job.state}`,
			'Check the file; get_job shows the engine log.',
		);
	return job.result as T;
}

async function registerOne(ctx: ToolContext, projectId: string, path: string): Promise<RegisteredMedia> {
	checkFile(path);
	const reg = await ctx.engine((c) => c.registerMedia({ projectId, paths: [path] }));
	const item = reg.items[0];
	if (!item) {
		const e = reg.errors[0];
		throw new ToolError(e?.code ?? 'E_IMPORT', e?.message ?? `Could not import ${path}`, 'Check the file.');
	}
	return item;
}

/** Media ids of the transaction's `media.register` commands at `indexes`. */
function registeredIds(r: ReturnType<typeof requireOk>, refs: string[]): string[] {
	return refs.map((ref) => r.refs[ref]).filter((x): x is string => typeof x === 'string');
}

function layerTree(layers: LayeredExtractResult['layers']): unknown[] {
	return layers.map((l) => ({
		index: l.index,
		name: l.name,
		kind: l.kind,
		visible: l.visible,
		opacity: Math.round(l.opacity * 1000) / 1000,
		blendMode: l.blendMode,
		...(l.clipping ? { clipping: true } : {}),
		bounds: [l.left, l.top, l.width, l.height],
		...(l.media ? {} : { picture: false }),
		...(l.notes?.length ? { notes: l.notes } : {}),
		...(l.children?.length ? { children: layerTree(l.children) } : {}),
	}));
}

export function registerImportsTools(ctx: ToolContext): void {
	defineTool(
		ctx,
		'get_media_interpretation',
		{
			title: 'Get media interpretation',
			description:
				"Interpret Footage values of media: the file's frame rate, pixel aspect ratio and field order next to the interpreted (effective) frame rate, loop count, pixel aspect, field order, alpha mode, duration and display size, plus the descriptors of vector (SVG/PDF), Lottie, image-sequence and layered (PSD) media.",
			input: {
				projectId: ProjectIdArg,
				mediaIds: z.array(z.string().min(1)).min(1).max(500).optional().describe('Default: every media'),
			},
			annotations: READ_ONLY,
		},
		async ({ projectId, mediaIds }) => {
			const { doc } = await loadDoc(ctx, projectId);
			const ids = mediaIds ?? Object.keys(doc.media);
			const missing = ids.filter((id) => !doc.media[id]);
			if (missing.length)
				throw new ToolError(
					'E_NOT_FOUND',
					`Media not found: ${missing.join(', ')}`,
					'Call list_media for ids.',
				);
			return jsonResult({ media: ids.map((id) => describeInterpretation(doc.media[id] as MediaAsset)) });
		},
	);

	defineTool(
		ctx,
		'interpret_footage',
		{
			title: 'Interpret footage',
			description:
				'Premiere Modify ▸ Interpret Footage on one or more media (one undo step). Omitted fields stay as they are; null resets a field to the file value. frameRate: assume this frame rate (video, animated images, Lottie, image sequences); pixelAspect: conform to (e.g. {num:10,den:11} DV NTSC, {num:2,den:1} anamorphic 2:1); fieldOrder: progressive / upper / lower (interlaced pictures are deinterlaced in the preview and every export); alpha: {mode: straight | premultiplied (matte: [r,g,b,a] 0…1, default black) | ignore, invert}; loop: play the media N times. Clips that would run past the new media end are trimmed.',
			input: {
				projectId: ProjectIdArg,
				mediaIds: z.array(z.string().min(1)).min(1).max(500).describe('Media ids from list_media'),
				frameRate: FpsArg.nullable().optional(),
				pixelAspect: z
					.union([z.number().gt(0).max(10), RationalArg])
					.nullable()
					.optional()
					.describe('Pixel aspect ratio: a number (1.0, 0.9091, 2…) or {num, den}'),
				fieldOrder: z.enum(['progressive', 'upper', 'lower']).nullable().optional(),
				alpha: z
					.strictObject({
						mode: z.enum(['straight', 'premultiplied', 'ignore']),
						matte: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
						invert: z.boolean().optional(),
					})
					.nullable()
					.optional(),
				loop: z.number().int().min(1).max(1000).nullable().optional(),
			},
			annotations: EDIT_IDEMPOTENT,
		},
		async (a, extra) => {
			const interpretation: Record<string, unknown> = {};
			if (a.frameRate !== undefined)
				interpretation.frameRate = a.frameRate === null ? null : toRate(a.frameRate);
			if (a.pixelAspect !== undefined)
				interpretation.pixelAspect =
					a.pixelAspect === null
						? null
						: typeof a.pixelAspect === 'number'
							? { num: Math.round(a.pixelAspect * 10000), den: 10000 }
							: a.pixelAspect;
			if (a.fieldOrder !== undefined) interpretation.fieldOrder = a.fieldOrder;
			if (a.alpha !== undefined) interpretation.alpha = a.alpha;
			if (a.loop !== undefined) interpretation.loop = a.loop;
			if (!Object.keys(interpretation).length)
				throw new ToolError(
					'E_INVALID_PARAM',
					'Nothing to change',
					'Give frameRate, pixelAspect, fieldOrder, alpha or loop (null resets).',
				);
			const res = await transact(
				ctx,
				a.projectId,
				{
					label: 'Interpret Footage',
					commands: [{ type: 'media.interpret', mediaIds: a.mediaIds, interpretation }],
				},
				extra,
			);
			const r = requireOk(res);
			const { doc } = await loadDoc(ctx, a.projectId);
			return jsonResult({
				...txBody(res, r),
				media: a.mediaIds.flatMap((id) =>
					doc.media[id] ? [describeInterpretation(doc.media[id] as MediaAsset)] : [],
				),
			});
		},
	);

	defineTool(
		ctx,
		'detect_image_sequence',
		{
			title: 'Detect image sequence',
			description:
				'The numbered image sequence a still belongs to (its siblings in the same folder): pattern, first/last number, frame count and missing numbers. Nothing is imported.',
			input: { path: z.string().min(1).describe('Absolute path of one frame, e.g. /shots/a/shot_0001.exr') },
			annotations: READ_ONLY,
		},
		async ({ path }) => {
			checkFile(path);
			return jsonResult(await ctx.engine((c) => c.detectImageSequence(path)));
		},
	);

	defineTool(
		ctx,
		'import_image_sequence',
		{
			title: 'Import image sequence',
			description:
				'Imports numbered stills as one clip (Premiere Import ▸ Image Sequence): pass one frame `path` (its numbered siblings are found) or every frame in `paths`. The frames (any still format: PNG, JPEG, EXR, DPX, TIFF, TGA…) are conformed losslessly at `frameRate`; numbers missing inside the range hold the previous frame. Returns the mediaId (place it with add_clip).',
			input: {
				projectId: ProjectIdArg,
				path: z.string().min(1).optional().describe('Absolute path of one frame of the sequence'),
				paths: z
					.array(z.string().min(1))
					.min(1)
					.max(100_000)
					.optional()
					.describe('Absolute paths of the frames'),
				frameRate: FpsArg,
				name: z.string().min(1).max(512).optional().describe('Project item name (default: the pattern)'),
			},
			annotations: EDIT,
		},
		async (a, extra) => {
			if ((a.path === undefined) === (a.paths === undefined))
				throw new ToolError(
					'E_INVALID_PARAM',
					'Give exactly one of path or paths',
					'path = one frame of the sequence.',
				);
			for (const p of a.paths ?? [a.path!]) checkFile(p);
			const req: ImageSequenceRequest = {
				projectId: a.projectId,
				frameRate: toRate(a.frameRate),
				...(a.path ? { path: a.path } : { paths: a.paths! }),
				...(a.name ? { name: a.name } : {}),
			};
			const job = await ctx.engine((c) => c.importImageSequence(req));
			const reg = await finishedJob<RegisteredMedia>(ctx, job.id, extra, 'The image sequence conform');
			const res = await transact(
				ctx,
				a.projectId,
				{
					label: 'Import Image Sequence',
					commands: [mediaRegisterCommand(reg, '$m', '$i', a.name ?? reg.imageSequence?.pattern)],
				},
				extra,
			);
			const r = requireOk(res);
			const { doc } = await loadDoc(ctx, a.projectId);
			const mediaId = r.refs.$m ?? (r.results[0] as { mediaId?: string } | undefined)?.mediaId;
			const asset = mediaId ? doc.media[mediaId] : undefined;
			return jsonResult({
				...(asset ? mediaSummary(doc, asset) : {}),
				mediaId,
				itemId: r.refs.$i,
				imageSequence: reg.imageSequence,
			});
		},
	);

	defineTool(
		ctx,
		'list_document_layers',
		{
			title: 'List layers of a PSD',
			description:
				"The layer tree of a Photoshop document (.psd/.psb), bottom layer first: index (for import_layered_document's layers), name, kind (pixel, group, text, shape, adjustment, smart-object, empty), visibility, opacity (× fill), blend mode, clipping, bounds [left, top, width, height] in document pixels, and notes on what cannot be carried. The engine extracts each layer's picture (cached for the import).",
			input: {
				projectId: ProjectIdArg,
				path: z.string().min(1).describe('Absolute path of the .psd / .psb'),
			},
			annotations: READ_ONLY,
		},
		async ({ projectId, path }, extra) => {
			const reg = await registerOne(ctx, projectId, path);
			if (!reg.layered)
				throw new ToolError('E_NOT_LAYERED', `Not a layered document: ${path}`, 'Use a .psd or .psb file.');
			const job = await ctx.engine((c) => c.extractLayers(reg.mediaKey, projectId));
			const result = await finishedJob<LayeredExtractResult>(ctx, job.id, extra, 'Layer extraction');
			return jsonResult({ info: result.info, layers: layerTree(result.layers), warnings: result.warnings });
		},
	);

	defineTool(
		ctx,
		'import_layered_document',
		{
			title: 'Import a PSD',
			description:
				'Imports a Photoshop document (Premiere Import Layered File, one undo step): mode merged-all = the flattened picture; merged = the chosen `layers` merged into one picture; individual = a bin "<name> Layers" with one item per chosen layer; sequence = that bin plus a new sequence of the document size with each layer on its own track (bottom layer on V1) at its position, with its opacity, blend mode and visibility (hidden layers become disabled clips), groups that isolate as nested sequences and clipping masks as Track Matte Keys. layers = indexes from list_document_layers (default: every layer with a picture).',
			input: {
				projectId: ProjectIdArg,
				path: z.string().min(1).describe('Absolute path of the .psd / .psb'),
				mode: z.enum(['merged-all', 'merged', 'individual', 'sequence']),
				layers: z.array(z.number().int().min(0)).min(1).max(5000).optional(),
				frameRate: FpsArg.optional().describe('Frame rate of the sequence (mode sequence; default 30)'),
				binId: z.string().min(1).optional().describe('Bin to import into (default: the root)'),
			},
			annotations: EDIT,
		},
		async (a, extra) => {
			const reg = await registerOne(ctx, a.projectId, a.path);
			if (!reg.layered && a.mode !== 'merged-all')
				throw new ToolError(
					'E_NOT_LAYERED',
					`Not a layered document: ${a.path}`,
					'Use mode merged-all or import_media.',
				);
			const name = reg.originalName.replace(/\.(psd|psb)$/i, '');
			let commands: Command[];
			let notes: string[] = [];
			let warnings: string[] = [];
			if (a.mode === 'merged-all') commands = [mediaRegisterCommand(reg, '$m0', '$i0')];
			else {
				const job = await ctx.engine((c) =>
					c.extractLayers(
						reg.mediaKey,
						a.projectId,
						false,
						a.mode === 'merged' ? (a.layers ?? []) : undefined,
					),
				);
				const result = await finishedJob<LayeredExtractResult>(ctx, job.id, extra, 'Layer extraction');
				warnings = result.warnings;
				if (a.mode === 'merged') {
					if (!a.layers)
						throw new ToolError(
							'E_INVALID_PARAM',
							'mode merged needs layers',
							'Pass layer indexes from list_document_layers.',
						);
					if (!result.merged)
						throw new ToolError('E_IMPORT', 'The engine made no merged picture', 'Check the layer indexes.');
					commands = [mediaRegisterCommand(result.merged, '$m0', '$i0', `${name} (merged)`)];
				} else {
					const layers: LayeredImportLayer[] = toLayeredImportLayers(
						result.layers,
						(m) => mediaRegisterCommand(m, '', '').asset,
					);
					const built = layeredImportCommands({
						docName: name,
						documentSize: { width: result.info.width, height: result.info.height },
						frameRate: a.frameRate !== undefined ? toRate(a.frameRate) : { num: 30, den: 1 },
						layers,
						...(a.layers ? { selected: new Set(a.layers) } : {}),
						mode: a.mode,
						binId: a.binId ?? null,
						now: new Date().toISOString(),
						refPrefix: '$l',
					});
					commands = built.commands;
					notes = built.notes;
				}
			}
			if (a.binId && (a.mode === 'merged-all' || a.mode === 'merged'))
				(commands[0] as { binId?: string }).binId = a.binId;
			const res = await transact(ctx, a.projectId, { label: `Import ${reg.originalName}`, commands }, extra);
			const r = requireOk(res);
			const { doc } = await loadDoc(ctx, a.projectId);
			const mediaIds =
				a.mode === 'merged-all' || a.mode === 'merged'
					? registeredIds(r, ['$m0'])
					: Object.entries(r.refs)
							.filter(([k]) => /^\$lm\d+$/.test(k))
							.map(([, v]) => v);
			return jsonResult({
				mode: a.mode,
				media: mediaIds.flatMap((id) => (doc.media[id] ? [mediaSummary(doc, doc.media[id]!)] : [])),
				...(r.refs.$lbin ? { binId: r.refs.$lbin } : {}),
				...(r.refs.$lseq ? { sequenceId: r.refs.$lseq } : {}),
				revision: r.revision,
				...(notes.length || warnings.length ? { notes: [...warnings, ...notes] } : {}),
			});
		},
	);

	defineTool(
		ctx,
		'import_pdf_pages',
		{
			title: 'Import PDF pages',
			description:
				'Imports pages of a PDF or PDF-compatible Illustrator (.ai) file as vector stills (sharp at any scale on every path), one Project item per page. Without pages it lists the pages (number, size in points) and imports nothing.',
			input: {
				projectId: ProjectIdArg,
				path: z.string().min(1).describe('Absolute path of the .pdf / .ai'),
				pages: z.array(z.number().int().min(1)).min(1).max(2000).optional().describe('1-based page numbers'),
			},
			annotations: EDIT,
		},
		async (a, extra) => {
			const reg = await registerOne(ctx, a.projectId, a.path);
			const v = reg.vector;
			if (v?.format !== 'pdf')
				throw new ToolError(
					'E_NOT_PDF',
					`Not a PDF or Illustrator file: ${a.path}`,
					'Use import_media for other files.',
				);
			const info: VectorPagesResponse = await ctx.engine((c) => c.vectorPages(reg.mediaKey));
			if (!a.pages) return jsonResult({ pageCount: info.pages.length, pages: info.pages });
			const bad = a.pages.filter((p) => !info.pages.some((x) => x.page === p));
			if (bad.length)
				throw new ToolError(
					'E_INVALID_PARAM',
					`No page ${bad.join(', ')} (the document has ${info.pages.length})`,
					'Call import_pdf_pages without pages for the list.',
				);
			const base = reg.originalName.replace(/\.(pdf|ai)$/i, '');
			const commands = a.pages.map((page, i) => {
				const p = info.pages.find((x) => x.page === page)!;
				const w = Math.max(1, Math.round(p.width));
				const h = Math.max(1, Math.round(p.height));
				const one: RegisteredMedia = {
					...reg,
					vector: { ...v, page, width: p.width, height: p.height },
					probe: {
						...reg.probe,
						streams: reg.probe.streams.map((s) => (s.type === 'video' ? { ...s, width: w, height: h } : s)),
					},
				};
				return mediaRegisterCommand(
					one,
					`$m${i}`,
					`$i${i}`,
					a.pages!.length > 1 || page !== 1 ? `${base} (page ${page})` : undefined,
				);
			});
			const res = await transact(ctx, a.projectId, { label: `Import ${reg.originalName}`, commands }, extra);
			const r = requireOk(res);
			const { doc } = await loadDoc(ctx, a.projectId);
			return jsonResult({
				imported: a.pages.map((page, i) => {
					const id = r.refs[`$m${i}`] ?? (r.results[i] as { mediaId?: string } | undefined)?.mediaId;
					return { page, ...(id && doc.media[id] ? mediaSummary(doc, doc.media[id]!) : {}), mediaId: id };
				}),
			});
		},
	);

	defineTool(
		ctx,
		'export_lottie',
		{
			title: 'Export Lottie',
			description:
				"Exports a sequence's graphics as a Lottie animation (.json, or .lottie with format dotlottie): vector shapes (paths, fills, strokes, gradients, trim paths, repeaters), shape/solid clips, text with its text animators, stills (embedded), nested sequences (precomps) and Lottie clips; transforms, opacity, keyframe eases and spatial paths exactly, masks, Gaussian Blur and blend modes. Video, audio and effects Lottie cannot express are skipped and listed in warnings.",
			input: {
				projectId: ProjectIdArg,
				outputPath: z.string().min(1).describe('Absolute path of the file to write (.json or .lottie)'),
				sequenceId: z.string().min(1).optional().describe('Default: the first sequence'),
				format: z
					.enum(['json', 'dotlottie'])
					.optional()
					.describe('Default: from the extension (.lottie = dotlottie)'),
				start: timeArg('Range start (default 0)').optional(),
				end: timeArg('Range end, exclusive (default: the sequence end)').optional(),
			},
			annotations: { ...EDIT, destructiveHint: false, openWorldHint: false },
		},
		async (a) => {
			if (!isAbsolute(a.outputPath))
				throw new ToolError(
					'NOT_ABSOLUTE',
					`Not an absolute path: ${a.outputPath}`,
					'Pass an absolute output path.',
				);
			const { doc, revision } = await loadDoc(ctx, a.projectId);
			let seq: ReturnType<typeof pickSequence>;
			try {
				seq = pickSequence(doc as ProjectDocument, a.sequenceId);
			} catch (e) {
				throw new ToolError('E_NOT_FOUND', (e as Error).message, 'Call get_project for sequence ids.');
			}
			const start = a.start !== undefined ? frameOf(seq, a.start) : undefined;
			const end = a.end !== undefined ? frameOf(seq, a.end) : undefined;
			const format = a.format ?? (/\.lottie$/i.test(a.outputPath) ? 'dotlottie' : 'json');
			const envelope = toolEnvelope(doc, revision);
			const result: LottieExportResult = await ctx.engine((c) =>
				c.exportLottie({
					envelope,
					sequenceId: seq.id,
					format,
					outputPath: a.outputPath,
					...(start !== undefined || end !== undefined
						? {
								range: {
									start: start ?? 0,
									end: end ?? Math.max((start ?? 0) + 1, sequenceEnd(doc, seq.id)),
								},
							}
						: {}),
				}),
			);
			return jsonResult({
				outputPath: result.outputPath,
				bytes: result.bytes,
				layers: result.layers,
				...(result.warnings.length ? { warnings: result.warnings } : {}),
			});
		},
	);
}

function sequenceEnd(doc: ProjectDocument, seqId: string): number {
	const seq = doc.sequences[seqId];
	if (!seq) return 1;
	let end = 1;
	for (const c of Object.values(seq.clips)) end = Math.max(end, c.start + c.duration);
	return end;
}
