import type { MediaJobResult, ReframeResult, RegisteredMedia, WarpAnalysisResult } from '@jasper/api';
import { mediaRegisterCommand } from '@jasper/api';
import {
	AUDIO_DISPLAY_FORMATS,
	attachedProxyFrom,
	buildItemsPayload,
	FIND_OPERATORS,
	findProjectItems,
	findTimelineHits,
	graphicTemplateOf,
	INGEST_ACTIONS,
	mediaJobCommands,
	PROJECT_FIND_FIELDS,
	PROXY_PRESETS,
	projectSettingsOf,
	proxyMismatch,
	reframeJobsFor,
	reframeSize,
	resolveFrameInput,
	type Sequence,
	sequenceFormatOf,
	sequenceTimecode,
	sourceChannels,
	TIMELINE_FIND_FIELDS,
	trackLabel,
	VIDEO_DISPLAY_FORMATS,
	WARP_STABILIZER_EFFECT_ID,
	warpRequestFor,
} from '@jasper/project';
import { z } from 'zod';
import { ProjectIdArg, SequenceIdArg, TIME_HINT, timeArg } from '../arguments.ts';
import {
	DESTRUCTIVE,
	DESTRUCTIVE_IDEMPOTENT,
	defineTool,
	EDIT,
	EDIT_IDEMPOTENT,
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
import { AlphaFrameArgs, exportAlphaFrames } from './delivery.ts';

export const GAPS_GUIDE = `Find, Edit Original, tracks:
- find searches the Project panel (scope "project": name, label, type, path, codec, frameSize, any) or a sequence (scope "timeline": clipName, sourceName, text, marker, any) with up to two criteria (contains, matches, begins, ends, notContains), match all/any and matchCase, like Premiere's Edit ▸ Find. Timeline hits come in frame order with timecodes.
- locate_media says where a media file is on the engine host; action "reveal" shows it in the file browser and "open" opens it in its default application (Edit Original; local engines only, never programs).
- get_project_settings / set_project_settings: Project Settings (video display format timecode / frames / feet35 / feet16, audio display format samples / milliseconds, the Captured and Generated Media folder, ingest at import: copy / transcode / proxies / copyAndProxies) and the engine folders behind Scratch Disks.
- create_proxies transcodes video media to a proxy preset in the background and attaches the proxies when the job ends (wait: true waits and attaches); attach_proxy attaches an existing file (duration ± 1 frame and frame rate must match unless force); detach_proxies removes them; reconnect_full_resolution links a clip to its full-resolution file (the file it used becomes its proxy). The editor's Toggle Proxies plays proxies; exports never use them unless start_export gets draftUseProxies.
- export_frame writes the sequence frame at a time as png / jpeg / tiff / dpx (10-bit) / exr (linear half float) / bmp / tga to a folder on this machine (never overwriting), optionally importing it into the project. With alpha: true it writes PNGs with straight alpha instead (get_guide {"topic": "delivery"}).
- get_sequence_settings / set_sequence_settings: Sequence Settings (timebase, frame size, pixel aspect ratio, fields, drop frame, audio sample rate, Mix channels). A non-square pixel aspect ratio means the sequence is edited at its display width (storageWidth × ratio) and exports at storageWidth with the ratio signalled; changing the timebase of a sequence with clips conforms them and needs conform: true (Premiere does not allow it); a frame size change takes reposition. new_sequence_from_clip makes a sequence matching a media item (size, rate, pixel aspect, fields) with the clip in it. Fields are kept with the sequence; exports are progressive (the plan warns FIELDS_PROGRESSIVE).
- set_audio_channels: Clip ▸ Modify ▸ Audio Channels. Each routed clip = {streamIndex, map: source channel per clip channel (1 mono, 2 stereo, 6 for 5.1), mute: clip channels that play silence}. On timeline clips (clipIds: one routing per clip, typically a linked group) or on Project media items (itemIds: the audio clips future placements create; clips null = default). get_audio_channels lists a media's source channels and the routing.
- project_manager: File ▸ Project Manager — mode "collect" copies every used file into destination, "consolidate" writes only the used part of each video / audio media plus handlesFrames (ProRes 422 HQ / WAV) and re-bases the clips; excludeUnused drops unchosen sequences and unused media items; includePreviews / includeProxies; dryRun only estimates the disk space. The copy is written as <destination>/<projectName>.jasper and registered as a new project (its id comes back).
- stabilize_clip applies Effect ▸ Distort ▸ Warp Stabilizer to a video clip (Premiere params) and runs + stores its analysis (the editor also analyses in the background); exports refuse an un-analysed stabiliser (WARP_NOT_ANALYZED).
- auto_reframe_sequence: Sequence ▸ Auto Reframe Sequence — a copy at another aspect ("9:16", "1:1", "4:5", "16:9", "W:H") whose clips follow their subject with Position keyframes (faces when the face model is installed, else motion / contrast saliency). Morph Cut is the transition jasper.morph-cut (add it on a jump cut with transition.add).
- Essential Graphics: create_graphic makes a graphic (a nested sequence flagged graphic; its tracks are the layers) at a time; edit it with apply_commands graphic.addLayer {sequenceId, kind}, graphic.align {sequenceId, clipIds, mode, relativeTo}, graphic.setPins {sequenceId, clipId, target: "frame" | layer clip id, edges}, and set_graphic (intro / outro, duration, roll / crawl). export_graphic_template / import_graphic_template move graphics as .jgt JSON. Adobe .mogrt files are not supported (proprietary After Effects / Premiere project inside; no public format).
- add_tracks adds video / audio / submix tracks at a placement ("first", "last" or after a track label like "V2"), audio track type mono / stereo / 5.1; delete_tracks deletes "empty" tracks, "unassigned" submixes or named tracks (tracks with clips need force: true and the user's approval).`;

const Criterion = z.object({
	field: z.string().min(1).describe('Column: see the scope'),
	operator: z.enum(FIND_OPERATORS).default('contains'),
	value: z.string().min(1).max(500),
});

/** "first" → 0, "last" → the end, "V2" / "A1" / "S1" → after that track. */
function placementIndex(seq: Sequence, kind: 'video' | 'audio' | 'submix', at: string | undefined): number {
	const list =
		kind === 'video' ? seq.videoTracks : kind === 'audio' ? seq.audioTracks : (seq.submixTracks ?? []);
	if (!at || at === 'last') return list.length;
	if (at === 'first') return 0;
	const m = /^([VAS])(\d+)$/i.exec(at);
	const prefix = kind === 'video' ? 'V' : kind === 'audio' ? 'A' : 'S';
	if (!m || m[1]!.toUpperCase() !== prefix)
		throw new ToolError(
			'E_INVALID_PARAM',
			`Bad placement "${at}" for ${kind} tracks`,
			`Use "first", "last" or "${prefix}1".`,
		);
	const n = Number(m[2]);
	if (n < 1 || n > list.length)
		throw new ToolError('E_NOT_FOUND', `No track ${at}`, 'Call get_timeline for track labels.');
	return n;
}

export function registerGapsTools(ctx: ToolContext): void {
	defineTool(
		ctx,
		'find',
		{
			title: 'Find in project or sequence',
			description:
				'Premiere\'s Edit ▸ Find. scope "project": project items whose fields match (fields name, label, type, path, codec, frameSize, any). scope "timeline": clips (clipName, sourceName, text = text clip content) and markers (marker = name or comment) of a sequence, in frame order. Up to two criteria; match "all" (default) or "any"; matchCase.',
			input: {
				projectId: ProjectIdArg,
				scope: z.enum(['project', 'timeline']),
				sequenceId: SequenceIdArg,
				criteria: z.array(Criterion).min(1).max(4),
				match: z.enum(['all', 'any']).optional(),
				matchCase: z.boolean().optional(),
			},
			annotations: READ_ONLY,
		},
		async ({ projectId, scope, sequenceId, criteria, match, matchCase }) => {
			const fields = scope === 'project' ? PROJECT_FIND_FIELDS : TIMELINE_FIND_FIELDS;
			for (const c of criteria)
				if (!(fields as readonly string[]).includes(c.field))
					throw new ToolError(
						'E_INVALID_PARAM',
						`Unknown field "${c.field}" for scope ${scope}`,
						`Use one of: ${fields.join(', ')}`,
					);
			const { doc } = await loadDoc(ctx, projectId);
			const query = { criteria: criteria as never, match: match ?? 'all', matchCase: !!matchCase };
			if (scope === 'project') {
				const ids = findProjectItems(doc, query);
				return jsonResult({
					count: ids.length,
					items: ids.slice(0, 500).map((id) => {
						const it = doc.items[id]!;
						return { itemId: id, name: it.name, kind: it.kind, label: it.label };
					}),
				});
			}
			const seq = pickSequence(doc, sequenceId);
			const hits = findTimelineHits(doc, seq.id, query);
			return jsonResult({
				sequenceId: seq.id,
				count: hits.length,
				hits: hits.slice(0, 500).map((h) => ({
					...h,
					timecode: sequenceTimecode(seq, h.frame),
					...(h.kind === 'clip'
						? { name: seq.clips[h.clipId]?.name, track: trackLabel(seq, h.trackId) }
						: {}),
				})),
			});
		},
	);

	defineTool(
		ctx,
		'locate_media',
		{
			title: 'Locate media (Edit Original)',
			description:
				'Where a media file is on the engine host and whether it is online. action "reveal" shows it in the host file browser, "open" opens it in its default application (Premiere Edit Original). Local engines only; programs are never opened.',
			input: {
				projectId: ProjectIdArg,
				mediaId: z.string().min(1).describe('Media id ("med_…") or a media / subclip item id'),
				action: z
					.enum(['none', 'reveal', 'open'])
					.optional()
					.describe('Default "none" (only report the path)'),
			},
			// Not read-only: "reveal" / "open" act on the host's desktop (outside the project).
			annotations: { ...EDIT, openWorldHint: true },
		},
		async ({ projectId, mediaId, action }) => {
			const { doc } = await loadDoc(ctx, projectId);
			const item = doc.items[mediaId];
			const id = item && (item.kind === 'media' || item.kind === 'subclip') ? item.mediaId : mediaId;
			const asset = doc.media[id];
			if (!asset)
				throw new ToolError('E_NOT_FOUND', `Media not found: ${mediaId}`, 'Call get_project for media ids.');
			const loc = asset.locators.find((l) => l.type === 'engine-store');
			if (loc?.type !== 'engine-store')
				throw new ToolError(
					'E_INVALID_PARAM',
					'This media has no file on the engine',
					'Only imported files can be located.',
				);
			const where = await ctx.engine((c) => c.call('mediaLocation', { params: { mediaKey: loc.key } }));
			if (action && action !== 'none') {
				if (!where.exists)
					throw new ToolError('MEDIA_OFFLINE', 'The media file is offline', 'Relink it with link_media.');
				await ctx.engine((c) => c.call('mediaOpen', { params: { mediaKey: loc.key }, body: { action } }));
			}
			return jsonResult({
				mediaId: id,
				name: asset.originalName,
				path: where.path,
				online: where.exists,
				action: action ?? 'none',
			});
		},
	);

	defineTool(
		ctx,
		'add_tracks',
		{
			title: 'Add tracks',
			description:
				'Premiere\'s Sequence ▸ Add Tracks…: video, audio and audio submix tracks in one undoable step. Placement "first", "last" (default) or after a track label ("V2", "A1", "S1"); audio / submix type mono, stereo (default) or 5.1.',
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg,
				video: z.object({ count: z.number().int().min(1).max(99), after: z.string().optional() }).optional(),
				audio: z
					.object({
						count: z.number().int().min(1).max(99),
						after: z.string().optional(),
						type: z.enum(['mono', 'stereo', '5.1']).optional(),
					})
					.optional(),
				submix: z
					.object({
						count: z.number().int().min(1).max(20),
						after: z.string().optional(),
						type: z.enum(['mono', 'stereo', '5.1']).optional(),
					})
					.optional(),
			},
			annotations: EDIT,
		},
		async ({ projectId, sequenceId, video, audio, submix }) => {
			if (!video && !audio && !submix)
				throw new ToolError('E_INVALID_PARAM', 'Nothing to add', 'Pass video, audio or submix.');
			const { doc } = await loadDoc(ctx, projectId);
			const seq = pickSequence(doc, sequenceId);
			const cmds: unknown[] = [];
			if (video)
				cmds.push({
					type: 'track.add',
					sequenceId: seq.id,
					kind: 'video',
					count: video.count,
					index: placementIndex(seq, 'video', video.after),
				});
			if (audio)
				cmds.push({
					type: 'track.add',
					sequenceId: seq.id,
					kind: 'audio',
					count: audio.count,
					index: placementIndex(seq, 'audio', audio.after),
					...(audio.type && audio.type !== 'stereo' ? { channelFormat: audio.type } : {}),
				});
			if (submix) {
				const at = placementIndex(seq, 'submix', submix.after);
				for (let i = 0; i < submix.count; i++)
					cmds.push({
						type: 'mixer.addSubmix',
						sequenceId: seq.id,
						index: at + i,
						channelFormat: submix.type ?? 'stereo',
					});
			}
			const res = await transact(ctx, projectId, { label: 'Add Tracks', commands: cmds, sequenceId: seq.id });
			return jsonResult(txBody(res, requireOk(res)));
		},
	);

	defineTool(
		ctx,
		'delete_tracks',
		{
			title: 'Delete tracks',
			description:
				'Premiere\'s Sequence ▸ Delete Tracks…: video / audio = "empty" (every empty track, the first kept when all are empty) or a list of track labels; submix = "unassigned" (no track routes to it) or labels like "S1". Tracks that hold clips need force: true (their clips are deleted). Needs the user\'s approval in an open editor.',
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg,
				video: z.union([z.literal('empty'), z.array(z.string()).min(1)]).optional(),
				audio: z.union([z.literal('empty'), z.array(z.string()).min(1)]).optional(),
				submix: z.union([z.literal('unassigned'), z.array(z.string()).min(1)]).optional(),
				force: z.boolean().optional(),
			},
			annotations: DESTRUCTIVE,
		},
		async ({ projectId, sequenceId, video, audio, submix, force }) => {
			const { doc } = await loadDoc(ctx, projectId);
			const seq = pickSequence(doc, sequenceId);
			const empty = (id: string) => !Object.values(seq.clips).some((c) => c.trackId === id);
			const pick = (list: Sequence['videoTracks'], spec: 'empty' | string[] | undefined) => {
				if (!spec) return [];
				if (spec === 'empty') {
					const e = list.filter((t) => empty(t.id)).map((t) => t.id);
					return e.length === list.length ? e.slice(1) : e;
				}
				return spec.map((ref) => {
					const t = list.find(
						(x) => x.id === ref || trackLabel(seq, x.id)?.toUpperCase() === ref.toUpperCase(),
					);
					if (!t)
						throw new ToolError(
							'E_NOT_FOUND',
							`Track not found: ${ref}`,
							'Call get_timeline for track labels.',
						);
					return t.id;
				});
			};
			const ids = [...pick(seq.videoTracks, video), ...pick(seq.audioTracks, audio)];
			const subs = seq.submixTracks ?? [];
			let submixIds: string[] = [];
			if (submix === 'unassigned') {
				const all = [...seq.audioTracks, ...subs];
				submixIds = subs
					.filter(
						(s) =>
							!all.some(
								(t) => t.mixer?.output === s.id || (t.mixer?.sends ?? []).some((x) => x.target === s.id),
							),
					)
					.map((s) => s.id);
			} else if (submix)
				submixIds = submix.map((ref) => {
					const m = /^S(\d+)$/i.exec(ref);
					const t = m ? subs[Number(m[1]) - 1] : subs.find((x) => x.id === ref);
					if (!t) throw new ToolError('E_NOT_FOUND', `Submix not found: ${ref}`, 'Submixes are S1, S2…');
					return t.id;
				});
			if (!ids.length && !submixIds.length) return jsonResult({ deleted: 0, note: 'No track matched' });
			const cmds: unknown[] = [];
			if (ids.length)
				cmds.push({
					type: 'track.remove',
					sequenceId: seq.id,
					trackIds: ids,
					...(force ? { force: true } : {}),
				});
			for (const id of submixIds) cmds.push({ type: 'mixer.removeSubmix', sequenceId: seq.id, stripId: id });
			const res = await transact(ctx, projectId, {
				label: 'Delete Tracks',
				commands: cmds,
				sequenceId: seq.id,
			});
			return jsonResult({
				...txBody(res, requireOk(res)),
				deletedTracks: ids.length,
				deletedSubmixes: submixIds.length,
			});
		},
	);

	defineTool(
		ctx,
		'get_project_settings',
		{
			title: 'Get Project Settings',
			description:
				'Project Settings: video / audio display formats, the Captured and Generated Media folder (null = "Same as Project"), the ingest settings, and the engine folders behind Scratch Disks (generated media, previews, media cache, auto-save versions) with free space.',
			input: { projectId: ProjectIdArg },
			annotations: READ_ONLY,
		},
		async ({ projectId }) => {
			const { doc } = await loadDoc(ctx, projectId);
			const scratch = await ctx
				.engine((c) => c.call('projectScratch', { params: { projectId } }))
				.catch(() => null);
			return jsonResult({ ...projectSettingsOf(doc), scratchDisks: scratch });
		},
	);

	defineTool(
		ctx,
		'set_project_settings',
		{
			title: 'Set Project Settings',
			description:
				'Changes Project Settings in one undoable step: videoDisplayFormat (timecode, frames, feet35, feet16), audioDisplayFormat (samples, milliseconds), mediaFolder (absolute folder for proxies / exported frames / Project Manager / ingest, null = "Same as Project"), ingest {enabled, action copy|transcode|proxies|copyAndProxies, preset, destination folder or null = next to the media}.',
			input: {
				projectId: ProjectIdArg,
				videoDisplayFormat: z.enum(VIDEO_DISPLAY_FORMATS).optional(),
				audioDisplayFormat: z.enum(AUDIO_DISPLAY_FORMATS).optional(),
				mediaFolder: z.string().min(1).nullable().optional(),
				ingest: z
					.object({
						enabled: z.boolean(),
						action: z.enum(INGEST_ACTIONS).optional(),
						preset: z.string().optional(),
						destination: z.string().min(1).nullable().optional(),
					})
					.optional(),
			},
			annotations: EDIT_IDEMPOTENT,
		},
		async ({ projectId, videoDisplayFormat, audioDisplayFormat, mediaFolder, ingest }) => {
			const { doc } = await loadDoc(ctx, projectId);
			const cur = projectSettingsOf(doc);
			if (mediaFolder) {
				const chk = await ctx.engine((c) => c.call('scratchCheck', { body: { path: mediaFolder } }));
				if (!chk.ok)
					throw new ToolError(
						'E_INVALID_PARAM',
						chk.message ?? 'The folder cannot be used',
						'Pass an absolute, writable folder.',
					);
			}
			if (ingest?.preset && !PROXY_PRESETS.some((p) => p.id === ingest.preset))
				throw new ToolError(
					'E_INVALID_PARAM',
					`Unknown preset ${ingest.preset}`,
					`Presets: ${PROXY_PRESETS.map((p) => p.id).join(', ')}`,
				);
			const settings: Record<string, unknown> = {};
			if (videoDisplayFormat || audioDisplayFormat)
				settings.display = {
					video: videoDisplayFormat ?? cur.display.video,
					audio: audioDisplayFormat ?? cur.display.audio,
				};
			if (mediaFolder !== undefined) settings.scratch = { media: mediaFolder };
			if (ingest)
				settings.ingest = {
					enabled: ingest.enabled,
					action: ingest.action ?? cur.ingest.action,
					...((ingest.preset ?? cur.ingest.preset) ? { preset: ingest.preset ?? cur.ingest.preset } : {}),
					destination: ingest.destination === undefined ? cur.ingest.destination : ingest.destination,
				};
			if (!Object.keys(settings).length)
				throw new ToolError('E_INVALID_PARAM', 'Nothing to change', 'Pass at least one setting.');
			const res = await transact(ctx, projectId, {
				label: 'Project Settings',
				commands: [{ type: 'project.updateSettings', settings }],
			});
			requireOk(res);
			const { doc: after } = await loadDoc(ctx, projectId);
			return jsonResult(projectSettingsOf(after));
		},
	);

	const mediaIdOf = (doc: Awaited<ReturnType<typeof loadDoc>>['doc'], id: string): string => {
		const item = doc.items[id];
		const m = item && (item.kind === 'media' || item.kind === 'subclip') ? item.mediaId : id;
		if (!doc.media[m])
			throw new ToolError('E_NOT_FOUND', `Media not found: ${id}`, 'Call get_project or list_media for ids.');
		return m;
	};
	const engineKey = (doc: Awaited<ReturnType<typeof loadDoc>>['doc'], mediaId: string): string => {
		const l = doc.media[mediaId]!.locators.find((x) => x.type === 'engine-store');
		if (l?.type !== 'engine-store')
			throw new ToolError(
				'E_INVALID_PARAM',
				`${mediaId} has no file on the engine`,
				'Only imported files have proxies.',
			);
		return l.key;
	};

	defineTool(
		ctx,
		'create_proxies',
		{
			title: 'Create proxies',
			description: 'Transcode video media to smaller proxies as one background job.',
			details: `Clip ▸ Proxy ▸ Create Proxies: transcodes video media to a smaller browser-playable proxy (presets ${PROXY_PRESETS.filter(
				(p) => p.kind === 'proxy',
			)
				.map((p) => p.id)
				.join(
					', ',
				)}; default proxy-720) as one background job and attaches the proxies when it ends (one undo step). destination: "next-to-media" (a Proxies folder beside each file, default), "project" (the project's generated-media folder) or an absolute folder. wait (default true) waits for the job and attaches; with wait false call wait_for_job and then create_proxies again is not needed — the editor attaches finished jobs only when it started them, so prefer wait.`,
			input: {
				projectId: ProjectIdArg,
				mediaIds: z.array(z.string().min(1)).min(1).max(500),
				preset: z.string().optional(),
				destination: z.union([z.enum(['next-to-media', 'project']), z.string().min(1)]).optional(),
				wait: z.boolean().optional(),
			},
			annotations: EDIT,
		},
		async ({ projectId, mediaIds, preset, destination, wait }, extra) => {
			const { doc } = await loadDoc(ctx, projectId);
			const ids = [...new Set(mediaIds.map((id) => mediaIdOf(doc, id)))];
			const items = ids.map((id) => ({
				mediaKey: engineKey(doc, id),
				mediaId: id,
				name: doc.media[id]!.originalName,
			}));
			const scratch = projectSettingsOf(doc).scratch.media;
			const dest =
				!destination || destination === 'next-to-media'
					? { mode: 'next-to-media' as const }
					: destination === 'project'
						? { mode: 'project' as const, ...(scratch ? { folder: scratch } : {}) }
						: { mode: 'folder' as const, folder: destination };
			const job = await ctx.engine((c) =>
				c.call('mediaJobs', {
					body: { projectId, op: 'proxy', ...(preset ? { preset } : {}), destination: dest, items },
				}),
			);
			const base = ctx.link.target?.url ?? '';
			if (wait === false)
				return jsonResult({
					...jobBody(job, base),
					note: 'The proxies are not attached until a create_proxies call waits for them; call again with wait.',
				});
			const { job: done, timedOut } = await waitJob(ctx, job.id, 60 * 60 * 1000, extra);
			if (timedOut) return jsonResult({ ...jobBody(done, base), timedOut: true });
			if (done.state !== 'succeeded')
				throw new ToolError(
					done.error?.code ?? 'JOB_FAILED',
					done.error?.message ?? `The job ${done.state}`,
					undefined,
					{ jobId: done.id },
				);
			const result = done.result as MediaJobResult;
			const { doc: now } = await loadDoc(ctx, projectId);
			const { commands, skipped } = mediaJobCommands(now, result, 'created');
			let tx: unknown = null;
			if (commands.length) {
				const res = await transact(ctx, projectId, { label: 'Create Proxies', commands });
				tx = txBody(res, requireOk(res));
			}
			return jsonResult({
				jobId: done.id,
				attached: result.outputs
					.filter((o) => commands.some((c) => (c as { mediaId: string }).mediaId === o.mediaId))
					.map((o) => ({ mediaId: o.mediaId, path: o.path })),
				skipped: [...result.skipped, ...skipped.map((reason) => ({ reason }))],
				transaction: tx,
			});
		},
	);

	defineTool(
		ctx,
		'attach_proxy',
		{
			title: 'Attach proxy',
			description:
				'Clip ▸ Proxy ▸ Attach Proxies: attaches an existing file (absolute path on this machine) as the proxy of a video media. Refused when its duration (± 1 frame) or frame rate differ, unless force.',
			input: {
				projectId: ProjectIdArg,
				mediaId: z.string().min(1),
				path: z.string().min(1),
				force: z.boolean().optional(),
			},
			annotations: EDIT_IDEMPOTENT,
		},
		async ({ projectId, mediaId, path, force }) => {
			const { doc } = await loadDoc(ctx, projectId);
			const id = mediaIdOf(doc, mediaId);
			const reg = await ctx.engine((c) => c.registerMedia({ projectId, paths: [path] }));
			const file = reg.items[0];
			if (!file)
				throw new ToolError(
					reg.errors[0]?.code ?? 'FILE_NOT_FOUND',
					reg.errors[0]?.message ?? 'The file could not be registered',
					'Pass an absolute path of an existing file.',
				);
			const why = proxyMismatch(doc.media[id]!, file.probe);
			if (why && !force) throw new ToolError('E_INVALID_PARAM', why, 'Pass force: true to attach it anyway.');
			const res = await transact(ctx, projectId, {
				label: 'Attach Proxies',
				commands: [
					{
						type: 'media.attachProxy',
						mediaId: id,
						proxy: attachedProxyFrom(file, 'attached'),
						...(force ? { force: true } : {}),
					},
				],
			});
			return jsonResult(txBody(res, requireOk(res)));
		},
	);

	defineTool(
		ctx,
		'detach_proxies',
		{
			title: 'Detach proxies',
			description:
				'Clip ▸ Proxy ▸ Detach Proxies: the media play their originals again (proxy files stay on disk).',
			input: { projectId: ProjectIdArg, mediaIds: z.array(z.string().min(1)).min(1) },
			annotations: DESTRUCTIVE_IDEMPOTENT,
		},
		async ({ projectId, mediaIds }) => {
			const { doc } = await loadDoc(ctx, projectId);
			const ids = [...new Set(mediaIds.map((m) => mediaIdOf(doc, m)))];
			const res = await transact(ctx, projectId, {
				label: 'Detach Proxies',
				commands: [{ type: 'media.detachProxy', mediaIds: ids }],
			});
			return jsonResult(txBody(res, requireOk(res)));
		},
	);

	defineTool(
		ctx,
		'reconnect_full_resolution',
		{
			title: 'Reconnect full resolution media',
			description:
				'Clip ▸ Proxy ▸ Reconnect Full Resolution Media: links a video media to its full-resolution file (absolute path). When the media had no proxy, the file it used becomes its proxy (a project edited from proxies only). The full-resolution file must have the same duration (± 1 frame) and frame rate.',
			input: { projectId: ProjectIdArg, mediaId: z.string().min(1), path: z.string().min(1) },
			annotations: EDIT,
		},
		async ({ projectId, mediaId, path }) => {
			const { doc } = await loadDoc(ctx, projectId);
			const id = mediaIdOf(doc, mediaId);
			const asset = doc.media[id]!;
			const reg = await ctx.engine((c) => c.registerMedia({ projectId, paths: [path] }));
			const file = reg.items[0] as RegisteredMedia | undefined;
			if (!file)
				throw new ToolError(
					reg.errors[0]?.code ?? 'FILE_NOT_FOUND',
					reg.errors[0]?.message ?? 'The file could not be registered',
					'Pass an absolute path of an existing file.',
				);
			const why = proxyMismatch(
				{ kind: file.kind, probe: file.probe, originalName: file.originalName },
				asset.proxy?.probe ?? asset.probe,
			);
			if (why) throw new ToolError('E_INVALID_PARAM', why, 'Choose the full-resolution file of this clip.');
			const same = file.fingerprint === asset.fingerprint;
			const commands: unknown[] = [
				{
					type: 'media.relink',
					mediaId: id,
					locator: file.locators[0],
					locators: file.locators,
					probe: file.probe,
					sizeBytes: file.sizeBytes,
					originalName: file.originalName,
					container: file.container,
					...(same ? {} : { fingerprint: file.fingerprint, replace: true }),
				},
			];
			if (!asset.proxy && !same)
				commands.push({
					type: 'media.attachProxy',
					mediaId: id,
					force: true,
					proxy: attachedProxyFrom(asset, 'attached'),
				});
			const res = await transact(ctx, projectId, { label: 'Reconnect Full Resolution Media', commands });
			return jsonResult(txBody(res, requireOk(res)));
		},
	);

	defineTool(
		ctx,
		'export_frame',
		{
			title: 'Export frame',
			description:
				'File ▸ Export ▸ Frame: renders the sequence frame at `at` at full resolution (never from proxies) and writes <folder>/<name>.<ext> on this machine (never overwriting: " (2)" is appended). format png (default), jpeg (jpegQuality), tiff, dpx (10-bit), exr (linear light, half float), bmp, tga. importIntoProject adds the file to the project like import_media. A transparent PNG needs `alpha: true`.',
			details:
				"alpha: true writes PNGs with straight alpha through the alpha-delivery job: one frame at at, or a numbered sequence up to end (a ZIP, or a folder of PNGs with folder + name); without folder the result is a URL. With clipIds only those clips (Export Title); trimMarginPx trims every frame to what they paint across the whole range plus that margin, rendering past the sequence frame so glows do not clip, and origin says where the picture's corner sits in the sequence. format, jpegQuality and importIntoProject are for the opaque frame; end, clipIds and trimMarginPx need alpha.",
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg,
				at: timeArg('Sequence frame to export'),
				format: z.enum(['png', 'jpeg', 'tiff', 'dpx', 'exr', 'bmp', 'tga']).optional(),
				jpegQuality: z.number().int().min(1).max(100).optional(),
				folder: z
					.string()
					.min(1)
					.optional()
					.describe('Folder on this machine; with alpha, omit it to get a URL'),
				name: z.string().min(1).max(200).optional(),
				importIntoProject: z.boolean().optional(),
				...AlphaFrameArgs,
			},
			annotations: EDIT,
		},
		async (
			{
				projectId,
				sequenceId,
				at,
				format,
				jpegQuality,
				folder,
				name,
				importIntoProject,
				alpha,
				end,
				clipIds,
				trimMarginPx,
				timeoutSeconds,
			},
			extra,
		) => {
			if (alpha) {
				if (format !== undefined && format !== 'png')
					throw new ToolError('E_INVALID_PARAM', `alpha writes PNG, not ${format}`, 'Leave format out.');
				if (jpegQuality !== undefined || importIntoProject)
					throw new ToolError(
						'E_INVALID_PARAM',
						'jpegQuality and importIntoProject are for the opaque frame',
						'Leave them out with alpha.',
					);
				return exportAlphaFrames(
					ctx,
					{ projectId, at, end, sequenceId, clipIds, trimMarginPx, timeoutSeconds, folder, name },
					extra,
				);
			}
			if (end !== undefined || clipIds !== undefined || trimMarginPx !== undefined)
				throw new ToolError(
					'E_INVALID_PARAM',
					'end, clipIds and trimMarginPx export PNGs with alpha',
					'Add alpha: true.',
				);
			if (folder === undefined)
				throw new ToolError('E_INVALID_PARAM', 'export_frame writes into a folder', 'Pass folder.');
			const loaded = await loadDoc(ctx, projectId);
			const seq = pickSequence(loaded.doc, sequenceId);
			let frame: number;
			try {
				frame = resolveFrameInput(seq, at);
			} catch (e) {
				throw new ToolError('E_INVALID_PARAM', (e as Error).message, TIME_HINT);
			}
			const item = Object.values(loaded.doc.items).find(
				(i) => i.kind === 'sequence' && i.sequenceId === seq.id,
			);
			const fileName = (
				name ?? `${item?.name ?? 'Sequence'} ${sequenceTimecode(seq, frame).replace(/[:;]/g, '_')}`
			).replace(/[\\/]/g, '_');
			const envelope = toolEnvelope(loaded.doc, loaded.revision);
			const job = await ctx.engine((c) =>
				c.requestStill({
					envelope,
					sequenceId: seq.id,
					frame,
					...(format ? { format } : {}),
					...(jpegQuality ? { jpegQuality } : {}),
					destination: { folder, name: fileName },
				}),
			);
			const { job: done, timedOut } = await waitJob(ctx, job.id, 10 * 60 * 1000, extra);
			if (timedOut)
				throw new ToolError(
					'RENDER_TIMEOUT',
					'The frame is still rendering',
					'Call wait_for_job with this jobId.',
					{ jobId: job.id },
				);
			if (done.state !== 'succeeded')
				throw new ToolError(
					done.error?.code ?? 'JOB_FAILED',
					done.error?.message ?? `The frame ${done.state}`,
					undefined,
					{ jobId: done.id },
				);
			const result = done.result as { path?: string; format?: string };
			let mediaId: string | undefined;
			if (importIntoProject && result.path) {
				const reg = await ctx.engine((c) => c.registerMedia({ projectId, paths: [result.path!] }));
				const file = reg.items[0];
				if (file) {
					const res = await transact(ctx, projectId, {
						label: 'Import Frame',
						commands: [mediaRegisterCommand(file, '$m', '$i')],
					});
					const ok = requireOk(res);
					mediaId = (ok.results[0] as { mediaId?: string } | undefined)?.mediaId;
				}
			}
			return jsonResult({
				frame,
				timecode: sequenceTimecode(seq, frame),
				path: result.path,
				format: result.format ?? format ?? 'png',
				...(mediaId ? { mediaId } : {}),
			});
		},
	);

	defineTool(
		ctx,
		'get_sequence_settings',
		{
			title: 'Get Sequence Settings',
			description:
				'Sequence Settings of a sequence: timebase, display and storage frame size, pixel aspect ratio, fields, drop frame, start timecode, audio sample rate, Mix channels, working colour space and Video Previews.',
			input: { projectId: ProjectIdArg, sequenceId: SequenceIdArg },
			annotations: READ_ONLY,
		},
		async ({ projectId, sequenceId }) => {
			const { doc } = await loadDoc(ctx, projectId);
			const seq = pickSequence(doc, sequenceId);
			const st = seq.settings;
			const f = sequenceFormatOf(st);
			return jsonResult({
				sequenceId: seq.id,
				frameRate: st.frameRate,
				width: st.width,
				height: st.height,
				storageWidth: f.storageWidth,
				pixelAspectRatio: f.par,
				fieldOrder: f.fieldOrder,
				dropFrame: st.dropFrame,
				startTimecodeFrames: st.startTimecodeFrames,
				audioSampleRate: st.audioSampleRate,
				masterLayout: st.masterLayout,
				workingColorSpace: st.workingColorSpace,
				previews: seq.previews ?? null,
				hasClips: Object.keys(seq.clips).length > 0,
			});
		},
	);

	defineTool(
		ctx,
		'set_sequence_settings',
		{
			title: 'Set Sequence Settings',
			description:
				'Changes Sequence Settings in one undoable step. frameRate {num,den} (a sequence with clips needs conform: true: clips, markers and keyframes move to the new rate); width/height (square pixels) or storageWidth + pixelAspectRatio {num,den} (null = square); fieldOrder progressive|upper|lower; dropFrame; audioSampleRate 44100|48000|96000; masterLayout mono|stereo|5.1; reposition of existing clips when the size changes.',
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg,
				frameRate: z
					.object({ num: z.number().int().positive(), den: z.number().int().positive() })
					.optional(),
				width: z.number().int().optional(),
				height: z.number().int().optional(),
				storageWidth: z.number().int().optional(),
				pixelAspectRatio: z
					.object({ num: z.number().int().positive(), den: z.number().int().positive() })
					.nullable()
					.optional(),
				fieldOrder: z.enum(['progressive', 'upper', 'lower']).optional(),
				dropFrame: z.boolean().optional(),
				audioSampleRate: z.union([z.literal(44100), z.literal(48000), z.literal(96000)]).optional(),
				masterLayout: z.enum(['mono', 'stereo', '5.1']).optional(),
				reposition: z.enum(['keep-offset-from-center', 'scale-proportionally', 'keep-pixels']).optional(),
				conform: z.boolean().optional(),
			},
			annotations: EDIT_IDEMPOTENT,
		},
		async ({ projectId, sequenceId, conform, reposition, ...rest }) => {
			const { doc } = await loadDoc(ctx, projectId);
			const seq = pickSequence(doc, sequenceId);
			const settings = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
			if (!Object.keys(settings).length)
				throw new ToolError('E_INVALID_PARAM', 'Nothing to change', 'Pass at least one setting.');
			const fr = rest.frameRate;
			const changesRate = fr && fr.num * seq.settings.frameRate.den !== seq.settings.frameRate.num * fr.den;
			if (changesRate && Object.keys(seq.clips).length && !conform)
				throw new ToolError(
					'E_IN_USE',
					'The sequence has clips: changing its timebase conforms them to the new rate',
					'Pass conform: true to do it anyway (Premiere locks the timebase of a sequence with clips).',
				);
			const res = await transact(ctx, projectId, {
				label: 'Sequence Settings',
				sequenceId: seq.id,
				commands: [
					{
						type: 'sequence.updateSettings',
						sequenceId: seq.id,
						settings,
						...(reposition ? { reposition } : {}),
					},
				],
			});
			return jsonResult(txBody(res, requireOk(res)));
		},
	);

	defineTool(
		ctx,
		'new_sequence_from_clip',
		{
			title: 'New sequence from clip',
			description:
				"Premiere's New Sequence From Clip: a sequence named after the item matching its media's frame size, frame rate, pixel aspect ratio and fields (HDR media: an HDR working space), with the clip placed at the start.",
			input: {
				projectId: ProjectIdArg,
				itemId: z.string().min(1).describe('Media item id ("itm_…") or media id'),
			},
			annotations: EDIT,
		},
		async ({ projectId, itemId }) => {
			const { doc } = await loadDoc(ctx, projectId);
			const it = doc.items[itemId];
			const mediaId = it && it.kind === 'media' ? it.mediaId : doc.media[itemId] ? itemId : null;
			if (!mediaId)
				throw new ToolError(
					'E_NOT_FOUND',
					`Media item not found: ${itemId}`,
					'Call get_project for item ids.',
				);
			const name = it?.name ?? doc.media[mediaId]!.originalName;
			const res = await transact(ctx, projectId, {
				label: 'New Sequence From Clip',
				commands: [{ type: 'sequence.create', name, fromMediaId: mediaId }],
			});
			return jsonResult(txBody(res, requireOk(res)));
		},
	);

	const Routing = z.object({
		streamIndex: z.number().int().min(0),
		map: z.array(z.number().int().min(0)).min(1).max(6),
		mute: z.array(z.number().int().min(0)).max(6).optional(),
	});

	defineTool(
		ctx,
		'get_audio_channels',
		{
			title: 'Get audio channels',
			description:
				'The source channels of a media (rows of the Audio Channels matrix) and the routing of its item or of timeline clips.',
			input: {
				projectId: ProjectIdArg,
				itemId: z.string().min(1).optional().describe('A media item ("itm_…")'),
				sequenceId: SequenceIdArg,
				clipIds: z.array(z.string().min(1)).optional(),
			},
			annotations: READ_ONLY,
		},
		async ({ projectId, itemId, sequenceId, clipIds }) => {
			const { doc } = await loadDoc(ctx, projectId);
			if (itemId) {
				const it = doc.items[itemId];
				if (it?.kind !== 'media')
					throw new ToolError('E_NOT_FOUND', `Media item not found: ${itemId}`, 'Call get_project.');
				const asset = doc.media[it.mediaId]!;
				return jsonResult({
					sourceChannels: sourceChannels(asset),
					routing: it.audioChannels ?? null,
				});
			}
			const seq = pickSequence(doc, sequenceId);
			const clips = (clipIds ?? []).map((id) => seq.clips[id]).filter((c) => c?.kind === 'audio');
			if (!clips.length)
				throw new ToolError(
					'E_INVALID_PARAM',
					'Pass itemId or audio clipIds',
					'Clip ids come from get_timeline.',
				);
			return jsonResult({
				sourceChannels: sourceChannels(doc.media[clips[0]!.mediaId]!),
				clips: clips.map((c) => ({ clipId: c.id, channels: c.channels })),
			});
		},
	);

	defineTool(
		ctx,
		'set_audio_channels',
		{
			title: 'Set audio channels',
			description:
				'Clip ▸ Modify ▸ Audio Channels in one undoable step: clipIds + clips (one routing per audio clip of one media) or itemIds + clips (the audio clips placements of the items create; null = default). A routing reads one audio stream: map[i] = the source channel of clip channel i, mute = clip channels that are silent.',
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg,
				clipIds: z.array(z.string().min(1)).min(1).max(32).optional(),
				itemIds: z.array(z.string().min(1)).min(1).optional(),
				clips: z.array(Routing).min(1).max(32).nullable(),
			},
			annotations: EDIT_IDEMPOTENT,
		},
		async ({ projectId, sequenceId, clipIds, itemIds, clips }) => {
			if (!!clipIds === !!itemIds)
				throw new ToolError('E_INVALID_PARAM', 'Pass clipIds or itemIds', 'One of the two.');
			let cmd: unknown;
			let seqId: string | undefined;
			if (clipIds) {
				if (!clips)
					throw new ToolError('E_INVALID_PARAM', 'Timeline clips need a routing per clip', 'Pass clips.');
				const { doc } = await loadDoc(ctx, projectId);
				seqId = pickSequence(doc, sequenceId).id;
				cmd = { type: 'clip.setAudioChannels', sequenceId: seqId, clipIds, channels: clips };
			} else cmd = { type: 'item.setAudioChannels', itemIds, clips };
			const res = await transact(ctx, projectId, {
				label: 'Audio Channels',
				commands: [cmd],
				...(seqId ? { sequenceId: seqId } : {}),
			});
			return jsonResult(txBody(res, requireOk(res)));
		},
	);

	defineTool(
		ctx,
		'project_manager',
		{
			title: 'Project Manager',
			description:
				'File ▸ Project Manager: a self-contained copy of a project in a folder on this machine. mode collect (whole files) or consolidate (the used part + handlesFrames, ProRes 422 HQ / WAV, clips re-based so every edit stays put). sequenceIds (default all; nested ones follow), excludeUnused (default true), includePreviews, includeProxies (collect), projectName. dryRun returns the estimate only; otherwise waits for the job and returns the report (new projectId, files written, offline media).',
			input: {
				projectId: ProjectIdArg,
				destination: z.string().min(1),
				mode: z.enum(['collect', 'consolidate']),
				sequenceIds: z.array(z.string()).optional(),
				excludeUnused: z.boolean().optional(),
				handlesFrames: z.number().int().min(0).max(10_000).optional(),
				includePreviews: z.boolean().optional(),
				includeProxies: z.boolean().optional(),
				projectName: z.string().min(1).max(200).optional(),
				dryRun: z.boolean().optional(),
			},
			annotations: EDIT,
		},
		async ({ projectId, dryRun, ...o }, extra) => {
			const loaded = await loadDoc(ctx, projectId);
			const envelope = toolEnvelope(loaded.doc, loaded.revision);
			const options = {
				destination: o.destination,
				mode: o.mode,
				...(o.sequenceIds ? { sequenceIds: o.sequenceIds } : {}),
				excludeUnused: o.excludeUnused ?? true,
				handlesFrames: o.handlesFrames ?? 30,
				includePreviews: o.includePreviews ?? false,
				includeProxies: o.includeProxies ?? true,
				...(o.projectName ? { projectName: o.projectName } : {}),
			};
			if (dryRun)
				return jsonResult(
					await ctx.engine((c) => c.call('projectManagerPlan', { body: { envelope, options } })),
				);
			const job = await ctx.engine((c) => c.call('projectManagerStart', { body: { envelope, options } }));
			const { job: done, timedOut } = await waitJob(ctx, job.id, 6 * 60 * 60 * 1000, extra);
			const base = ctx.link.target?.url ?? '';
			if (timedOut) return jsonResult({ ...jobBody(done, base), timedOut: true });
			if (done.state !== 'succeeded')
				throw new ToolError(
					done.error?.code ?? 'JOB_FAILED',
					done.error?.message ?? `Project Manager ${done.state}`,
					undefined,
					{ jobId: done.id },
				);
			return jsonResult({ jobId: done.id, ...(done.result as object) });
		},
	);

	defineTool(
		ctx,
		'stabilize_clip',
		{
			title: 'Warp Stabilizer',
			description: 'Apply Warp Stabilizer to a video clip and analyse it.',
			details:
				"Effect ▸ Distort ▸ Warp Stabilizer on a video clip, end to end: adds the effect when the clip has none (with params: result smoothMotion / noMotion, smoothness %, method position / positionScaleRotation / perspective / subspaceWarp, preserveScale, framing stabilizeOnly / stabilizeCrop / stabilizeCropAutoScale / synthesizeEdges, maxScale %, actionSafe %, additionalScale %, detailedAnalysis, rollingShutterRipple automatic / enhanced, cropLessSmoothMore 0-100, synthesisInputRange s, synthesisEdgeFeather, edgeCropLeft/Top/Right/Bottom px, hideWarningBanner; existing instances are updated with param.set), runs the engine analysis of the clip's media range (+15 frames handles) and stores it with the effect (no undo step). An analysed effect is reused while it covers the clip. Exports refuse an un-analysed stabiliser (WARP_NOT_ANALYZED).",
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg,
				clipId: z.string().min(1),
				params: z.record(z.string(), z.unknown()).optional(),
				reanalyze: z.boolean().optional(),
			},
			annotations: EDIT,
		},
		async ({ projectId, sequenceId, clipId, params, reanalyze }, extra) => {
			let { doc } = await loadDoc(ctx, projectId);
			let seq = pickSequence(doc, sequenceId);
			const clip = seq.clips[clipId];
			if (!clip)
				throw new ToolError('E_NOT_FOUND', `Clip not found: ${clipId}`, 'Call get_timeline for clip ids.');
			if (clip.kind !== 'video')
				throw new ToolError('E_INVALID_PARAM', 'The Warp Stabilizer needs a video clip');
			type Fx = { id: string; effectId: string; enabled: boolean; params: Record<string, unknown> };
			const fxOf = (c: unknown) =>
				((c as { effects?: Fx[] }).effects ?? []).find((e) => e.effectId === WARP_STABILIZER_EFFECT_ID);
			let fx = fxOf(clip);
			const edits: unknown[] = [];
			if (!fx)
				edits.push({
					type: 'effect.add',
					target: { clipId },
					effectId: WARP_STABILIZER_EFFECT_ID,
					...(params ? { params } : {}),
				});
			else if (params)
				for (const [name, value] of Object.entries(params))
					edits.push({ type: 'param.set', target: ['effect', fx.id, name], value });
			if (edits.length) {
				const res = await transact(ctx, projectId, {
					label: 'Warp Stabilizer',
					sequenceId: seq.id,
					commands: edits,
				});
				requireOk(res);
				({ doc } = await loadDoc(ctx, projectId));
				seq = pickSequence(doc, seq.id);
				fx = fxOf(seq.clips[clipId]);
			}
			if (!fx) throw new ToolError('E_INTERNAL', 'The Warp Stabilizer was not added');
			const request = warpRequestFor(
				doc,
				seq,
				seq.clips[clipId]!,
				(reanalyze ? { ...fx, warpAnalysis: undefined } : fx) as never,
			);
			if (!request) return jsonResult({ effectInstanceId: fx.id, analysed: true, reused: true });
			const job = await ctx.engine((c) =>
				c.call('warpAnalysis', {
					body: {
						projectId,
						mediaKey: request.mediaKey,
						mediaId: request.mediaId,
						startFrame: request.startFrame,
						frameCount: request.frameCount,
						detailed: request.detailed,
					},
				}),
			);
			const { job: done, timedOut } = await waitJob(ctx, job.id, 60 * 60 * 1000, extra);
			const base = ctx.link.target?.url ?? '';
			if (timedOut) return jsonResult({ ...jobBody(done, base), timedOut: true });
			if (done.state !== 'succeeded')
				throw new ToolError(
					done.error?.code ?? 'JOB_FAILED',
					done.error?.message ?? `The analysis ${done.state}`,
					undefined,
					{
						jobId: done.id,
					},
				);
			const { analysedFrames, framesPerSec, ...analysis } = done.result as WarpAnalysisResult;
			const res = await transact(ctx, projectId, {
				label: 'Analyze (Warp Stabilizer)',
				commands: [{ type: 'effect.setWarpAnalysis', effectInstanceId: fx.id, analysis }],
			});
			return jsonResult({
				effectInstanceId: fx.id,
				analysed: true,
				frames: analysedFrames,
				...(framesPerSec ? { framesPerSec } : {}),
				confidence: analysis.confidence,
				transaction: txBody(res, requireOk(res)),
			});
		},
	);

	defineTool(
		ctx,
		'auto_reframe_sequence',
		{
			title: 'Auto Reframe Sequence',
			description:
				'Sequence ▸ Auto Reframe Sequence: analyses the subject of every video clip of a sequence on the engine (faces when the face model is installed, else motion / contrast / skin saliency), then makes a copy at another aspect ratio (aspect "1:1", "4:5", "9:16", "16:9" or "W:H") whose clips fill the frame and follow their subject with Position keyframes (tracking slower / default / faster). One undo step; returns the new sequence id, the reframed clips and the clips kept (already animated Motion).',
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg,
				aspect: z
					.string()
					.regex(/^\d{1,3}:\d{1,3}$/)
					.default('9:16'),
				tracking: z.enum(['slower', 'default', 'faster']).default('default'),
				name: z.string().min(1).max(255).optional(),
			},
			annotations: EDIT,
		},
		async ({ projectId, sequenceId, aspect, tracking, name }, extra) => {
			const { doc } = await loadDoc(ctx, projectId);
			const seq = pickSequence(doc, sequenceId);
			const [num, den] = aspect.split(':').map(Number) as [number, number];
			if (!(num > 0 && den > 0)) throw new ToolError('E_INVALID_PARAM', `Bad aspect ${aspect}`);
			const jobs = reframeJobsFor(doc, seq.id);
			if (!jobs.length)
				throw new ToolError('E_INVALID_PARAM', 'The sequence has no video clips of engine media to reframe');
			const subjects: { clipId: string; start: number; frameDuration: number; points: number[] }[] = [];
			const sources: string[] = [];
			const base = ctx.link.target?.url ?? '';
			for (const j of jobs) {
				const job = await ctx.engine((c) =>
					c.call('reframeAnalysis', {
						body: { projectId, mediaKey: j.mediaKey, startFrame: j.startFrame, frameCount: j.frameCount },
					}),
				);
				const { job: done, timedOut } = await waitJob(ctx, job.id, 60 * 60 * 1000, extra);
				if (timedOut) return jsonResult({ ...jobBody(done, base), timedOut: true });
				if (done.state !== 'succeeded')
					throw new ToolError(
						done.error?.code ?? 'JOB_FAILED',
						done.error?.message ?? `The analysis ${done.state}`,
						undefined,
						{ jobId: done.id },
					);
				const r = done.result as ReframeResult;
				sources.push(r.source + (r.note ? ` (${r.note})` : ''));
				for (const clipId of j.clipIds)
					subjects.push({ clipId, start: r.start, frameDuration: r.frameDuration, points: r.points });
			}
			const size = reframeSize(seq.settings.width, seq.settings.height, { num, den });
			const res = await transact(ctx, projectId, {
				label: 'Auto Reframe Sequence',
				commands: [
					{
						type: 'sequence.autoReframe',
						sequenceId: seq.id,
						width: size.width,
						height: size.height,
						tracking,
						...(name ? { name } : {}),
						subjects,
					},
				],
			});
			const ok = requireOk(res);
			return jsonResult({
				...(ok.results[0] as object),
				size,
				subjectSources: [...new Set(sources)],
				transaction: txBody(res, ok),
			});
		},
	);

	defineTool(
		ctx,
		'create_graphic',
		{
			title: 'New graphic (Essential Graphics)',
			description: 'Create a graphic clip whose first layer is a text, rectangle or ellipse.',
			details:
				'Essential Graphics ▸ New Layer with nothing selected: a graphic clip at `at` on `track` (default: a new top track) whose first layer is a text (text), rectangle or ellipse. A graphic is a nested sequence flagged as graphic: its tracks are the layers. Then use apply_commands with graphic.addLayer, graphic.align (left/center/right/top/middle/bottom/distributeHorizontal/distributeVertical to the frame or the selection), graphic.setPins (Responsive Design – Position) and set_graphic. Returns the graphic sequence id and the graphic clip id.',
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg,
				at: timeArg('Sequence time of the graphic'),
				kind: z.enum(['text', 'rectangle', 'ellipse']).default('text'),
				text: z.string().max(10_000).optional(),
				seconds: z.number().positive().max(3600).default(5),
				track: z.string().optional().describe('Video track label ("V2"); default a new top track'),
				name: z.string().min(1).max(255).optional(),
			},
			annotations: EDIT,
		},
		async ({ projectId, sequenceId, at, kind, text, seconds, track, name }) => {
			const { doc } = await loadDoc(ctx, projectId);
			const seq = pickSequence(doc, sequenceId);
			const frame = resolveFrameInput(seq, at);
			const dur = Math.max(
				1,
				Math.round((seconds * seq.settings.frameRate.num) / seq.settings.frameRate.den),
			);
			const where = track ?? `V${seq.videoTracks.length + 1}`;
			const place = { at: { frames: frame }, duration: { frames: dur }, track: where, ref: '$l' };
			const first =
				kind === 'text'
					? { type: 'clip.addText', ...place, content: { text: text ?? 'New Text' } }
					: {
							type: 'clip.addShape',
							...place,
							shape: { type: kind === 'rectangle' ? 'rect' : 'ellipse', size: [400, 240] },
						};
			const res = await transact(ctx, projectId, {
				label: 'New Graphic',
				sequenceId: seq.id,
				commands: [
					...(track ? [] : [{ type: 'track.add', kind: 'video' }]),
					first,
					{ type: 'clip.nest', clipIds: ['$l'], name: name ?? 'Graphic', ref: '$g' },
					{ type: 'graphic.update', sequenceId: '$g', graphic: { intro: 0, outro: 0 } },
				],
			});
			const ok = requireOk(res);
			const gid = ok.refs.$g!;
			const { doc: now } = await loadDoc(ctx, projectId);
			const clip = Object.values(pickSequence(now, seq.id).clips).find(
				(c) => c.kind === 'nest-video' && (c as { sequenceId: string }).sequenceId === gid,
			);
			return jsonResult({
				graphicSequenceId: gid,
				graphicClipId: clip?.id ?? null,
				transaction: txBody(res, ok),
			});
		},
	);

	defineTool(
		ctx,
		'set_graphic',
		{
			title: 'Graphic settings',
			description:
				'Essential Graphics settings of a graphic sequence: Responsive Design – Time (intro / outro frames kept at their speed when the graphic clip is shorter or longer than the graphic), duration (frames; layers reaching the end follow), roll (null = still, or {mode: roll | crawlLeft | crawlRight, startOffScreen, endOffScreen, preRoll, easeIn, easeOut, postRoll} in frames). Roll and Responsive Time render on every path (they are applied to the graphic clip when rendering).',
			input: {
				projectId: ProjectIdArg,
				graphicSequenceId: z.string().min(1),
				intro: z.number().int().min(0).optional(),
				outro: z.number().int().min(0).optional(),
				duration: z.number().int().min(1).optional(),
				roll: z
					.object({
						mode: z.enum(['roll', 'crawlLeft', 'crawlRight']),
						startOffScreen: z.boolean().default(true),
						endOffScreen: z.boolean().default(true),
						preRoll: z.number().int().min(0).default(0),
						easeIn: z.number().int().min(0).default(0),
						easeOut: z.number().int().min(0).default(0),
						postRoll: z.number().int().min(0).default(0),
					})
					.nullable()
					.optional(),
			},
			annotations: EDIT_IDEMPOTENT,
		},
		async ({ projectId, graphicSequenceId, ...graphic }) => {
			const res = await transact(ctx, projectId, {
				label: 'Essential Graphics',
				commands: [{ type: 'graphic.update', sequenceId: graphicSequenceId, graphic }],
			});
			return jsonResult(txBody(res, requireOk(res)));
		},
	);

	defineTool(
		ctx,
		'export_graphic_template',
		{
			title: 'Export graphic template (.jgt)',
			description:
				'Essential Graphics ▸ Export As Template: the .jgt template (JSON) of a graphic sequence item — the graphic with its layers, fonts and media references. Save it with a .jgt extension; import_graphic_template adds it to any project. MOGRT files (Adobe Motion Graphics templates) cannot be imported: see the guide.',
			input: {
				projectId: ProjectIdArg,
				graphicSequenceId: z.string().min(1),
				name: z.string().min(1).max(255).optional(),
			},
			annotations: READ_ONLY,
		},
		async ({ projectId, graphicSequenceId, name }) => {
			const { doc } = await loadDoc(ctx, projectId);
			const item = Object.values(doc.items).find(
				(i) => i.kind === 'sequence' && (i as { sequenceId: string }).sequenceId === graphicSequenceId,
			);
			if (!item) throw new ToolError('E_NOT_FOUND', `No sequence item for ${graphicSequenceId}`);
			const t = graphicTemplateOf(doc, item.id, name ?? item.name, (d, ids) => buildItemsPayload(d, ids));
			if (!t) throw new ToolError('E_INVALID_PARAM', `${graphicSequenceId} is not a graphic`);
			return jsonResult(t);
		},
	);

	defineTool(
		ctx,
		'import_graphic_template',
		{
			title: 'Add graphic template (.jgt)',
			description:
				'Essential Graphics ▸ Browse ▸ add a template: places a .jgt template (the JSON from export_graphic_template) as a new graphic clip at `at` on `track` (default V2), adding its graphic sequence to the project.',
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg,
				template: z.record(z.string(), z.unknown()),
				at: timeArg('Sequence time of the graphic'),
				track: z.string().optional(),
			},
			annotations: EDIT,
		},
		async ({ projectId, sequenceId, template, at, track }) => {
			const { doc } = await loadDoc(ctx, projectId);
			const seq = pickSequence(doc, sequenceId);
			const res = await transact(ctx, projectId, {
				label: 'Add Graphic Template',
				sequenceId: seq.id,
				commands: [
					{
						type: 'graphic.importTemplate',
						template,
						sequenceId: seq.id,
						at: { frames: resolveFrameInput(seq, at) },
						track: track ?? 'V2',
					},
				],
			});
			return jsonResult(txBody(res, requireOk(res)));
		},
	);
}
