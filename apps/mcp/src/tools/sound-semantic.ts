// Describe-it search and Find Moment tools (spec 12 P6-E14, WP-E9; wp-note "Phase 6 → WP-E9"): the optional audio-text
// model (LAION CLAP, Apache-2.0, ≈ 780 MB, analysis only) — its status and install / removal, preparing the library
// (`sound-embed`), finding the best moments of a recording for a description and placing one on the timeline. Search by
// description itself is `search_sounds {describe}` (./sound.ts).
import {
	type EngineJob,
	type RegisterSoundResponse,
	SOUND_DESCRIBE_MAX_CHARS,
	SOUND_MOMENT_MAX_COUNT,
	SOUND_MOMENT_MAX_SEC,
	SOUND_MOMENT_MIN_SEC,
	SoundEmbedResultSchema,
	type SoundEntry,
	SoundMomentResultSchema,
	type SoundSemanticModelsResponse,
	type SoundSemanticStatus,
} from '@jasper/api';
import {
	FLICKS_PER_SECOND,
	type MediaAsset,
	mediaDurationFlicks,
	planMomentPlacement,
	readLibraryProvenance,
	requiresAttribution,
	sequenceTimecode,
	TimeInputSchema,
	trackLabel,
} from '@jasper/project';
import { z } from 'zod';
import { ProjectIdArg, SequenceIdArg, TIME_FORMATS } from '../arguments.ts';
import {
	DESTRUCTIVE_IDEMPOTENT,
	defineTool,
	EDIT,
	EDIT_IDEMPOTENT,
	frameOf,
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
import { livePlayhead } from './color.ts';
import { importCommands, resolveAudioTrack, SoundIdArg, soundCall } from './sound.ts';

export { DESCRIBE_GUIDE } from './sound-describe-guide.ts';

const MB = (n: number) => Math.round((n / 1_048_576) * 10) / 10;

export function registerSoundSemanticTools(ctx: ToolContext): void {
	const base = () => ctx.link.target?.url ?? '';

	defineTool(
		ctx,
		'describe_search_status',
		{
			title: 'Describe-it search status',
			description:
				'Whether Describe-it search (search_sounds {describe}) and Find Moment work on this engine: status ready | not-installed | unavailable (with the reason), the model (name, licence, attribution, pinned revision, size on disk and still to download, installed, available — false when its download location is pending), how many library sounds and takes have an embedding, and the running sound-embed job.',
			input: {},
			annotations: READ_ONLY,
		},
		async () => {
			const s = await soundCall<SoundSemanticStatus>(ctx, (c) => c.soundSemanticStatus());
			const { models } = await soundCall<SoundSemanticModelsResponse>(ctx, (c) => c.soundSemanticModels());
			return jsonResult({
				status: s.status,
				reason: s.reason,
				embedded: s.embedded,
				total: s.total,
				job: s.job ? jobBody(s.job, base()) : null,
				models: models.map((m) => ({
					modelId: m.id,
					name: m.name,
					license: m.license,
					licenseUrl: m.licenseUrl,
					attribution: m.attribution,
					source: m.sourceUrl,
					revision: m.revision,
					sizeMB: MB(m.sizeBytes),
					downloadMB: MB(m.missingBytes),
					installed: m.installed,
					available: m.available,
					...(m.unavailableReason ? { unavailableReason: m.unavailableReason } : {}),
					job: m.job ? jobBody(m.job, base()) : null,
				})),
				next:
					s.status === 'not-installed'
						? 'Describe search falls back to keywords. Ask the user before install_describe_search_model (tell them the download size and the Apache-2.0 licence).'
						: s.status === 'ready' && s.embedded < s.total
							? 'Some sounds have no embedding yet: prepare_describe_search {wait: true}.'
							: undefined,
			});
		},
	);

	defineTool(
		ctx,
		'install_describe_search_model',
		{
			title: 'Install Describe-it search model',
			description:
				"Downloads the Describe-it search model (LAION CLAP larger_clap_general: weights and tokenizer from LAION's own repository at a pinned revision, every file checked against its SHA-256; Apache-2.0; ≈ 780 MB) through a model-download job; afterwards the library is embedded in the background. Analysis only: it never makes sounds. TELL THE USER the download size and licence first and install only when they want it. Refused with MODEL_DOWNLOAD_PENDING while the model's download location is not settled. wait (default false) waits for the download.",
			input: {
				modelId: z.string().min(1).max(64).optional().describe('Model id (default: the catalogue’s first)'),
				wait: z.boolean().optional().describe('Wait for the download (default false)'),
				timeoutSeconds: z
					.number()
					.int()
					.min(1)
					.max(7200)
					.optional()
					.describe('How long to wait (default 3600)'),
			},
			annotations: EDIT_IDEMPOTENT,
		},
		async (a, extra) => {
			const { models } = await soundCall<SoundSemanticModelsResponse>(ctx, (c) => c.soundSemanticModels());
			const m = a.modelId ? models.find((x) => x.id === a.modelId) : models[0];
			if (!m)
				throw new ToolError(
					'E_NOT_FOUND',
					`Unknown Describe-it search model ${a.modelId ?? ''}`,
					'Call describe_search_status.',
				);
			const job = await soundCall<EngineJob>(ctx, (c) => c.installSoundSemanticModel(m.id));
			const model = {
				modelId: m.id,
				license: m.license,
				attribution: m.attribution,
				downloadMB: MB(m.missingBytes),
			};
			if (!a.wait)
				return jsonResult({ ...jobBody(job, base()), model, next: 'wait_for_job with this jobId.' });
			const { job: done, timedOut } = await waitJob(ctx, job.id, (a.timeoutSeconds ?? 3600) * 1000, extra, {
				cancelJobOnAbort: false,
			});
			return jsonResult({ ...jobBody(done, base()), model, ...(timedOut ? { timedOut: true } : {}) });
		},
	);

	defineTool(
		ctx,
		'remove_describe_search_model',
		{
			title: 'Remove Describe-it search model',
			description:
				"Deletes the downloaded Describe-it search model and its cached embeddings from the engine; search goes back to keywords. Needs the user's approval in an open JasperEditor window (E_APPROVAL_DENIED: they said no or no window was open; do not retry without asking). Removing a model that is not installed changes nothing.",
			input: { modelId: z.string().min(1).max(64) },
			annotations: DESTRUCTIVE_IDEMPOTENT,
		},
		async ({ modelId }) => jsonResult(await soundCall(ctx, (c) => c.removeSoundSemanticModel(modelId))),
	);

	defineTool(
		ctx,
		'prepare_describe_search',
		{
			title: 'Prepare Describe-it search',
			description:
				'Embeds the library sounds and takes that have no embedding of the installed model yet (a sound-embed job, incremental; the cache is keyed by file content and range, so renamed files keep theirs and changed files get new ones). One sound takes about 0.6–0.9 s of CPU on 8 threads (measured). full: true embeds everything again. wait: true waits with progress; the result counts embedded, reused and failed sounds.',
			input: {
				full: z.boolean().optional(),
				wait: z.boolean().optional().describe('Wait for the job (default false)'),
				timeoutSeconds: z
					.number()
					.int()
					.min(1)
					.max(7200)
					.optional()
					.describe('How long to wait (default 1800)'),
			},
			annotations: EDIT_IDEMPOTENT,
		},
		async (a, extra) => {
			const job = await soundCall<EngineJob>(ctx, (c) => c.embedSounds(a.full ? { full: true } : {}));
			if (!a.wait) return jsonResult(jobBody(job, base()));
			const { job: done, timedOut } = await waitJob(ctx, job.id, (a.timeoutSeconds ?? 1800) * 1000, extra, {
				cancelJobOnAbort: false,
			});
			const r = SoundEmbedResultSchema.safeParse(done.result);
			return jsonResult({
				...jobBody(done, base()),
				...(r.success
					? { embedded: r.data.embedded, reused: r.data.reused, failed: r.data.failed, errors: r.data.errors }
					: {}),
				...(timedOut ? { timedOut: true } : {}),
			});
		},
	);

	defineTool(
		ctx,
		'find_sound_moment',
		{
			title: 'Find a moment in a recording',
			description:
				'Finds the moments of a library sound (a long recording: a field recording, a typing session, a foley take) that best match a description, with the Describe-it search model. Returns up to count non-overlapping moments, best first: startSec / endSec in the sound (shrunk to where the sound is unless trim: false), match {z, verdict, cosine} and headDb / tailDb (a loud head or tail means the moment is cut inside a sound). Windows are cached per recording: a second description of the same recording is fast. Place one with insert_sound_moment. Needs the model (describe_search_status).',
			input: {
				soundId: SoundIdArg.describe(
					'Sound id from search_sounds (a recording; a take searches inside the take)',
				),
				description: z
					.string()
					.min(1)
					.max(SOUND_DESCRIBE_MAX_CHARS)
					.describe(
						'Source + material + action + character: "a single clean key press on a mechanical keyboard"',
					),
				lengthSec: z
					.number()
					.min(SOUND_MOMENT_MIN_SEC)
					.max(SOUND_MOMENT_MAX_SEC)
					.optional()
					.describe('Length of the windows compared, seconds (default 2)'),
				count: z
					.number()
					.int()
					.min(1)
					.max(SOUND_MOMENT_MAX_COUNT)
					.optional()
					.describe('Moments returned (default 3)'),
				startSec: z.number().min(0).optional().describe('Search only from here (seconds in the sound)'),
				endSec: z.number().min(0).optional().describe('…to here'),
				trim: z.boolean().optional().describe('Shrink each moment to its sound (default true)'),
				timeoutSeconds: z
					.number()
					.int()
					.min(1)
					.max(7200)
					.optional()
					.describe('How long to wait (default 1800)'),
			},
			annotations: READ_ONLY,
		},
		async (a, extra) => {
			const { soundId, timeoutSeconds, ...req } = a;
			const job = await soundCall<EngineJob>(ctx, (c) => c.findSoundMoments(soundId, req));
			const { job: done, timedOut } = await waitJob(ctx, job.id, (timeoutSeconds ?? 1800) * 1000, extra, {
				cancelJobOnAbort: true,
			});
			if (timedOut)
				return jsonResult({
					...jobBody(done, base()),
					timedOut: true,
					next: 'wait_for_job with this jobId.',
				});
			if (done.state !== 'succeeded')
				throw new ToolError(
					done.error?.code ?? 'MOMENT_FAILED',
					done.error?.message ?? `The search ended ${done.state}`,
					'Check describe_search_status, the sound id and the range.',
				);
			const r = SoundMomentResultSchema.parse(done.result);
			return jsonResult({
				soundId: r.soundId,
				description: r.description,
				range: { startSec: r.startSec, endSec: r.endSec },
				lengthSec: r.lengthSec,
				moments: r.moments.map((m, i) => ({
					rank: i + 1,
					startSec: m.startSec,
					endSec: m.endSec,
					durationSec: Math.round((m.endSec - m.startSec) * 1000) / 1000,
					z: m.match.z,
					verdict: m.match.verdict,
					headDb: m.headDb,
					tailDb: m.tailDb,
					...(m.headDb > -15 ? { headCut: true } : {}),
					...(m.tailDb > -30 ? { tailCut: true } : {}),
					trimmed: m.trimmed,
				})),
				windows: { computed: r.computed, cached: r.cached },
				next: r.moments.length
					? 'insert_sound_moment {projectId, soundId, startSec, endSec, at} places one; tell the user which moment you chose and why (numbers), and ask them to listen.'
					: 'Nothing matched: rephrase the description (source + material + action + character).',
			});
		},
	);

	defineTool(
		ctx,
		'insert_sound_moment',
		{
			title: 'Insert a moment of a sound',
			description:
				'Places a range of a library sound (a moment from find_sound_moment) on the timeline with its start on `at`, on a free unmuted "SFX…" audio track over its span or a new "SFX n" (or the track you give, which must be free there). ONE undo step registers and imports the sound (into the Sound Effects bin, reusing the project\'s copy) and places the clip with that source range. Returns the clip, its track, start and end.',
			input: {
				projectId: ProjectIdArg,
				soundId: SoundIdArg,
				startSec: z.number().min(0).describe('Start of the range in the sound (seconds)'),
				endSec: z.number().min(0).describe('End of the range (seconds)'),
				at: z
					.union([z.literal('playhead'), TimeInputSchema])
					.describe(`Where the range starts: "playhead" or ${TIME_FORMATS}`),
				track: z
					.string()
					.min(1)
					.max(200)
					.optional()
					.describe('"auto" (default) or an audio track ("A3", id or name)'),
				sequenceId: SequenceIdArg,
			},
			annotations: EDIT,
		},
		async (a, extra) => {
			if (!(a.endSec > a.startSec))
				throw new ToolError(
					'E_INVALID_PARAM',
					'endSec must be after startSec',
					'Use a moment from find_sound_moment.',
				);
			const entry = await soundCall<SoundEntry>(ctx, (c) => c.getSound(a.soundId));
			const reg = await soundCall<RegisterSoundResponse>(ctx, (c) => c.registerSound(a.soundId, a.projectId));
			const title = entry.title || reg.library.title || reg.originalName;
			for (let attempt = 0; ; attempt++) {
				const { doc, revision } = await loadDoc(ctx, a.projectId);
				const seq = pickSequence(doc, a.sequenceId);
				let at: number;
				if (a.at === 'playhead') {
					const ph = await livePlayhead(ctx, a.projectId, seq.id);
					if (ph === null)
						throw new ToolError(
							'E_NO_SESSION',
							'"playhead" needs an editor window showing this sequence',
							'Call open_project_in_editor, or give at as a frame, {"seconds": x} or a timecode.',
						);
					at = ph;
				} else at = frameOf(seq, a.at);
				const { commands, media } = importCommands(doc, [{ soundId: a.soundId, reg, title }]);
				const existing = media[0]!.mediaId;
				const provenance =
					(existing && readLibraryProvenance((doc.media[existing] as { library?: unknown }).library)) ||
					reg.library;
				const durFlicks =
					(existing ? mediaDurationFlicks(doc.media[existing] as MediaAsset) : reg.probe.durationFlicks) ??
					Math.round(entry.format.durationSec * FLICKS_PER_SECOND);
				const preferred =
					a.track && a.track.toLowerCase() !== 'auto' ? resolveAudioTrack(seq, a.track) : null;
				const plan = planMomentPlacement({
					seq,
					mediaRef: existing ?? media[0]!.ref!,
					startSec: a.startSec,
					endSec: a.endSec,
					leadSec: provenance.leadSilenceSec ?? 0,
					mediaDurationFlicks: durFlicks,
					at,
					preferredTrackId: preferred,
				});
				if (!plan.ok)
					throw new ToolError(plan.code, plan.message, 'Check startSec / endSec against get_sound.');
				if (
					preferred &&
					(plan.placement.track.kind !== 'existing' || plan.placement.track.trackId !== preferred)
				)
					throw new ToolError(
						'E_OVERLAP',
						`${a.track} is not free over the moment's span`,
						'Use track "auto" or another track.',
					);
				commands.push(...plan.placement.commands);
				const label = `Add Sound Moment ${title}`.slice(0, 200);
				const res = await transact(
					ctx,
					a.projectId,
					{
						label,
						commands,
						sequenceId: seq.id,
						...(revision !== undefined ? { expectedRevision: revision } : {}),
					},
					extra,
				);
				if (
					!res.result.ok &&
					attempt === 0 &&
					res.result.errors.some((e) => e.code === 'E_REVISION_MISMATCH')
				)
					continue;
				const r = requireOk(res);
				const clipId = r.refs.$momentClip;
				const after = (await loadDoc(ctx, a.projectId)).doc.sequences[seq.id];
				const clip = clipId ? after?.clips[clipId] : undefined;
				if (!after || !clip)
					throw new ToolError(
						'INTERNAL',
						'The moment was added but its clip was not found',
						'Call get_timeline.',
					);
				return jsonResult({
					...txBody(res, r),
					historyLabel: label,
					clipId,
					soundId: a.soundId,
					title,
					track: trackLabel(after, clip.trackId) ?? clip.trackId,
					trackCreated: plan.placement.track.kind === 'new',
					start: { frame: clip.start, timecode: sequenceTimecode(after, clip.start) },
					end: {
						frame: clip.start + clip.duration,
						timecode: sequenceTimecode(after, clip.start + clip.duration),
					},
					range: { startSec: a.startSec, endSec: a.endSec },
					...(requiresAttribution(entry.license) ? { credit: entry.attribution } : {}),
					...(reg.inexact ? { notes: [reg.inexact.message] } : {}),
				});
			}
		},
	);
}
