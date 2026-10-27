import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { mediaRegisterCommand } from '@jasper/api';
import { EngineError } from '@jasper/engine-client';
import {
	BUILTIN_PRESETS,
	DEFAULT_PRESET_ID,
	mediaUsage,
	mediaVersionsOf,
	needsPlaybackAudio,
	rootFrameSpan,
	sourceRangeFromSidecar,
	undecodableAudioStreams,
} from '@jasper/project';
import { z } from 'zod';
import { ProjectIdArg } from '../arguments.ts';
import {
	defineTool,
	EDIT,
	EDIT_IDEMPOTENT,
	loadDoc,
	READ_ONLY,
	requireOk,
	type ToolContext,
	transact,
} from '../context.ts';
import { jsonResult, ToolError } from '../errors.ts';
import { mediaSummary, projectSummary } from '../format.ts';

const PRESET_IDS = BUILTIN_PRESETS.map((p) => p.id) as [string, ...string[]];

/** Opens a URL with the OS default handler (browser). */
function openUrl(url: string): void {
	const [cmd, args] =
		process.platform === 'darwin'
			? ['open', [url]]
			: process.platform === 'win32'
				? ['cmd', ['/c', 'start', '""', url]]
				: ['xdg-open', [url]];
	const child = spawn(cmd, args as string[], { detached: true, stdio: 'ignore' });
	child.on('error', () => {});
	child.unref();
}

export function registerProjectTools(ctx: ToolContext): void {
	defineTool(
		ctx,
		'engine_status',
		{
			title: 'Engine status',
			description:
				'Shows which JasperEditor engine this server talks to (URL, how it was found, version), what it can render (native ffmpeg export, fframes motion graphics, Remotion, available encoders) and where speech-to-text runs (the GPU provider probe: providers with reasons, chosen encoder/decoder, threads, recommended model, NVIDIA CUDA provider state). Call it first when other tools report that the engine is unreachable.',
			input: {},
			annotations: READ_ONLY,
		},
		async () => {
			const caps = await ctx.engine((c) => c.capabilities());
			const t = ctx.link.target;
			return jsonResult({
				engine: {
					url: t?.url,
					foundBy: t?.source,
					...(t?.detail ? { detail: t.detail } : {}),
					version: caps.engine.version,
				},
				agentName: ctx.agentName(),
				render: caps.render,
				encoding: caps.media.encoding
					? {
							license: caps.media.encoding.license,
							export: caps.media.encoding.export?.label ?? null,
							codecs: caps.media.encoding.codecs,
							...(caps.media.encoding.message ? { message: caps.media.encoding.message } : {}),
						}
					: undefined,
				pathImport: caps.engine.pathRegistration,
				// spec 16 SG-031: the speech-to-text provider probe (where transcription runs)
				speech: caps.features?.speech
					? {
							status: caps.features.speech.status,
							...(caps.features.speech.reason ? { reason: caps.features.speech.reason } : {}),
							providers: caps.features.speech.providers ?? 'not probed yet (list_speech_models probes)',
							chosen: caps.features.speech.chosen ?? null,
							threads: caps.features.speech.threads ?? null,
							recommendedModel: caps.features.speech.recommendedModel ?? null,
							cuda: caps.features.speech.cuda ?? null,
						}
					: undefined,
			});
		},
	);

	defineTool(
		ctx,
		'list_projects',
		{
			title: 'List projects',
			description:
				'Lists the projects stored by the engine (id, name, last modified, revision), newest first. Use the projectId with every other tool.',
			input: {},
			annotations: READ_ONLY,
		},
		async () => {
			const { projects } = await ctx.engine((c) => c.listProjects());
			return jsonResult({
				projects: [...projects]
					.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
					.map((p) => ({
						projectId: p.projectId,
						name: p.name,
						modifiedAt: p.modifiedAt,
						revision: p.revision,
					})),
			});
		},
	);

	defineTool(
		ctx,
		'create_project',
		{
			title: 'Create project',
			description: `Creates an empty project with one sequence (3 video + 3 audio tracks: V1–V3, A1–A3). The preset sets the sequence frame size and rate (default ${DEFAULT_PRESET_ID}). Returns the projectId and the sequence summary.`,
			input: {
				name: z.string().min(1).max(120).describe('Project name'),
				preset: z
					.enum(PRESET_IDS)
					.optional()
					.describe(
						`Sequence preset: ${BUILTIN_PRESETS.map((p) => `${p.id} (${p.name})`).join(', ')}. Default ${DEFAULT_PRESET_ID}.`,
					),
			},
			annotations: EDIT,
		},
		async ({ name, preset }) => {
			const { projectId } = await ctx.engine((c) =>
				c.createProject({ name, preset: preset ?? DEFAULT_PRESET_ID }),
			);
			const { doc, revision, live } = await loadDoc(ctx, projectId);
			return jsonResult(projectSummary(doc, revision, live));
		},
	);

	defineTool(
		ctx,
		'get_project',
		{
			title: 'Get project',
			description:
				'Summary of a project: sequences (size, fps, duration), tracks (V1…/A1…, locked/muted), every clip (id, kind, track, start/end in frames and timecode, source media and range), markers, and the imported media. editorOpen = true when an editor window has it open (then reads and edits are live). For a compact table of one sequence use get_timeline.',
			input: { projectId: ProjectIdArg },
			annotations: READ_ONLY,
		},
		async ({ projectId }) => {
			const { doc, revision, live } = await loadDoc(ctx, projectId);
			return jsonResult(projectSummary(doc, revision, live));
		},
	);

	defineTool(
		ctx,
		'open_project_in_editor',
		{
			title: 'Open project in the editor',
			description:
				'Asks every open JasperEditor window (desktop app or browser tab) to open this project, so your edits appear live with "Agent: …" undo entries and the user can approve destructive changes. Waits until the editor has the project open. If no editor window is running, returns the URL of the project and a note for the user: the editor is the desktop app, the dev server (`pnpm dev`, http://127.0.0.1:5173) or a browser the user paired with the engine. An agent cannot sign a browser in (launchBrowser only works on an engine started without a token, JASPER_INSECURE_DEV=1).',
			input: {
				projectId: ProjectIdArg,
				launchBrowser: z
					.boolean()
					.optional()
					.describe('Open the editor URL in the default browser when no editor window is connected'),
				waitSeconds: z
					.number()
					.int()
					.min(0)
					.max(60)
					.optional()
					.describe('How long to wait for the editor to open the project (default 15)'),
			},
			annotations: EDIT_IDEMPOTENT,
		},
		async ({ projectId, launchBrowser, waitSeconds }) => {
			const r = await ctx.engine((c) => c.agentOpenProject({ projectId }));
			const base = ctx.link.target?.url ?? '';
			const url = `${base}${r.path}`;
			let launched = false;
			if (!r.live && r.editors === 0 && launchBrowser) {
				if (ctx.link.target?.token)
					throw new ToolError(
						'NEEDS_DESKTOP_APP',
						'This engine requires a token, so a browser opened from here would not be signed in to it.',
						'Ask the user to open the project in JasperEditor: the desktop window, the dev server (`pnpm dev`), or a browser they paired with the link the engine printed.',
					);
				openUrl(url);
				launched = true;
			}
			let live = r.live;
			const until = Date.now() + (waitSeconds ?? 15) * 1000;
			while (!live && (r.editors > 0 || launched) && Date.now() < until) {
				await new Promise((res) => setTimeout(res, 500));
				try {
					const q = await ctx.engine((c) => c.agentQuery({ projectId, query: 'playhead.get', args: {} }));
					live = q.via === 'session';
				} catch (e) {
					if (
						!(e instanceof EngineError) ||
						(e.code !== 'NO_SESSION' && e.status !== 409 && e.status !== 503)
					)
						throw e;
				}
			}
			return jsonResult({
				projectId,
				editorOpen: live,
				editorWindowsNotified: r.editors,
				url,
				...(launched ? { launchedBrowser: true } : {}),
				...(live
					? {}
					: {
							note:
								r.editors === 0 && !launched
									? 'No editor window is running. Ask the user to open JasperEditor (the desktop app, or the dev server of `pnpm dev`); edits still work headlessly meanwhile.'
									: 'The editor did not open the project in time (it may be showing a dialog). Edits still work headlessly.',
						}),
			});
		},
	);

	defineTool(
		ctx,
		'import_media',
		{
			title: 'Import media files',
			description:
				'Imports video, audio or image files into a project by absolute path on this machine (the engine probes each file; nothing is uploaded). Returns one mediaId per file with duration, video size/fps and audio channels. Then place them with add_clip. Re-importing a file already in the project adds a new Project item for the same media (deduped: true). A rendered file with a source-range sidecar next to it (<name>.json or <stem>.json with "first_src_frame", e.g. a graded render with handles) records the source frames it holds and becomes a version of its source when that is in the project (matched by file name): use_media_version then switches clips to it on the same source frames.',
			input: {
				projectId: ProjectIdArg,
				paths: z
					.array(z.string().min(1))
					.min(1)
					.max(200)
					.describe('Absolute file paths, e.g. ["/home/me/footage/interview.mp4"]'),
				copyIntoProject: z
					.boolean()
					.optional()
					.describe('Copy the files into the engine media store instead of referencing them in place'),
			},
			annotations: EDIT,
		},
		async ({ projectId, paths, copyIntoProject }, extra) => {
			const problems: { path: string; code: string; message: string }[] = [];
			const ok: string[] = [];
			for (const p of paths) {
				if (!isAbsolute(p)) problems.push({ path: p, code: 'NOT_ABSOLUTE', message: 'Use an absolute path' });
				else if (!existsSync(p) || !statSync(p).isFile())
					problems.push({ path: p, code: 'FILE_NOT_FOUND', message: 'No such file on this machine' });
				else ok.push(p);
			}
			if (!ok.length)
				throw new ToolError(
					'NO_FILES',
					'None of the paths can be imported',
					'Pass absolute paths of existing files.',
					{
						errors: problems,
					},
				);
			const reg = await ctx.engine((c) =>
				c.registerMedia({ projectId, paths: ok, ...(copyIntoProject ? { copyIntoProject: true } : {}) }),
			);
			problems.push(...reg.errors);
			const registeredPaths = ok.filter((p) => !reg.errors.some((e) => e.path === p));
			const imported: Record<string, unknown>[] = [];
			if (reg.items.length) {
				const commands: Record<string, unknown>[] = reg.items.map((item, i) =>
					mediaRegisterCommand(item, `$m${i}`, `$i${i}`),
				);
				// S07:PRC-019: renders with a source-range sidecar become versions of their source (in the project or
				// in this batch, matched by file name).
				if (reg.items.some((it) => it.sourceHint)) {
					const { doc: before } = await loadDoc(ctx, projectId);
					const table: Record<string, { id: string; originalName: string; fingerprint?: string }> = {
						...before.media,
					};
					reg.items.forEach((it, i) => {
						table[`$m${i}`] = { id: `$m${i}`, originalName: it.originalName, fingerprint: it.fingerprint };
					});
					reg.items.forEach((it, i) => {
						if (!it.sourceHint) return;
						const sourceRange = sourceRangeFromSidecar({ media: table }, it.sourceHint, {
							probe: it.probe,
							id: `$m${i}`,
						});
						if (sourceRange) commands.push({ type: 'media.setSourceRange', mediaId: `$m${i}`, sourceRange });
					});
				}
				const res = await transact(
					ctx,
					projectId,
					{ label: `Import ${reg.items.length} file${reg.items.length === 1 ? '' : 's'}`, commands },
					extra,
				);
				const r = requireOk(res);
				const { doc } = await loadDoc(ctx, projectId);
				reg.items.forEach((item, i) => {
					const range = (doc.media[r.refs[`$m${i}`] ?? ''] as { sourceRange?: unknown } | undefined)
						?.sourceRange;
					const out = r.results[i] as { mediaId?: string; itemId?: string; deduped?: boolean } | undefined;
					const mediaId = out?.mediaId ?? r.refs[`$m${i}`];
					const asset = mediaId ? doc.media[mediaId] : undefined;
					imported.push({
						path: registeredPaths[i],
						...(asset ? mediaSummary(doc, asset) : { name: item.originalName, kind: item.kind }),
						mediaId,
						itemId: out?.itemId ?? r.refs[`$i${i}`],
						...(out?.deduped ? { deduped: true } : {}),
						...(range ? { sourceRange: range, sidecar: item.sourceHint?.sidecar } : {}),
						...((note) => (note ? { note } : {}))(
							[
								item.browserPlayable === 'no' && item.kind !== 'audio'
									? 'needs a proxy for preview (queued)'
									: null,
								asset && needsPlaybackAudio(asset)
									? 'previews play a playback copy of its audio (queued); exports read the file'
									: null,
							]
								.filter(Boolean)
								.join('; '),
						),
					});
				});
			}
			return jsonResult({
				imported,
				...(problems.length ? { errors: problems } : {}),
			});
		},
	);

	defineTool(
		ctx,
		'list_media',
		{
			title: 'List media',
			description:
				'Lists the media imported into a project: mediaId, Project item name, kind, duration, video size/fps, audio channels, and how many clips use it.',
			input: { projectId: ProjectIdArg },
			annotations: READ_ONLY,
		},
		async ({ projectId }) => {
			const { doc } = await loadDoc(ctx, projectId);
			const usage = mediaUsage(doc);
			return jsonResult({
				media: Object.values(doc.media).map((m) => ({
					...mediaSummary(doc, m),
					clips: usage[m.id]?.clips ?? 0,
				})),
			});
		},
	);

	defineTool(
		ctx,
		'get_media_info',
		{
			title: 'Get media info',
			description:
				"Full details of one media asset: every stream from the probe (codec, size, fps, rotation, channels, sample rate), file locations, the engine status of its derived files (poster, waveform peaks, filmstrip, proxy, playback-audio), playbackAudio (needed: the browser cannot decode the audio — WMA, AC-3, ALAC… — so previews play the engine's lossless playback copy, silent until its status is ready; exports always decode the original), its derivation (for processed versions: the original and the recipe), its sourceRange (which source frames the file holds) and every version of the same original with the source frames [start, end) each holds (for use_media_version).",
			input: {
				projectId: ProjectIdArg,
				mediaId: z.string().min(1).describe('Media id ("med_…") from list_media or import_media'),
			},
			annotations: READ_ONLY,
		},
		async ({ projectId, mediaId }) => {
			const { doc } = await loadDoc(ctx, projectId);
			const asset = doc.media[mediaId];
			if (!asset)
				throw new ToolError(
					'E_NOT_FOUND',
					`No media ${mediaId} in this project`,
					'Call list_media for valid ids.',
				);
			const key = asset.locators.find((l) => l.type === 'engine-store');
			let engine: unknown = null;
			if (key && key.type === 'engine-store')
				engine = await ctx
					.engine((c) => c.mediaStatus(key.key))
					.catch((e) => ({ error: (e as Error).message }));
			return jsonResult({
				...mediaSummary(doc, asset),
				originalName: asset.originalName,
				container: asset.container,
				sizeBytes: asset.sizeBytes,
				probe: asset.probe,
				locators: asset.locators,
				engine,
				// pp-wma-preview: audio the browser cannot decode plays from the engine's playback copy in previews.
				playbackAudio: needsPlaybackAudio(asset)
					? {
							needed: true,
							codecs: [...new Set(undecodableAudioStreams(asset).map((s) => s.codec))],
							status:
								(engine as { derivatives?: Record<string, unknown> } | null)?.derivatives?.[
									'playback-audio'
								] ?? null,
						}
					: { needed: false },
				// S07:PRA-002: processed versions (wp-m2-process).
				derivation: asset.derivation ?? null,
				// M3 (S07:PRC-015…019): the source frames the file holds, and per version.
				sourceRange: asset.sourceRange ?? null,
				versions: mediaVersionsOf(doc, mediaId).map((id, i) => ({
					mediaId: id,
					name: doc.media[id]?.originalName ?? id,
					original: i === 0,
					...((s) => (s ? { sourceFrames: { start: s.start, end: s.end } } : {}))(rootFrameSpan(doc, id)),
					...(doc.media[id]?.derivation?.recipe.op === 'process'
						? { steps: (doc.media[id]!.derivation!.recipe as { steps: unknown[] }).steps }
						: {}),
				})),
			});
		},
	);
}
