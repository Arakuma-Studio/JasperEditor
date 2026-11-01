// spec 18 AF-OPS-002: `derive_media` — one media derivation op (conform-cfr, reverse, denoise-audio, extract-audio,
// time-stretch, range) on the engine (`POST /api/media/:key/derive`), committed as ONE undoable `media.derive`.
import { DeriveRecipeSchema, type DeriveResult, LOCAL_ENGINE_ID } from '@jasper/api';
import {
	type DeriveRecipe,
	deriveProblems,
	FLICKS_PER_SECOND,
	type MediaLocator,
	type ProjectDocument,
} from '@jasper/project';
import { z } from 'zod';
import { ProjectIdArg } from '../arguments.ts';
import {
	defineTool,
	EDIT_IDEMPOTENT,
	jobBody,
	loadDoc,
	requireOk,
	type ToolContext,
	transact,
	txBody,
	waitJob,
} from '../context.ts';
import { jsonResult, ToolError } from '../errors.ts';

export const DERIVE_GUIDE = `Media operations (derive_media): make a new media from one media in one step — conform-cfr {frameRate: {num, den}} (constant frame rate, 1…240 fps; frames placed by timestamp, audio kept in sync — do this first for phone footage with a variable frame rate), reverse {} (picture and sound; long media are reversed in bounded segments), denoise-audio {strength 0…1} (FFmpeg afftdn: noise reduction 6…36 dB; a 24-bit WAV of the first audio stream), extract-audio {streamIndex, format: wav|flac} (get_media_info lists the stream indices), time-stretch {rate 0.25…4 (2 = twice as fast), preservePitch} (picture retimed onto the source frame rate; pitch kept with atempo or shifted by resampling), range {inFlicks, outFlicks} (frame-accurate [in, out) of the media in flicks: 705600000 per second; the result is a version of the source, so clips can switch to it). Video results are ProRes + PCM .mov, audio results WAV or FLAC. The result is added to the bin "Processed" in one undo step; the same media + recipe reuses the finished file. Refusals: NO_AUDIO, NO_VIDEO, UNSUPPORTED_RATE, OUT_OF_RANGE, EMPTY_RANGE, UNSUPPORTED_MEDIA, MEDIA_OFFLINE. Loudness normalisation, stabilisation and restoration have their own tools (normalize_media_loudness, process_clip).`;

function engineKey(doc: ProjectDocument, mediaId: string): string {
	const asset = doc.media[mediaId];
	if (!asset)
		throw new ToolError(
			'E_NOT_FOUND',
			`No media ${mediaId} in this project`,
			'Call list_media for valid ids.',
		);
	const loc = asset.locators.find((l) => l.type === 'engine-store');
	if (!loc)
		throw new ToolError(
			'E_INVALID_PARAM',
			`Media ${mediaId} is not known to the engine`,
			'Re-import it with import_media.',
		);
	return loc.key;
}

const HINTS: Record<string, string> = {
	NO_AUDIO:
		'get_media_info lists the media streams; audio ops need an audio stream (extract-audio: its index).',
	NO_VIDEO: 'conform-cfr needs a video stream.',
	UNSUPPORTED_RATE: 'conform-cfr takes 1…240 fps; time-stretch takes rate 0.25…4.',
	OUT_OF_RANGE:
		'The range must lie inside the media: get_media_info gives its duration (flicks = seconds × 705600000).',
	EMPTY_RANGE: 'outFlicks must be after inFlicks and the range must hold at least one frame start.',
	MEDIA_OFFLINE: 'Relink the media (list_offline_media, then link_media) and try again.',
	UNSUPPORTED_MEDIA: 'Pick a video or audio media with a known duration (conform-cfr needs video).',
};

export function registerDeriveTools(ctx: ToolContext): void {
	defineTool(
		ctx,
		'derive_media',
		{
			title: 'Derive media',
			description: `Runs one file operation on a media and adds the result to the project (bin "Processed") as one undoable step. recipe.op: conform-cfr {frameRate {num, den}, 1…240 fps}, reverse {}, denoise-audio {strength 0…1}, extract-audio {streamIndex, format wav|flac}, time-stretch {rate 0.25…4, preservePitch}, range {inFlicks, outFlicks} (frame-accurate [in, out); 705600000 flicks per second). Waits for the job (timeoutSeconds, default 600) unless wait: false; calling again with the same arguments reuses the finished file. replaceInClips: audio clips switch to a denoise-audio result, video clips to a range result (keeping their source frames). Refusals are coded: NO_AUDIO, NO_VIDEO, UNSUPPORTED_RATE, OUT_OF_RANGE, EMPTY_RANGE, UNSUPPORTED_MEDIA, MEDIA_OFFLINE.`,
			input: {
				projectId: ProjectIdArg,
				mediaId: z.string().min(1).describe('Media id ("med_…") to derive from'),
				recipe: DeriveRecipeSchema.describe(
					'The operation, e.g. {"op":"reverse"}, {"op":"time-stretch","rate":0.5,"preservePitch":true}, {"op":"range","inFlicks":705600000,"outFlicks":2116800000}',
				),
				replaceInClips: z
					.array(z.string().min(1))
					.max(1000)
					.optional()
					.describe('Clips to switch to the result (denoise-audio: audio clips; range: video clips)'),
				wait: z.boolean().optional().describe('Wait for the job and commit the result (default true)'),
				timeoutSeconds: z.number().int().min(1).max(900).optional(),
			},
			annotations: EDIT_IDEMPOTENT,
		},
		async ({ projectId, mediaId, recipe, replaceInClips, wait, timeoutSeconds }, extra) => {
			const { doc } = await loadDoc(ctx, projectId);
			const key = engineKey(doc, mediaId);
			const asset = doc.media[mediaId]!;
			const problem = deriveProblems(asset, recipe as DeriveRecipe)[0];
			if (problem) throw new ToolError(problem.code, problem.message, HINTS[problem.code]);
			if (replaceInClips?.length && recipe.op !== 'denoise-audio' && recipe.op !== 'range')
				throw new ToolError(
					'E_INVALID_PARAM',
					`Clips cannot switch to a ${recipe.op} result (its timing or streams differ)`,
					'Place the result with add_clip instead.',
				);
			const job = await ctx.engine((c) => c.deriveMedia(key, { projectId, recipe }));
			const base = ctx.link.target?.url ?? '';
			if (wait === false)
				return jsonResult({
					...jobBody(job, base),
					next: 'Call wait_for_job with this jobId, then derive_media again with the same arguments to add the result (the finished file is reused).',
				});
			const { job: done, timedOut } = await waitJob(ctx, job.id, (timeoutSeconds ?? 600) * 1000, extra);
			if (timedOut)
				return jsonResult({
					...jobBody(done, base),
					timedOut: true,
					next: 'Call derive_media again with the same arguments to keep waiting.',
				});
			if (done.state !== 'succeeded')
				throw new ToolError(
					done.error?.code ?? `JOB_${done.state.toUpperCase()}`,
					done.error?.message ?? `The job ${done.state}`,
					HINTS[done.error?.code ?? ''],
					jobBody(done, base),
				);
			const res = done.result as DeriveResult;
			const reg = res.registered;
			const locators: MediaLocator[] = [
				{ type: 'engine-store', engineId: LOCAL_ENGINE_ID, key: reg.mediaKey },
			];
			for (const l of reg.locators) if (l.type === 'path') locators.push(l);
			const tx = await transact(
				ctx,
				projectId,
				{
					label: 'Derive Media',
					commands: [
						{
							type: 'media.derive',
							fromMediaId: mediaId,
							recipe: res.recipe,
							asset: {
								fingerprint: reg.fingerprint,
								originalName: reg.originalName,
								sizeBytes: reg.sizeBytes,
								container: reg.container,
								probe: reg.probe,
								locators,
								recipeVersion: res.recipeVersion,
								recipeHash: res.recipeHash,
							},
							...(res.range ? { range: res.range } : {}),
							...(replaceInClips?.length ? { replaceInClips } : {}),
							ref: '$derived',
						},
					],
				},
				extra,
			);
			const ok = requireOk(tx);
			const value = ok.results[0] as {
				mediaId?: string;
				itemId?: string;
				clipIds?: string[];
				deduped?: boolean;
			};
			return jsonResult({
				jobId: done.id,
				state: done.state,
				derivedMediaId: ok.refs.$derived ?? value?.mediaId,
				itemId: value?.itemId,
				fromMediaId: mediaId,
				op: res.recipe.op,
				name: reg.originalName,
				durationSec:
					reg.probe.durationFlicks === null
						? null
						: Math.round((reg.probe.durationFlicks / FLICKS_PER_SECOND) * 1000) / 1000,
				streams: reg.probe.streams.map((s) => s.type),
				reused: res.reused,
				...(res.range ? { sourceFrames: res.range } : {}),
				notes: res.notes,
				replacedClips: value?.clipIds ?? [],
				transaction: txBody(tx, ok),
			});
		},
	);
}
