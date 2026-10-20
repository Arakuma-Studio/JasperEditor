// Sound credits and sound warnings of an export (spec 12 §2.11; wp-note sound-design "Phase 6 → WP6.4"):
//   - the credits of the library sounds the export's mixer PLAYS (its render snapshot: the range, nested sequences,
//     enabled clips on tracks that sound), written as `<output>.credits.<txt|md|csv>` next to the output;
//   - W_SOUND_CREDITS: a sound heard in the export asks for a credit (CC BY, CC BY-SA…) and no sidecar is written;
//   - W_SOUND_SHARE_ALIKE: a sound heard in the export is CC BY-SA, so the video must be shared under CC BY-SA or a
//     compatible licence (CC BY-SA 4.0 §1(a), §3(b); spec 12 §4 P6-E13);
//   - W_SOUND_CHECK_STALE (information): the sequence's stored Sound Check is out of date or failed.
// Header strings stay English (the sidecar is a deliverable for any audience, and the engine has no user locale);
// credit lines are the licences' verbatim attribution lines.
import type { ExportSettings, ExportWarningParams, RenderPlan } from '@jasper/api';
import {
	isShareAlike,
	licenseClass,
	type ProjectDocument,
	playedLibraryClips,
	type RenderSnapshot,
	requiresAttribution,
	SOUND_CREDITS_FILE,
	type SoundCredits,
	soundCheckStatus,
	soundCredits,
	soundCreditsFileText,
} from '@jasper/project';

export type CreditsFormat = 'txt' | 'md' | 'csv';
export const CREDITS_DIR = 'credits';

/** The credits of the sounds an export plays (all sounds, or only those needing a credit). Never throws. */
export function exportSoundCredits(
	doc: ProjectDocument,
	sequenceId: string,
	snapshot: Pick<RenderSnapshot, 'audioClips'>,
	scope: 'all' | 'attribution' = 'all',
): SoundCredits {
	return soundCredits(doc, sequenceId, {
		played: playedLibraryClips(snapshot),
		attributionOnly: scope === 'attribution',
	});
}

/** The file name of a credits sidecar for an output stem (`output` → `output.credits.md`). */
export function creditsFileName(stem: string, format: CreditsFormat): string {
	return `${stem}.credits.${SOUND_CREDITS_FILE[format].ext}`;
}

/** Names `/renders/:jobId/credits/:name` may serve. */
export const CREDITS_FILE_RE = /^output\.credits\.(txt|md|csv)$/;

/** The sidecar's bytes, or null when no library sound is heard (nothing to credit: no file). */
export function creditsFileBytes(c: SoundCredits, format: CreditsFormat): Uint8Array | null {
	const text = soundCreditsFileText(c, format);
	return text ? new TextEncoder().encode(text) : null;
}

/**
 * The plan's sound warnings: W_SOUND_CREDITS, W_SOUND_LICENSE_NC, W_SOUND_SHARE_ALIKE and W_SOUND_CHECK_STALE
 * (`level: 'info'`). None for exports without
 * sound (stills, picture-only previews, alpha masters).
 */
export function soundPlanWarnings(
	doc: ProjectDocument,
	sequenceId: string,
	snapshot: Pick<RenderSnapshot, 'audioClips'>,
	settings: Pick<ExportSettings, 'credits' | 'videoOnly' | 'video'>,
	opts: { still?: boolean } = {},
): RenderPlan['warnings'] {
	if (opts.still || settings.videoOnly || settings.video?.alpha) return [];
	const out: RenderPlan['warnings'] = [];
	try {
		const credits = exportSoundCredits(doc, sequenceId, snapshot);
		const need = credits.rows.filter((r) => requiresAttribution(r.license));
		// `params`: the values of each message, for editors that say it in their language (`ExportWarningParamsSchema`)
		const titlesOf = (rows: typeof credits.rows) =>
			rows
				.slice(0, 3)
				.map((r) => `"${r.title || r.soundId}"`)
				.join(', ');
		if (need.length && !settings.credits?.sidecar) {
			const licences = [...new Set(need.map((r) => r.license))].slice(0, 4).join(', ');
			const names = titlesOf(need);
			out.push({
				code: 'W_SOUND_CREDITS',
				message: `${need.length} ${need.length === 1 ? 'sound heard in this export needs' : 'sounds heard in this export need'} a credit (${licences}: ${names}${need.length > 3 ? '…' : ''}) and no credits file is written: choose a Credits format or credit ${need.length === 1 ? 'it' : 'them'} yourself`,
				itemIds: [...new Set(need.flatMap((r) => r.usedIn.map((id) => id.split('>')[0]!)))].slice(0, 64),
				params: { count: need.length, licences, titles: names, more: need.length > 3 },
			});
		}
		const nc = credits.rows.filter((r) => licenseClass(r.license) === 'nc');
		if (nc.length) {
			const licences = [...new Set(nc.map((r) => r.license))].join(', ');
			out.push({
				code: 'W_SOUND_LICENSE_NC',
				message: `${nc.length} ${nc.length === 1 ? 'sound heard in this export is' : 'sounds heard in this export are'} licensed for non-commercial use only (${licences})`,
				itemIds: [...new Set(nc.flatMap((r) => r.usedIn.map((id) => id.split('>')[0]!)))].slice(0, 64),
				params: { count: nc.length, licences },
			});
		}
		const sa = credits.rows.filter((r) => isShareAlike(r.license));
		if (sa.length) {
			const licences = [...new Set(sa.map((r) => r.license))].join(', ');
			const names = titlesOf(sa);
			out.push({
				code: 'W_SOUND_SHARE_ALIKE',
				message: `${sa.length} ${sa.length === 1 ? 'sound heard in this export is' : 'sounds heard in this export are'} ShareAlike (${licences}: ${names}${sa.length > 3 ? '…' : ''}): the video must be shared under CC BY-SA or a compatible licence`,
				itemIds: [...new Set(sa.flatMap((r) => r.usedIn.map((id) => id.split('>')[0]!)))].slice(0, 64),
				params: { count: sa.length, licences, titles: names, more: sa.length > 3 },
			});
		}
	} catch {
		// credits are metadata: a damaged provenance never blocks an export (the Sound Check reports it)
	}
	try {
		const st = soundCheckStatus(doc, sequenceId);
		if (st.state === 'stale') {
			const reason = st.reasons.includes('mix')
				? 'mix'
				: st.reasons.includes('preset')
					? 'preset'
					: 'settings';
			const why =
				reason === 'mix'
					? 'the mix changed'
					: reason === 'preset'
						? 'the delivery target changed'
						: 'cues, loudness or credits settings changed';
			out.push({
				code: 'W_SOUND_CHECK_STALE',
				level: 'info',
				message: `The last Sound Check of this sequence is out of date (${why} since): run it again to check what you deliver`,
				params: { state: 'stale', reason },
			});
		} else if (st.state === 'current' && st.summary?.verdict === 'fail') {
			const errors = (st.summary.counts as { error?: number } | undefined)?.error;
			const counted = typeof errors === 'number' && errors > 0;
			out.push({
				code: 'W_SOUND_CHECK_STALE',
				level: 'info',
				message: `The last Sound Check of this sequence failed${counted ? ` (${errors} ${errors === 1 ? 'error' : 'errors'})` : ''}: review its findings before delivering`,
				params: { state: 'failed', ...(counted ? { errors } : {}) },
			});
		}
	} catch {
		// a damaged summary is repaired on load; never block an export on it
	}
	return out;
}

/** The plan warnings an export job's result repeats (the sound ones: users read the job, not only the plan). */
export function resultSoundWarnings(
	plan: RenderPlan,
	creditsWritten: boolean,
): { code: string; message: string; level?: 'warning' | 'info'; params?: ExportWarningParams }[] {
	return plan.warnings
		.filter((w) => w.code.startsWith('W_SOUND_') && !(creditsWritten && w.code === 'W_SOUND_CREDITS'))
		.map((w) => ({
			code: w.code,
			message: w.message,
			...(w.level ? { level: w.level } : {}),
			...(w.params ? { params: w.params } : {}),
		}));
}
