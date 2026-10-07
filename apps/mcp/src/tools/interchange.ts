// wp interchange MCP tools (docs/wp-notes/interchange.md): import_timeline / export_timeline (FCP7 XML, FCPXML,
// OpenTimelineIO, CMX 3600 EDL, AAF, OMF, Avid ALE) and Link Media (list_offline_media, link_media; S04:AS-011).
// The engine reads and writes the documents (routes /api/interchange/*); the import is one `project.importTimeline`
// transaction, a relink one transaction of `media.relink` commands, all undoable and also available through
// apply_commands.
import { basename, isAbsolute } from 'node:path';
import {
	type AssetRelinkResponse,
	INTERCHANGE_FORMATS,
	type InterchangeExportResult,
	type InterchangeImportResponse,
	type RegisteredMedia,
	type RelinkScanResult,
} from '@jasper/api';
import { type MediaAsset, makeEnvelope } from '@jasper/project';
import { z } from 'zod';
import {
	cancelIfAborted,
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
import { pickSequence } from '../format.ts';
import { LOCAL_ENGINE_ID } from '../media.ts';
import { ProjectIdArg } from './projects.ts';
import { failedJobError } from './templates.ts';

/** Appended to the server instructions. */
export const INTERCHANGE_GUIDE = `Timeline interchange (other editors and audio post):
- import_timeline reads Final Cut Pro 7 XML (Premiere/Resolve "Final Cut Pro XML", xmeml 4/5), FCPXML 1.9–1.11 (Final Cut Pro, Resolve), OpenTimelineIO (.otio), CMX 3600 EDL, AAF (Avid / Premiere / Resolve / Pro Tools), OMF 2.0 and Avid ALE into the project: sequences, bins, media items, transitions, Motion/Opacity/levels with keyframes, markers, multi-camera clips, captions (FCPXML/OTIO). The engine registers every file it finds; the rest come in as offline placeholders (list_offline_media, link_media). AAF/OMF embedded audio is written next to the project and linked. One undo step. The result lists what was not carried and what was used instead.
- export_timeline writes a sequence in one of those formats (job; wait: true by default). Clips the format cannot represent (text, shapes, effects, masks, expressions, non-uniform Motion, blend modes the format lacks…) are pre-rendered to ProRes 4444 with alpha and referenced (prerender "unsupported", the default except for OTIO, which keeps everything in its JasperEditor metadata), or all video clips ("all"), or reported ("none"). AAF/OMF audio: link (default for AAF), embed (default for OMF) or separate WAV/AIFF files, handles, mono breakout. EDL: one video track (and up to four audio tracks) per list, perTrack for one list per video track. The result names every clip/effect that was not carried and what was written instead.
- Multi-camera clips: FCP7 multiclips, FCPXML mc-clips, OTIO metadata; EDL/AAF/OMF/ALE get the active camera's clips.
- Link Media: list_offline_media lists offline media (imported placeholders, missing files). link_media relinks one asset to a file (path) or searches a folder (folder) matching by name (always), size and duration, and by fingerprint for renamed copies. A file whose content, length, frame rate or kind differs is linked only with force: true (the result lists the differences).`;

const SequenceIdArg = z
	.string()
	.optional()
	.describe('Sequence id ("seq_…"); default: the project\'s first sequence');
const FormatArg = z.enum(INTERCHANGE_FORMATS);
const RateArg = z
	.strictObject({ num: z.number().int().positive(), den: z.number().int().positive() })
	.describe('Frame rate as a rational, e.g. {"num": 30000, "den": 1001} for 29.97');

function absolute(path: string): string {
	if (!isAbsolute(path))
		throw new ToolError('E_INVALID_PARAM', 'Paths must be absolute', 'Pass an absolute path.');
	return path;
}

const summarizeReport = (warnings: InterchangeImportResponse['warnings']) => ({
	notCarried: warnings
		.filter((w) => w.level === 'warning')
		.slice(0, 60)
		.map((w) => ({
			message: w.message,
			...(w.count > 1 ? { count: w.count } : {}),
			...(w.instead ? { instead: w.instead } : {}),
		})),
	notes: warnings.filter((w) => w.level === 'info').length,
	...(warnings.filter((w) => w.level === 'warning').length > 60
		? { more: warnings.filter((w) => w.level === 'warning').length - 60 }
		: {}),
});

function isOffline(m: MediaAsset): boolean {
	return (
		m.fingerprint.startsWith('pending:interchange:') || !m.locators.some((l) => l.type === 'engine-store')
	);
}

function relinkCommand(mediaId: string, reg: RegisteredMedia, force: boolean) {
	const store = { type: 'engine-store' as const, engineId: LOCAL_ENGINE_ID, key: reg.mediaKey };
	return {
		type: 'media.relink',
		mediaId,
		locator: store,
		locators: [store, ...reg.locators.filter((l) => l.type === 'path')],
		probe: reg.probe,
		fingerprint: reg.fingerprint,
		sizeBytes: reg.sizeBytes,
		originalName: reg.originalName,
		container: reg.container,
		...(force ? { force: true } : {}),
	};
}

const needsConfirm = (match: AssetRelinkResponse['match'], diff: AssetRelinkResponse['diff']) =>
	match === 'different' ||
	(match === 'placeholder' &&
		diff.some((d) => d.field === 'kind' || d.field === 'duration' || d.field === 'frameRate'));

export function registerInterchangeTools(ctx: ToolContext): void {
	defineTool(
		ctx,
		'import_timeline',
		{
			title: 'Import timeline',
			description:
				'Imports a timeline document — Final Cut Pro 7 XML (.xml), FCPXML (.fcpxml), OpenTimelineIO (.otio), CMX 3600 EDL (.edl), AAF (.aaf), OMF 2.0 (.omf) or Avid ALE (.ale), detected from the content — into the project as sequences, bins and media items (one undo step). Files the document references are registered when found; the others become offline placeholders (see link_media). Returns the new sequence ids, the offline media and what was not carried.',
			input: {
				projectId: ProjectIdArg,
				path: z.string().optional().describe('Absolute path of the document'),
				content: z.string().optional().describe('Or the document text (XML, OTIO JSON, EDL, ALE)'),
				contentBase64: z.string().optional().describe('Or the document bytes (AAF, OMF)'),
				fileName: z.string().optional().describe('File name for content/contentBase64 (helps detection)'),
				format: FormatArg.optional().describe('Default: detected'),
				rate: RateArg.optional().describe('EDL / ALE: the frame rate when the document does not say'),
				dropFrame: z.boolean().optional().describe('EDL: drop-frame timecode when there is no FCM line'),
				binId: z
					.string()
					.optional()
					.describe('Bin to add the import to (default: a new bin named after the document)'),
			},
			annotations: EDIT,
		},
		async (a, extra) => {
			const given = [a.path, a.content, a.contentBase64].filter((x) => x !== undefined).length;
			if (given !== 1)
				throw new ToolError('E_INVALID_PARAM', 'Give exactly one of path, content, contentBase64');
			const name = a.fileName ?? (a.path ? basename(a.path) : `timeline.${a.format ?? 'xml'}`);
			const file = a.path
				? undefined
				: {
						name,
						contentBase64: a.contentBase64 ?? Buffer.from(a.content ?? '', 'utf8').toString('base64'),
					};
			const res = await ctx.engine((c) =>
				c.importTimeline({
					projectId: a.projectId,
					...(a.path ? { path: absolute(a.path) } : { file: file! }),
					...(a.format ? { format: a.format } : {}),
					...(a.rate ? { rate: a.rate } : {}),
					...(a.dropFrame !== undefined ? { dropFrame: a.dropFrame } : {}),
				}),
			);
			const tx = await transact(
				ctx,
				a.projectId,
				{
					label: `Import ${name}`,
					commands: [
						{
							type: 'project.importTimeline',
							fragment: res.fragment,
							...(a.binId ? { binId: a.binId } : {}),
						},
					],
				},
				extra,
			);
			const ok = requireOk(tx);
			const out = ok.results[0] as { topSequenceIds: string[]; sequenceIds: string[]; binId: string | null };
			return jsonResult({
				...txBody(tx, ok),
				format: res.format,
				sequences: out.topSequenceIds,
				binId: out.binId,
				offline: res.missing.map((m) => ({ name: m.name, path: m.path, reason: m.reason })),
				...(res.extracted.length ? { extractedAudio: res.extracted.map((e) => e.path) } : {}),
				report: summarizeReport(res.warnings),
				...(res.missing.length ? { next: 'Call link_media with a folder to relink the offline media.' } : {}),
			});
		},
	);

	defineTool(
		ctx,
		'export_timeline',
		{
			title: 'Export timeline',
			description:
				'Exports a sequence as Final Cut Pro 7 XML, FCPXML, OpenTimelineIO, CMX 3600 EDL, AAF, OMF or Avid ALE (an engine job). Clips the format cannot represent are pre-rendered to ProRes 4444 with alpha and referenced (prerender), AAF/OMF audio is linked, embedded or written as separate files. The result lists the files (download URLs, and paths with outputPath) and every clip or effect that was not carried with what was written instead.',
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg,
				format: FormatArg,
				outputPath: z
					.string()
					.optional()
					.describe(
						'Absolute path of the document; side files (pre-renders, audio) go into "<name> Media/" next to it',
					),
				name: z.string().optional().describe('Timeline name in the document (default: the sequence name)'),
				prerender: z
					.enum(['unsupported', 'all', 'none'])
					.optional()
					.describe(
						'Pre-render clips the format cannot represent (default; none for OTIO/OMF/ALE), all video clips, or none (report only)',
					),
				xmemlVersion: z
					.union([z.literal(4), z.literal(5)])
					.optional()
					.describe('FCP7 XML version (default 4)'),
				fcpxmlVersion: z.enum(['1.9', '1.10', '1.11']).optional().describe('FCPXML version (default 1.10)'),
				edl: z
					.strictObject({
						videoTrack: z
							.number()
							.int()
							.min(0)
							.nullable()
							.optional()
							.describe('Video track index (0 = V1); null = audio only'),
						audioTracks: z
							.array(z.number().int().min(0))
							.max(4)
							.optional()
							.describe('Audio track indices (0 = A1), at most four'),
						reelMode: z.enum(['file-name', 'clip-name', 'ax']).optional(),
						reelLength: z
							.union([z.literal(8), z.literal(32)])
							.optional()
							.describe('8 (CMX 3600) or 32 characters'),
						clipNames: z.boolean().optional(),
						sourceFiles: z.boolean().optional(),
						effectNames: z.boolean().optional(),
						markers: z.boolean().optional(),
						perTrack: z.boolean().optional().describe('One list per video track'),
					})
					.optional(),
				audio: z
					.strictObject({
						mode: z.enum(['link', 'embed', 'separate']).optional().describe('AAF/OMF audio (default link)'),
						handlesFrames: z.number().int().min(0).max(10_000).optional(),
						breakoutToMono: z.boolean().optional(),
						bitDepth: z.union([z.literal(16), z.literal(24)]).optional(),
						fileFormat: z.enum(['wav', 'aiff']).optional().describe('Separate files (OMF: AIFF or WAV)'),
						copyComplete: z
							.boolean()
							.optional()
							.describe(
								'Whole media files instead of the used ranges plus handles (Premiere: Copy Complete Audio Files)',
							),
					})
					.optional(),
				aafSmallSectors: z
					.boolean()
					.optional()
					.describe('AAF with 512-byte sectors (older Avid / Pro Tools)'),
				aleScope: z
					.enum(['sequence', 'project'])
					.optional()
					.describe('ALE: media of the sequence (default) or of the project'),
				wait: z.boolean().optional().describe('Block until the export finishes (default true)'),
				timeoutSeconds: z.number().int().min(1).max(3600).optional().describe('With wait (default 900)'),
			},
			annotations: EDIT,
		},
		async (a, extra) => {
			const { doc, revision } = await loadDoc(ctx, a.projectId);
			let seqId: string;
			try {
				seqId = pickSequence(doc, a.sequenceId).id;
			} catch (e) {
				throw new ToolError('E_NOT_FOUND', (e as Error).message, 'Call get_project for sequence ids.');
			}
			const envelope = makeEnvelope(doc, {
				revision: revision ?? 0,
				savedAt: new Date().toISOString(),
				platform: 'mcp',
			}) as never;
			const job = await ctx.engine((c) =>
				c.exportTimeline({
					envelope,
					sequenceId: seqId,
					format: a.format,
					options: {
						...(a.name ? { name: a.name } : {}),
						...(a.prerender ? { prerender: a.prerender } : {}),
						...(a.xmemlVersion ? { xmemlVersion: a.xmemlVersion } : {}),
						...(a.fcpxmlVersion ? { fcpxmlVersion: a.fcpxmlVersion } : {}),
						...(a.edl ? { edl: a.edl } : {}),
						...(a.audio ? { audio: a.audio } : {}),
						...(a.aafSmallSectors ? { aafSmallSectors: true } : {}),
						...(a.aleScope ? { ale: { scope: a.aleScope } } : {}),
					},
					...(a.outputPath ? { destination: { type: 'path', path: absolute(a.outputPath) } } : {}),
				}),
			);
			await cancelIfAborted(ctx, extra, job.id);
			if (a.wait === false)
				return jsonResult({ jobId: job.id, state: job.state, next: 'Call wait_for_job with this jobId.' });
			const { job: done, timedOut } = await waitJob(ctx, job.id, (a.timeoutSeconds ?? 900) * 1000, extra);
			const base = ctx.link.target?.url ?? '';
			if (timedOut)
				return jsonResult({
					...jobBody(done, base),
					timedOut: true,
					next: 'Call wait_for_job with this jobId.',
				});
			if (isTerminal(done) && done.state !== 'succeeded')
				throw await failedJobError(ctx, done, 'Check the job error; engine_status may help.');
			const r = done.result as InterchangeExportResult;
			return jsonResult({
				jobId: done.id,
				format: r.format,
				files: r.files.map((f) => ({
					name: f.name,
					role: f.role,
					bytes: f.byteSize,
					url: `${base}${f.downloadUrl}`,
					...(f.path ? { path: f.path } : {}),
				})),
				prerendered: r.prerendered,
				report: summarizeReport(r.warnings),
			});
		},
	);

	defineTool(
		ctx,
		'list_offline_media',
		{
			title: 'List offline media',
			description:
				'Media of the project without a linked file: placeholders of imported timelines and files the engine cannot find. Ids, names, last known paths, kinds and durations (for link_media).',
			input: { projectId: ProjectIdArg },
			annotations: READ_ONLY,
		},
		async (a) => {
			const { doc } = await loadDoc(ctx, a.projectId);
			const offline = (Object.values(doc.media) as MediaAsset[]).filter(
				(m) => (m.kind === 'video' || m.kind === 'audio' || m.kind === 'image') && isOffline(m),
			);
			return jsonResult({
				offline: offline.map((m) => ({
					mediaId: m.id,
					name: m.originalName,
					kind: m.kind,
					path: m.locators.find((l) => l.type === 'path')?.path ?? null,
					durationSeconds: m.probe.durationFlicks === null ? null : m.probe.durationFlicks / 705_600_000,
					placeholder: m.fingerprint.startsWith('pending:interchange:'),
				})),
			});
		},
	);

	defineTool(
		ctx,
		'link_media',
		{
			title: 'Link media',
			description:
				'Relinks offline media (S04:AS-011): one asset to a file (mediaId + path), or every offline asset (or mediaIds) found in a folder, matched by file name (always), size and duration (match), then by fingerprint for renamed copies. A file whose content, length, frame rate or kind differs needs force: true (the result lists the differences). dryRun reports what would be linked. One undo step.',
			input: {
				projectId: ProjectIdArg,
				mediaId: z.string().optional().describe('With path: the asset to relink ("med_…")'),
				path: z.string().optional().describe('With mediaId: the replacement file (absolute)'),
				folder: z.string().optional().describe('Folder to search (absolute, recursive)'),
				mediaIds: z
					.array(z.string())
					.optional()
					.describe('With folder: only these assets (default: every offline one)'),
				match: z
					.array(z.enum(['name', 'size', 'duration', 'mediaStart']))
					.min(1)
					.optional()
					.describe(
						'With folder: what must match — name, size, duration, mediaStart (start timecode); default ["name", "duration"]',
					),
				ignoreExtension: z
					.boolean()
					.optional()
					.describe('Name match ignores the extension (transcoded files)'),
				force: z.boolean().optional().describe('Link files that differ (see the differences in the result)'),
				dryRun: z.boolean().optional().describe('Only report what would be linked'),
			},
			annotations: EDIT,
		},
		async (a, extra) => {
			const { doc } = await loadDoc(ctx, a.projectId);
			const media = doc.media as Record<string, MediaAsset>;
			type Hit = {
				mediaId: string;
				path: string;
				media: RegisteredMedia;
				match: string;
				diff: AssetRelinkResponse['diff'];
				confirm: boolean;
			};
			const hits: Hit[] = [];
			let notFound: string[] = [];
			if (a.path || a.mediaId) {
				if (!a.path || !a.mediaId) throw new ToolError('E_INVALID_PARAM', 'Give mediaId and path together');
				const asset = media[a.mediaId];
				if (!asset) throw new ToolError('E_NOT_FOUND', `No media ${a.mediaId}`, 'Call list_offline_media.');
				const r = await ctx.engine((c) =>
					c.relinkAsset(asset.id, { projectId: a.projectId, path: absolute(a.path!), asset: asset as never }),
				);
				hits.push({
					mediaId: asset.id,
					path: a.path,
					media: r.media as unknown as RegisteredMedia,
					match: r.match,
					diff: r.diff,
					confirm: r.needsConfirm,
				});
			} else if (a.folder) {
				const offline = Object.values(media).filter(
					(m) => isOffline(m) && (!a.mediaIds?.length || a.mediaIds.includes(m.id)),
				);
				if (!offline.length) return jsonResult({ linked: 0, message: 'No offline media to link' });
				const job = await ctx.engine((c) =>
					c.relinkScan(a.projectId, {
						folder: absolute(a.folder!),
						assets: offline as never,
						match: a.match ?? ['name', 'duration'],
						ignoreExtension: a.ignoreExtension ?? false,
					}),
				);
				await cancelIfAborted(ctx, extra, job.id);
				const { job: done } = await waitJob(ctx, job.id, 600_000, extra);
				if (done.state !== 'succeeded') throw await failedJobError(ctx, done, 'Check the folder path.');
				const r = done.result as RelinkScanResult;
				for (const f of r.found)
					hits.push({
						mediaId: f.assetId,
						path: f.path,
						media: f.media as unknown as RegisteredMedia,
						match: f.match,
						diff: f.diff,
						confirm: needsConfirm(f.match, f.diff),
					});
				notFound = r.notFound.map((id) => media[id]?.originalName ?? id);
			} else throw new ToolError('E_INVALID_PARAM', 'Give mediaId + path, or folder');
			const link = hits.filter((h) => !h.confirm || a.force);
			const held = hits.filter((h) => h.confirm && !a.force);
			const describe = (h: Hit) => ({
				mediaId: h.mediaId,
				name: media[h.mediaId]?.originalName,
				path: h.path,
				match: h.match,
				...(h.diff.length ? { differences: h.diff.map((d) => `${d.field}: ${d.was} → ${d.now}`) } : {}),
			});
			if (a.dryRun || !link.length)
				return jsonResult({
					linked: 0,
					wouldLink: link.map(describe),
					...(held.length ? { needsForce: held.map(describe) } : {}),
					...(notFound.length ? { notFound } : {}),
				});
			const tx = await transact(
				ctx,
				a.projectId,
				{
					label: link.length === 1 ? 'Link Media' : `Link Media (${link.length})`,
					commands: link.map((h) => relinkCommand(h.mediaId, h.media, h.confirm)),
				},
				extra,
			);
			const ok = requireOk(tx);
			return jsonResult({
				...txBody(tx, ok),
				linked: link.length,
				media: link.map(describe),
				...(held.length ? { needsForce: held.map(describe) } : {}),
				...(notFound.length ? { notFound } : {}),
			});
		},
	);
}
