// Reference sound profiles (spec 12 §4 P6-E8; wp-note "Phase 6 → WP-E4"): "make it sound like the films I like",
// measured and without models. A profile is the statistics of 1–20 reference media or sequences the user owns —
// loudness, the loudness arc, the ending, onset / hit density, sync to the picture with chance levels, the spectral
// balance, stereo width and speech share — kept in the engine's per-user library (numbers only, never audio). Sound
// Check compares a sequence with its profile ("Reference" rows, code REFERENCE: warnings and infos, never errors).
//   list_sound_profiles, get_sound_profile, build_sound_profile (a job), rename_sound_profile, delete_sound_profile
//   (the user approves: their data), export_sound_profile / import_sound_profile (a file to share),
//   set_sound_profile (the sequence's profile, one undo step); sound_check {profileId} compares with any profile.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import {
	type SoundCheckReference,
	SoundProfileBuildResultSchema,
	type SoundProfileJson,
	SoundProfileSchema,
	type SoundProfileSummary,
	SoundProfilesResponseSchema,
} from '@jasper/api';
import {
	REFERENCE_METRICS,
	REFERENCE_PROFILE_ID_RE,
	REFERENCE_PROFILE_LIMITS,
	type ReferenceMetricKey,
	referenceValueText,
	soundDesignSettingsOf,
} from '@jasper/project';
import { z } from 'zod';
import { ProjectIdArg, SequenceIdArg } from '../arguments.ts';
import {
	cancelIfAborted,
	DESTRUCTIVE,
	defineTool,
	EDIT,
	EDIT_IDEMPOTENT,
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
import { soundCall } from './sound.ts';

export const ProfileIdArg = z
	.string()
	.regex(REFERENCE_PROFILE_ID_RE, 'a profile id: sprf_ + 16 hex digits (list_sound_profiles)')
	.describe('Reference profile id (list_sound_profiles)');

/** Hints for the profile routes' error codes. */
const PROFILE_HINTS: Record<string, string> = {
	SOUND_PROFILE_NOT_FOUND: 'Unknown profile id: list_sound_profiles lists the library.',
	SOUND_PROFILE_INVALID:
		'Not a valid reference profile file (made by export_sound_profile or the editor’s Export…); nothing was imported.',
	SOUND_PROFILE_LIMIT: `The library holds ${REFERENCE_PROFILE_LIMITS.profiles} profiles at most: ask the user which to delete.`,
	PATHS_NOT_ALLOWED: 'This engine is not local: use project media (mediaIds) or sequences (sequenceIds).',
	MEDIA_NOT_FOUND: 'Unknown media id: list_media lists the project’s media.',
	SEQUENCE_NOT_FOUND: 'Unknown sequence id: get_project lists the sequences.',
	NO_REFERENCES:
		'None of the references could be measured (each reason is in the message): pick media with audio, at least 3 s long, and online.',
};

async function profileCall<T>(ctx: ToolContext, fn: Parameters<ToolContext['engine']>[0]): Promise<T> {
	try {
		return await soundCall<T>(ctx, fn);
	} catch (e) {
		const err = e as { code?: string; message?: string };
		if (err?.code && PROFILE_HINTS[err.code])
			throw new ToolError(err.code, err.message ?? err.code, PROFILE_HINTS[err.code]!);
		throw e;
	}
}

const summaryRow = (p: SoundProfileSummary) => ({
	profileId: p.id,
	name: p.name,
	references: p.n,
	titles: p.references.map(
		(r) => `${r.title} (${r.kind}, ${Math.round(r.durationSec)} s${r.hasPicture ? '' : ', no picture'})`,
	),
	createdAt: p.createdAt,
	...(p.warnings.length ? { warnings: p.warnings } : {}),
});

const v = (k: string, x: number | null | undefined) =>
	k in REFERENCE_METRICS ? referenceValueText(k as ReferenceMetricKey, x) : String(x ?? 'n.a.');

/** A profile as an agent reads it: one line per metric (median, typical band, min–max, n). */
export function profileTable(p: SoundProfileJson): string[] {
	return Object.entries(p.metrics)
		.filter(([, s]) => s.n > 0)
		.map(([k, s]) => {
			const spec = REFERENCE_METRICS[k as ReferenceMetricKey];
			const chance = (p.chance as Record<string, { median: number | null }>)[k];
			return `${spec?.label ?? k} (${k}): median ${v(k, s.median)}, typical ${v(k, s.p10)} … ${v(k, s.p90)}, all ${v(k, s.min)} … ${v(k, s.max)} (n ${s.n})${chance?.median !== undefined && chance.median !== null ? `; chance ${v(k, chance.median)}` : ''}`;
		});
}

/**
 * The Reference rows of a Sound Check as lines (the same rows, values and advice the editor's Sound Check panel shows
 * in its Reference group), plus the counts.
 */
export function referenceSection(ref: SoundCheckReference | undefined) {
	if (!ref) return undefined;
	const row = (r: SoundCheckReference['rows'][number]) => {
		const [lo, hi] = r.range;
		const win =
			lo !== null && hi !== null
				? `${v(r.metric, lo)} … ${v(r.metric, hi)}`
				: lo !== null
					? `≥ ${v(r.metric, lo)}`
					: hi !== null
						? `≤ ${v(r.metric, hi)}`
						: 'no reference data';
		const chance =
			r.chance !== undefined && r.chance !== null
				? `; chance ${v(r.metric, r.chance)}${r.refChance !== undefined && r.refChance !== null ? ` (references ${v(r.metric, r.refChance)})` : ''}`
				: '';
		const advice = r.advice?.length ? ` → ${r.advice.map((a) => a.text).join(' ')}` : '';
		return `${r.status === 'ok' ? 'ok' : r.status.toUpperCase()} ${r.label} (${r.metric}, ${r.weight}): ${v(r.metric, r.value)} — references ${win}, median ${v(r.metric, r.median)}${chance}${r.basis === 'delivery' ? ' (follows the delivery target: context only)' : ''}${advice}`;
	};
	return {
		profileId: ref.profileId,
		name: ref.name,
		references: ref.n,
		scoredAgainst: ref.scoredAgainst,
		...(ref.leaveOneOut
			? {
					leaveOneOut: `This sequence is reference ${ref.leaveOneOut.referenceId} ("${ref.leaveOneOut.title}") of the profile (by ${ref.leaveOneOut.by}): judged against the other ${ref.scoredAgainst}.`,
				}
			: {}),
		source: ref.source,
		counts: ref.counts,
		rows: ref.rows.map(row),
		arc: ref.arc,
		what: 'One row per metric: the sequence’s value against the references’ min–max widened by the metric’s measurement tolerance. major rows out of range are REFERENCE warnings, minor ones infos, info rows are shown only. They describe a style, not a defect: tell the user what differs and what to do, and change the mix only where they agree.',
	};
}

export function registerSoundProfileTools(ctx: ToolContext): void {
	defineTool(
		ctx,
		'list_sound_profiles',
		{
			title: 'List reference sound profiles',
			description:
				"The reference sound profiles of the engine's library (per user, shared by every project): each one's id, name, how many references it was measured from and their titles. A profile describes a style the user chose (their channel, a few films they like) as statistics — numbers only, never audio. With projectId, also which profile the sequence compares with in Sound Check (set_sound_profile). paths: whether this engine takes absolute file paths as references (a local engine).",
			input: { projectId: ProjectIdArg.optional(), sequenceId: SequenceIdArg },
			annotations: READ_ONLY,
		},
		async (a) => {
			const r = SoundProfilesResponseSchema.parse(await profileCall(ctx, (c) => c.listSoundProfiles()));
			let selected: string | null | undefined;
			if (a.projectId) {
				const { doc } = await loadDoc(ctx, a.projectId);
				selected = soundDesignSettingsOf(pickSequence(doc, a.sequenceId)).referenceProfile ?? null;
			}
			return jsonResult({
				profiles: r.profiles.map(summaryRow),
				...(selected !== undefined ? { selected } : {}),
				paths: r.paths,
				...(r.unreadable.length ? { unreadable: r.unreadable } : {}),
				next: r.profiles.length
					? 'sound_check {profileId} compares a sequence with one; set_sound_profile makes it the sequence’s.'
					: 'No profile yet: ask the user which of their own media or sequences describe the sound they want, then build_sound_profile. There is no bundled profile.',
			});
		},
	);

	defineTool(
		ctx,
		'get_sound_profile',
		{
			title: 'Get a reference sound profile',
			description:
				'One reference profile: per metric its median, typical band (p10–p90), min–max and n, with the chance levels of the sync shares; the loudness arc; each reference with its title, kind (media / sequence), duration and whether it had a picture. Numbers only.',
			input: { profileId: ProfileIdArg },
			annotations: READ_ONLY,
		},
		async (a) => {
			const p = SoundProfileSchema.parse(await profileCall(ctx, (c) => c.getSoundProfile(a.profileId)));
			return jsonResult({
				profileId: p.id,
				name: p.name,
				references: p.references.map((r) => ({
					id: r.id,
					title: r.title,
					kind: r.kind,
					durationSec: r.durationSec,
					hasPicture: r.hasPicture,
				})),
				metrics: profileTable(p),
				arc: p.arc,
				...(p.warnings.length ? { warnings: p.warnings } : {}),
			});
		},
	);

	defineTool(
		ctx,
		'build_sound_profile',
		{
			title: 'Build a reference sound profile',
			description:
				'Measure 1-20 references the user chose and store their statistics as a sound profile. Writes nothing to the project.',
			details: `Measures 1–${REFERENCE_PROFILE_LIMITS.references} references the USER chose and stores their statistics as a new profile in the engine's library (a sound-profile job; nothing is written to the project). References: media of the project (mediaIds: their audio, and their picture's cuts by the scene detector), sequences of the project (sequenceIds: their mix and their edit's cuts and transitions), or absolute file paths on a local engine (paths). Each is measured as a whole (at most ${REFERENCE_PROFILE_LIMITS.maxSec / 60} min): integrated loudness, true peak, loudness range, crest; the loudness arc, opening and closing level, time to first sound, longest silent gap; dead air at the end, fade length, the final moment and ring-out; onsets and salient hits per second, stop-downs; picture events per second and the share with an onset within 100 ms and within a frame, each with its chance level; the energy share of sub, low, low-mid, mid, presence and air; brightness; stereo width and correlation; speech share. References under ${REFERENCE_PROFILE_LIMITS.minSec} s, silent or without audio are skipped (listed with why). Use 5 or more references for ranges worth judging by (with fewer the result warns). Never pick references yourself: ask the user which media describe the sound they want. Waits for the job (timeoutSeconds, default 600).`,
			input: {
				name: z
					.string()
					.trim()
					.min(1)
					.max(REFERENCE_PROFILE_LIMITS.name)
					.describe('Profile name, e.g. "My channel"'),
				projectId: ProjectIdArg.optional().describe('Project of mediaIds / sequenceIds'),
				mediaIds: z.array(z.string().min(1)).max(REFERENCE_PROFILE_LIMITS.references).optional(),
				sequenceIds: z.array(z.string().min(1)).max(REFERENCE_PROFILE_LIMITS.references).optional(),
				paths: z
					.array(z.string().min(1))
					.max(REFERENCE_PROFILE_LIMITS.references)
					.optional()
					.describe('Absolute file paths on the engine’s computer (a local engine only)'),
				timeoutSeconds: z
					.number()
					.int()
					.min(1)
					.max(3600)
					.optional()
					.describe('Wait for the job (default 600)'),
			},
			annotations: EDIT,
		},
		async (a, extra) => {
			const n = (a.mediaIds?.length ?? 0) + (a.sequenceIds?.length ?? 0) + (a.paths?.length ?? 0);
			if (n < 1 || n > REFERENCE_PROFILE_LIMITS.references)
				throw new ToolError(
					'E_INVALID_PARAM',
					`Give 1–${REFERENCE_PROFILE_LIMITS.references} references (mediaIds, sequenceIds or paths)`,
					'Ask the user which of their media or sequences describe the sound they want.',
				);
			if ((a.mediaIds?.length || a.sequenceIds?.length) && !a.projectId)
				throw new ToolError(
					'E_INVALID_PARAM',
					'mediaIds and sequenceIds need projectId',
					'Pass the projectId.',
				);
			for (const p of a.paths ?? [])
				if (!isAbsolute(p))
					throw new ToolError(
						'E_INVALID_PARAM',
						`Paths must be absolute: ${p}`,
						'Pass full paths such as /home/me/film.mp4.',
					);
			const job = await profileCall<{ id: string }>(ctx, (c) =>
				c.buildSoundProfile({
					name: a.name,
					...(a.projectId ? { projectId: a.projectId } : {}),
					...(a.mediaIds?.length ? { mediaIds: a.mediaIds } : {}),
					...(a.sequenceIds?.length ? { sequenceIds: a.sequenceIds } : {}),
					...(a.paths?.length ? { paths: a.paths } : {}),
				}),
			);
			await cancelIfAborted(ctx, extra, job.id);
			const { job: done, timedOut } = await waitJob(ctx, job.id, (a.timeoutSeconds ?? 600) * 1000, extra);
			if (timedOut)
				return jsonResult({
					jobId: done.id,
					state: done.state,
					progress: done.progress,
					...(done.stage ? { stage: done.stage } : {}),
					next: `Still measuring: wait_for_job {jobId: "${done.id}"}, then list_sound_profiles.`,
				});
			if (done.state !== 'succeeded')
				throw new ToolError(
					done.error?.code ?? 'JOB_FAILED',
					done.error?.message ?? `The profile job ${done.state}`,
					PROFILE_HINTS[done.error?.code ?? ''] ?? 'Check the references (online, with audio) and try again.',
				);
			const r = SoundProfileBuildResultSchema.parse(done.result);
			return jsonResult({
				jobId: done.id,
				profile: summaryRow(r.profile),
				...(r.skipped.length ? { skipped: r.skipped.map((s) => `${s.title}: ${s.reason}`) } : {}),
				...(r.warnings.length ? { warnings: r.warnings } : {}),
				next: `sound_check {profileId: "${r.profile.id}"} compares a sequence with it; set_sound_profile makes it the sequence’s (the editor’s Sound Check then compares every run).`,
			});
		},
	);

	defineTool(
		ctx,
		'rename_sound_profile',
		{
			title: 'Rename a reference sound profile',
			description: 'Renames a profile of the library (its numbers do not change).',
			input: { profileId: ProfileIdArg, name: z.string().trim().min(1).max(REFERENCE_PROFILE_LIMITS.name) },
			annotations: EDIT_IDEMPOTENT,
		},
		async (a) => {
			const p = await profileCall<SoundProfileSummary>(ctx, (c) => c.renameSoundProfile(a.profileId, a.name));
			return jsonResult({ ok: true, profile: summaryRow(p) });
		},
	);

	defineTool(
		ctx,
		'delete_sound_profile',
		{
			title: 'Delete a reference sound profile',
			description:
				"Deletes a profile from the engine's library — the user's data, measured from their own media: needs the user's approval on a card in an open editor window (E_APPROVAL_DENIED: they said no or no window was open; do not retry without asking). Sequences that compare with it get a warning instead of Reference rows until another is chosen.",
			input: { profileId: ProfileIdArg },
			annotations: DESTRUCTIVE,
		},
		async (a) => {
			const r = await profileCall<{ deleted: true; id: string }>(ctx, (c) =>
				c.deleteSoundProfile(a.profileId),
			);
			return jsonResult({ ok: true, ...r });
		},
	);

	defineTool(
		ctx,
		'export_sound_profile',
		{
			title: 'Export a reference sound profile',
			description:
				'Writes a profile to a JSON file the user can share (numbers, titles and fingerprints only; never audio or paths). The same file the editor’s Export… saves; import_sound_profile reads it back. An existing file is not replaced unless overwrite: true.',
			input: {
				profileId: ProfileIdArg,
				path: z.string().min(1).describe('Absolute path of the .json file to write'),
				overwrite: z.boolean().optional(),
			},
			annotations: EDIT,
		},
		async (a) => {
			if (!isAbsolute(a.path))
				throw new ToolError(
					'E_INVALID_PARAM',
					'Paths must be absolute',
					'Pass a full path such as /tmp/profile.json.',
				);
			const p = SoundProfileSchema.parse(await profileCall(ctx, (c) => c.getSoundProfile(a.profileId)));
			await mkdir(dirname(a.path), { recursive: true });
			await writeFile(a.path, `${JSON.stringify(p, null, 2)}\n`, { flag: a.overwrite ? 'w' : 'wx' }).catch(
				(e: NodeJS.ErrnoException) => {
					throw new ToolError(
						e.code === 'EEXIST' ? 'E_EXISTS' : 'E_IO',
						e.code === 'EEXIST' ? `${a.path} exists` : `Cannot write ${a.path}: ${e.message}`,
						e.code === 'EEXIST'
							? 'Pass overwrite: true to replace it, or another path.'
							: 'Check the folder.',
					);
				},
			);
			return jsonResult({ ok: true, path: a.path, profileId: p.id, name: p.name, references: p.n });
		},
	);

	defineTool(
		ctx,
		'import_sound_profile',
		{
			title: 'Import a reference sound profile',
			description: `Adds a shared profile file (export_sound_profile, the editor's Export…) to the library under a new id. The file is validated strictly (at most ${REFERENCE_PROFILE_LIMITS.references} references, numbers only, ${Math.round(REFERENCE_PROFILE_LIMITS.fileBytes / 1000)} kB at most) and its statistics are recomputed from its references; anything else is refused (SOUND_PROFILE_INVALID) and nothing is added. Give path (a file on this computer) or profile (the parsed JSON).`,
			input: {
				path: z.string().min(1).optional(),
				profile: z.record(z.string(), z.unknown()).optional(),
				name: z.string().trim().min(1).max(REFERENCE_PROFILE_LIMITS.name).optional().describe('Another name'),
			},
			annotations: EDIT,
		},
		async (a) => {
			let profile: unknown = a.profile;
			if (a.path !== undefined) {
				if (!isAbsolute(a.path))
					throw new ToolError(
						'E_INVALID_PARAM',
						'Paths must be absolute',
						'Pass a full path such as /tmp/profile.json.',
					);
				const bytes = await readFile(a.path).catch((e: Error) => {
					throw new ToolError('E_NOT_FOUND', `Cannot read ${a.path}: ${e.message}`);
				});
				if (bytes.length > REFERENCE_PROFILE_LIMITS.fileBytes)
					throw new ToolError(
						'E_LIMIT',
						`The file is larger than ${REFERENCE_PROFILE_LIMITS.fileBytes} bytes`,
					);
				try {
					profile = JSON.parse(bytes.toString('utf8'));
				} catch {
					throw new ToolError(
						'SOUND_PROFILE_INVALID',
						`${a.path} is not JSON`,
						PROFILE_HINTS.SOUND_PROFILE_INVALID,
					);
				}
			}
			if (profile === undefined)
				throw new ToolError('E_INVALID_PARAM', 'Give path or profile', 'path: the exported .json file.');
			const p = await profileCall<SoundProfileSummary>(ctx, (c) =>
				c.importSoundProfile({ profile, ...(a.name ? { name: a.name } : {}) }),
			);
			return jsonResult({ ok: true, profile: summaryRow(p) });
		},
	);

	defineTool(
		ctx,
		'set_sound_profile',
		{
			title: 'Compare a sequence with a reference profile',
			description:
				"Sets which reference profile the sequence's Sound Check compares with (soundDesign.setSettings {referenceProfile}; one undo step), or null for none. Every later sound_check (and the editor's Run) then adds the Reference rows. The profile must be in the library (list_sound_profiles).",
			input: {
				projectId: ProjectIdArg,
				sequenceId: SequenceIdArg,
				profileId: ProfileIdArg.nullable().describe('Profile id, or null to stop comparing'),
			},
			annotations: EDIT_IDEMPOTENT,
		},
		async (a, extra) => {
			const { doc } = await loadDoc(ctx, a.projectId);
			const seq = pickSequence(doc, a.sequenceId);
			let name: string | null = null;
			if (a.profileId) {
				const p = SoundProfileSchema.parse(await profileCall(ctx, (c) => c.getSoundProfile(a.profileId!)));
				name = p.name;
			}
			const res = await transact(
				ctx,
				a.projectId,
				{
					label: a.profileId ? 'Compare with Reference Profile' : 'Stop Comparing with a Reference Profile',
					sequenceId: seq.id,
					commands: [{ type: 'soundDesign.setSettings', sequenceId: seq.id, referenceProfile: a.profileId }],
				},
				extra,
			);
			return jsonResult({
				...txBody(res, requireOk(res)),
				sequenceId: seq.id,
				referenceProfile: a.profileId,
				...(name ? { name } : {}),
				next: a.profileId
					? 'Run sound_check: its result has reference.rows.'
					: 'Sound Check no longer compares.',
			});
		},
	);
}
