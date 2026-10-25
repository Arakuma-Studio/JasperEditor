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
	MEDIA_STATUS_BATCH_MAX,
	RELINK_CRITERIA,
	RELINK_MAX_ASSETS,
	type RegisteredMedia,
	type RelinkScanResult,
} from '@jasper/api';
import {
	applyRelinkTransaction,
	classifyPath,
	displayPath,
	type MediaAsset,
	relinkMediaCommand,
	resetInterpretationCommand,
} from '@jasper/project';
import { z } from 'zod';
import { ProjectIdArg, SequenceIdArg } from '../arguments.ts';
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
import { toolEnvelope } from '../envelope.ts';
import { jsonResult, ToolError } from '../errors.ts';
import { pickSequence } from '../format.ts';
import { LOCAL_ENGINE_ID } from '../media.ts';

import { failedJobError } from './templates.ts';

export const INTERCHANGE_GUIDE = `Timeline interchange (other editors and audio post):
- import_timeline reads Final Cut Pro 7 XML (Premiere/Resolve "Final Cut Pro XML", xmeml 4/5), FCPXML 1.9–1.11 (Final Cut Pro, Resolve), OpenTimelineIO (.otio), CMX 3600 EDL, AAF (Avid / Premiere / Resolve / Pro Tools), OMF 2.0 and Avid ALE into the project: sequences, bins, media items, transitions, Motion/Opacity/levels with keyframes, Premiere's audio Pitch Shifter (its Transpose Ratio becomes the Pitch Shifter's semitones + cents; FCP7 export writes it back in Premiere's form), markers, multi-camera clips, captions (FCPXML/OTIO). The engine registers every file it finds; the rest come in as offline placeholders (list_offline_media, link_media). AAF/OMF embedded audio is written next to the project and linked. One undo step. The result lists what was not carried and what was used instead.
- export_timeline writes a sequence in one of those formats (job; wait: true by default). Clips the format cannot represent (text, shapes, effects, masks, expressions, non-uniform Motion, blend modes the format lacks…) are pre-rendered to ProRes 4444 with alpha and referenced (prerender "unsupported", the default except for OTIO, which keeps everything in its JasperEditor metadata), or all video clips ("all"), or reported ("none"). AAF/OMF audio: link (default for AAF), embed (default for OMF) or separate WAV/AIFF files, handles, mono breakout. EDL: one video track (and up to four audio tracks) per list, perTrack for one list per video track. The result names every clip/effect that was not carried and what was written instead.
- Multi-camera clips: FCP7 multiclips, FCPXML mc-clips, OTIO metadata; EDL/AAF/OMF/ALE get the active camera's clips.
- Sound design: every format with sequence markers (FCP7, FCPXML, OTIO, EDL with markers, AAF) gets one marker per sound cue named "SFX: <type>[+<type>] (<hero|support|ambient>)" at the cue frame (the cue's reason as comment); the report says so and that proposals and the sound design's mix metadata (settings, mix records, the last Sound Check, SFX placement data) are not carried. After import_timeline, the UI command sound.convertMarkersToCues (ui_command, editor open) or apply_commands soundCue.add {cues: [{frame, kind: "manual", weight, types, source: "marker"}]} turns those markers back into cues. The mix itself is ordinary data: OTIO restores submixes (the SFX Room), sends, outputs and automation lanes from its metadata; the other formats report the submixes, sends, track volume / pan automation, audio effects and loudness normalisation they cannot carry.
- Link Media: list_offline_media lists offline media (imported placeholders, missing files, paths of another computer such as D:\\Media\\a.mov kept as written; paged). link_media with mediaId + path links the file you located and, by default (relinkOthers), finds the other offline media from it: the old → new folder mapping (D:\\ → /Volumes/Mac), project-relative paths, the same folder, then a bounded search under it — all verified against match (default name, extension, duration, streams) and linked in one undoable transaction. folder searches a folder; with neither it tries each asset's last known path. Ambiguous matches are listed, never guessed. A file whose content, length or kind differs, or that fails a match property, is linked only with force: true (the result lists the differences). alignTimecode (default true) keeps clips on their source timecode; preserveInterpretation (default true).`;

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

const LINKABLE = new Set<MediaAsset['kind']>(['video', 'audio', 'image', 'animated-image']);
/** Default Match File Properties of a search (Premiere's File Name + File Extension, plus length and streams). */
const DEFAULT_MATCH = ['name', 'extension', 'duration', 'streams'] as const;
/** Entries listed per category in a link_media result (counts are always complete). */
const LIST_CAP = 100;

/**
 * Offline media: imported placeholders, media without an engine-store locator, and media whose file the engine does
 * not find (unknown key or missing file — a project moved from another computer).
 */
async function offlineMediaOf(
	ctx: ToolContext,
	doc: { media: Record<string, unknown> },
): Promise<MediaAsset[]> {
	const media = (Object.values(doc.media) as MediaAsset[]).filter((m) => LINKABLE.has(m.kind));
	const keyOf = (m: MediaAsset) => {
		const l = m.locators.find((x) => x.type === 'engine-store');
		return l && l.type === 'engine-store' ? l.key : null;
	};
	const keys = [...new Set(media.map(keyOf).filter((k): k is string => !!k))];
	const missing = new Set<string>();
	for (let i = 0; i < keys.length; i += MEDIA_STATUS_BATCH_MAX) {
		const r = await ctx.engine((c) => c.mediaStatusBatch(keys.slice(i, i + MEDIA_STATUS_BATCH_MAX)));
		for (const k of r.unknown) missing.add(k);
		for (const st of r.statuses) if (st.status === 'missing') missing.add(st.mediaKey);
	}
	return media.filter((m) => {
		if (m.fingerprint.startsWith('pending:interchange:')) return true;
		const k = keyOf(m);
		return !k || missing.has(k);
	});
}

function lastPaths(m: MediaAsset): { path: string | null; relativePath: string | null } {
	for (const l of m.locators)
		if (l.type === 'path') return { path: l.path, relativePath: l.relativeToProject ?? null };
	return { path: null, relativePath: null };
}

const needsConfirm = (match: AssetRelinkResponse['match'], diff: AssetRelinkResponse['diff']) =>
	match === 'different' ||
	(match === 'placeholder' && diff.some((d) => d.field === 'kind' || d.field === 'duration'));

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
			const envelope = toolEnvelope(doc, revision);
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
				'Media of the project without a linked file: placeholders of imported timelines and files the engine cannot find (moved, or on another computer). Ids, names, last known paths (a Windows path such as D:\\Media\\a.mov stays as written; pathStyle says which system it belongs to), project-relative paths, kinds and durations (for link_media). Paged: offset/limit; total is the full count.',
			input: {
				projectId: ProjectIdArg,
				offset: z.number().int().min(0).optional().describe('First entry (default 0)'),
				limit: z.number().int().min(1).max(1000).optional().describe('Entries to return (default 200)'),
			},
			annotations: READ_ONLY,
		},
		async (a) => {
			const { doc } = await loadDoc(ctx, a.projectId);
			const offline = await offlineMediaOf(ctx, doc);
			const offset = a.offset ?? 0;
			const page = offline.slice(offset, offset + (a.limit ?? 200));
			return jsonResult({
				total: offline.length,
				offset,
				offline: page.map((m) => {
					const { path, relativePath } = lastPaths(m);
					return {
						mediaId: m.id,
						name: m.originalName,
						kind: m.kind,
						path: path === null ? null : displayPath(path),
						...(path !== null ? { pathStyle: classifyPath(path) } : {}),
						...(relativePath ? { relativePath } : {}),
						durationSeconds: m.probe.durationFlicks === null ? null : m.probe.durationFlicks / 705_600_000,
						placeholder: m.fingerprint.startsWith('pending:interchange:'),
					};
				}),
				...(offset + page.length < offline.length ? { nextOffset: offset + page.length } : {}),
			});
		},
	);

	defineTool(
		ctx,
		'link_media',
		{
			title: 'Link media',
			description:
				"Relinks offline media like Premiere's Link Media (S04:AS-011). mediaId + path: the located file (absolute path on the engine's computer) is verified against match (selected Match File Properties) and linked; with relinkOthers (default true) the engine then finds the other offline media from it — its old → new folder mapping (D:\\Media\\… → /Volumes/Mac/Media/…), project-relative paths, the same folder, then a bounded search under that folder — and links every verified file in the same transaction. folder: searches a folder for every offline asset (or mediaIds). Without either: tries each asset's last known path. Ambiguous matches (several files fit) are listed, never guessed. A file whose content, length or kind differs, or that fails a match property, needs force: true. dryRun reports what would be linked. One undo step.",
			input: {
				projectId: ProjectIdArg,
				mediaId: z.string().optional().describe('With path: the asset the file belongs to ("med_…")'),
				path: z.string().optional().describe('With mediaId: where the file is now (absolute)'),
				relinkOthers: z
					.boolean()
					.optional()
					.describe('With mediaId + path: also find and link the other offline media from it (default true)'),
				folder: z.string().optional().describe('Folder to search (absolute, recursive, bounded)'),
				mediaIds: z
					.array(z.string())
					.optional()
					.describe('Only these offline assets (default: every offline one)'),
				match: z
					.array(z.enum(RELINK_CRITERIA))
					.min(1)
					.optional()
					.describe(
						'Match File Properties every found file must satisfy: name, extension, size, duration, mediaStart (start timecode), streams; default ["name", "extension", "duration", "streams"]. With mediaId + path they are checked on the located file too.',
					),
				ignoreExtension: z
					.boolean()
					.optional()
					.describe(
						'Compare names without the extension (transcoded files); same as leaving out "extension"',
					),
				alignTimecode: z
					.boolean()
					.optional()
					.describe(
						'Align Timecode (default true): clips keep their source timecode when the file starts at another',
					),
				preserveInterpretation: z
					.boolean()
					.optional()
					.describe(
						'Preserve Interpret Footage (default true); false resets the interpretation of linked media',
					),
				timeLimitSec: z
					.number()
					.int()
					.min(1)
					.max(3600)
					.optional()
					.describe('Search time budget (default 120 s)'),
				force: z.boolean().optional().describe('Link files that differ (see the differences in the result)'),
				dryRun: z.boolean().optional().describe('Only report what would be linked'),
			},
			annotations: EDIT,
		},
		async (a, extra) => {
			const { doc } = await loadDoc(ctx, a.projectId);
			const media = doc.media as Record<string, MediaAsset>;
			const match = [...(a.match ?? DEFAULT_MATCH)].filter((m) => !(a.ignoreExtension && m === 'extension'));
			const ignoreExtension = a.ignoreExtension ?? !match.includes('extension');
			type Hit = {
				mediaId: string;
				path: string;
				media: RegisteredMedia;
				match: string;
				diff: AssetRelinkResponse['diff'];
				confirm: boolean;
				step?: string;
				failed?: string[];
			};
			const hits: Hit[] = [];
			let notFound: string[] = [];
			let ambiguous: RelinkScanResult['ambiguous'] = [];
			let search: Pick<RelinkScanResult, 'scannedFiles' | 'truncated' | 'timedOut' | 'mappings'> | null =
				null;
			let anchors: { from: string; to: string; relativePath: string | null }[] = [];
			if (a.path || a.mediaId) {
				if (!a.path || !a.mediaId) throw new ToolError('E_INVALID_PARAM', 'Give mediaId and path together');
				const asset = media[a.mediaId];
				if (!asset) throw new ToolError('E_NOT_FOUND', `No media ${a.mediaId}`, 'Call list_offline_media.');
				const r = await ctx.engine((c) =>
					c.relinkAsset(asset.id, {
						projectId: a.projectId,
						path: absolute(a.path!),
						asset: asset as never,
						...(a.match ? { match, ignoreExtension } : {}),
					}),
				);
				hits.push({
					mediaId: asset.id,
					path: a.path,
					media: r.media,
					match: r.match,
					diff: r.diff,
					confirm: r.needsConfirm,
					step: 'located',
					...(r.failed?.length ? { failed: r.failed } : {}),
				});
				const old = lastPaths(asset);
				if (old.path && (a.relinkOthers ?? true))
					anchors = [{ from: old.path, to: a.path, relativePath: old.relativePath }];
			}
			const wantScan = anchors.length > 0 || !!a.folder || (!a.path && !a.mediaId);
			if (wantScan) {
				const offline = (await offlineMediaOf(ctx, doc)).filter(
					(m) => m.id !== a.mediaId && (!a.mediaIds?.length || a.mediaIds.includes(m.id)),
				);
				if (offline.length > RELINK_MAX_ASSETS)
					throw new ToolError(
						'E_INVALID_PARAM',
						`${offline.length} offline media: one run checks at most ${RELINK_MAX_ASSETS}`,
						'Pass mediaIds in batches.',
					);
				if (offline.length) {
					const job = await ctx.engine((c) =>
						c.relinkScan(a.projectId, {
							...(a.folder ? { folder: absolute(a.folder) } : {}),
							...(anchors.length ? { anchors } : {}),
							assets: offline as never,
							match,
							ignoreExtension,
							...(a.timeLimitSec ? { timeLimitSec: a.timeLimitSec } : {}),
						}),
					);
					await cancelIfAborted(ctx, extra, job.id);
					const { job: done } = await waitJob(ctx, job.id, 3_600_000, extra);
					if (done.state !== 'succeeded') throw await failedJobError(ctx, done, 'Check the paths.');
					const r = await ctx.engine((c) => c.relinkScanResult(a.projectId, job.id));
					for (const f of r.found)
						hits.push({
							mediaId: f.assetId,
							path: f.path,
							media: f.media,
							match: f.match,
							diff: f.diff,
							confirm: f.needsConfirm ?? needsConfirm(f.match, f.diff),
							...(f.step ? { step: f.step } : {}),
						});
					notFound = r.notFound;
					ambiguous = r.ambiguous ?? [];
					search = {
						scannedFiles: r.scannedFiles,
						truncated: r.truncated,
						timedOut: r.timedOut ?? false,
						mappings: r.mappings ?? [],
					};
				} else if (!hits.length) return jsonResult({ linked: 0, message: 'No offline media to link' });
			}
			const link = hits.filter((h) => !h.confirm || a.force);
			const held = hits.filter((h) => h.confirm && !a.force);
			const nameOf = (id: string) => media[id]?.originalName ?? id;
			const describe = (h: Hit) => ({
				mediaId: h.mediaId,
				name: nameOf(h.mediaId),
				path: h.path,
				match: h.match,
				...(h.step ? { how: h.step } : {}),
				...(h.failed ? { failedMatch: h.failed } : {}),
				...(h.diff.length ? { differences: h.diff.map((d) => `${d.field}: ${d.was} → ${d.now}`) } : {}),
			});
			const capped = <T>(xs: T[]) => xs.slice(0, LIST_CAP);
			const report = {
				...(held.length ? { needsForce: capped(held.map(describe)), needsForceCount: held.length } : {}),
				...(ambiguous.length
					? {
							ambiguous: capped(ambiguous).map((x) => ({
								mediaId: x.assetId,
								name: nameOf(x.assetId),
								candidates: x.candidates,
							})),
							ambiguousCount: ambiguous.length,
						}
					: {}),
				...(notFound.length
					? { stillMissing: capped(notFound.map(nameOf)), stillMissingCount: notFound.length }
					: {}),
				...(search
					? {
							search: {
								scannedFiles: search.scannedFiles,
								...(search.truncated ? { truncated: true } : {}),
								...(search.timedOut ? { timedOut: true } : {}),
								...(search.mappings.length ? { mappings: search.mappings } : {}),
							},
						}
					: {}),
			};
			if (a.dryRun || !link.length)
				return jsonResult({
					linked: 0,
					wouldLink: capped(link.map(describe)),
					wouldLinkCount: link.length,
					...report,
				});
			const commands: Record<string, unknown>[] = link.map((h) =>
				relinkMediaCommand(media[h.mediaId]!, h.media, {
					force: h.confirm,
					alignTimecode: a.alignTimecode ?? true,
					engineId: LOCAL_ENGINE_ID,
				}),
			);
			if (a.preserveInterpretation === false) {
				const reset = resetInterpretationCommand(link.map((h) => media[h.mediaId]!));
				if (reset) commands.push(reset);
			}
			const label = link.length === 1 ? 'Link Media' : `Link Media (${link.length})`;
			const { result: tx, unaligned } = await applyRelinkTransaction(commands, async (cmds) => {
				const res = await transact(ctx, a.projectId, { label, commands: cmds }, extra);
				return Object.assign(res.result, { response: res });
			});
			const ok = requireOk(tx.response);
			return jsonResult({
				...txBody(tx.response, ok),
				linked: link.length,
				media: capped(link.map(describe)),
				...(unaligned.length
					? { timecodeNotAligned: unaligned.map((u) => ({ name: nameOf(u.mediaId), reason: u.reason })) }
					: {}),
				...report,
			});
		},
	);
}
