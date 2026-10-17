// Masking-solver integration (spec 12 §2.4, P4-R2; wp-note "Phase 4 → WP4.1b"): what the solver needs about each sound
// effect from the document (its weight, repeat group, base gain and variation offset) and from the measurements (bed
// render, sound alone, speech), the solve, and the why-line of each result ("−3 dB, limited by dialogue A1"). Used by
// the rebalance job and the plan job. Pure apart from the measurements it is given.
//
// Base gain: a library sound's default insert level for its role at the delivery (`defaultSfxLevel`, Phase 2
// verification B) — the solver only raises it to reach the lift, so solving again gives the same gain (idempotent);
// a sound without library provenance starts from its current gain less its variation offset. The offset (`offsetDb` of
// its default or solver level: a fill's seeded ±1 dB) is the solver's user offset.
import type { SfxLevelConflict, SfxSolvedLevel } from '@jasper/api';
import {
	DEFAULT_TRUE_PEAK_CEILING_DB,
	SILENT_BED_LIFT_DB,
	type SolverEvent,
	type SolverEventResult,
	type SolverResult,
	solveSfxGains,
	TARGET_LIFT_DB,
} from '@jasper/audio-fx';
import {
	type AudioClip,
	DELIVERY_INTEGRATED_LUFS,
	DELIVERY_TRUE_PEAK_DBTP,
	defaultSfxLevel,
	type ProjectDocument,
	readClipSfx,
	readLibraryProvenance,
	type Sequence,
	type SfxRole,
	type SoundDelivery,
	sfxGainOwner,
	sfxSolverWeight,
} from '@jasper/project';
import type { MeasuredSound, Weight } from './bed.ts';

/** What the solver needs about a sound effect from the document. */
export type SfxInfo = {
	clipId: string;
	trackId: string;
	start: number;
	role: SfxRole | null;
	weight: Weight;
	/** Repeat group key: the library sound, else the media. */
	soundId: string;
	/** Library sound id, or null for other audio. */
	librarySoundId: string | null;
	title: string;
	type: string;
	owner: 'default' | 'solver' | 'user';
	gainDb: number;
	baseGainDb: number;
	userOffsetDb: number;
	/** The cue it fills (its layers are one designed sound: they do not mask each other), else its clip group. */
	cueKey: string | null;
};

const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** The solver's view of a sound effect clip of `seq` (null when it is not an audio clip). */
export function sfxInfoOf(
	doc: ProjectDocument,
	seq: Sequence,
	clipId: string,
	delivery: SoundDelivery,
): SfxInfo | null {
	const clip = seq.clips[clipId] as (AudioClip & { sfx?: unknown }) | undefined;
	if (clip?.kind !== 'audio') return null;
	const sfx = clip.sfx !== undefined ? readClipSfx(clip.sfx) : null;
	const media = doc.media?.[clip.mediaId] as { library?: unknown; originalName?: string } | undefined;
	const prov = readLibraryProvenance(media?.library);
	const types = prov?.types ?? [];
	const role = sfx?.role ?? null;
	const owner = sfxGainOwner({ gainDb: clip.gainDb, sfx: sfx ?? null });
	const level = sfx?.level;
	const userOffsetDb = owner !== 'user' && level && fin(level.offsetDb) ? level.offsetDb : 0;
	const gainDb = fin(clip.gainDb) ? clip.gainDb : 0;
	const d = prov?.descriptors as { maxMomentaryLufs?: number | null; truePeakDb?: number | null } | undefined;
	const baseGainDb =
		prov && d
			? defaultSfxLevel({
					role: role ?? 'support',
					types,
					maxMomentaryLufs: d.maxMomentaryLufs ?? null,
					truePeakDb: d.truePeakDb ?? null,
					delivery,
				}).gainDb
			: gainDb - userOffsetDb;
	const librarySoundId = sfx?.soundId ?? prov?.soundId ?? null;
	return {
		clipId,
		trackId: clip.trackId,
		start: clip.start,
		role,
		weight: sfxSolverWeight(role, types),
		soundId: librarySoundId ?? `media:${clip.mediaId}`,
		librarySoundId,
		title: (prov?.title || clip.name || media?.originalName || clipId).slice(0, 200),
		type: types[0] ?? 'sfx',
		owner,
		gainDb,
		baseGainDb,
		userOffsetDb,
		cueKey: sfx?.cueId ?? (typeof clip.groupId === 'string' && clip.groupId ? clip.groupId : null),
	};
}

export type LevelOptions = { delivery: SoundDelivery };

export function levelOptions(delivery: SoundDelivery) {
	return {
		programLufs: DELIVERY_INTEGRATED_LUFS[delivery] ?? -14,
		truePeakCeilingDb: DELIVERY_TRUE_PEAK_DBTP[delivery] ?? DEFAULT_TRUE_PEAK_CEILING_DB,
	};
}

/** The solver event of a measured sound effect. */
export function solverEventOf(info: SfxInfo, m: MeasuredSound): SolverEvent {
	return {
		clipId: info.clipId,
		soundId: info.soundId,
		type: info.type,
		weight: info.weight,
		startSec: m.window.start,
		endSec: m.window.end,
		soundBandsDb: m.soundBandsDb,
		soundPeakLu: m.soundPeakLu,
		truePeakDb: m.truePeakDb,
		bedBandsDb: m.bedBandsDb,
		bedLocalPeakLu: m.bedLocalPeakLu,
		speechOverlap: m.speechOverlap,
		baseGainDb: info.baseGainDb,
		userOffsetDb: info.userOffsetDb,
		...(info.cueKey ? { cueKey: `cue:${info.cueKey}` } : {}),
		...(m.energyProfile ? { energyProfile: m.energyProfile } : {}),
	};
}

const r2 = (x: number) => Math.round(x * 100) / 100;

/** "−3", "+1.5", "0" (one decimal, a true minus sign). */
export function fmtDb(x: number): string {
	const v = Math.round(x * 10) / 10;
	if (v === 0) return '0';
	const t = Math.abs(v).toFixed(1).replace(/\.0$/, '');
	return `${v < 0 ? '−' : '+'}${t}`;
}

const list = (xs: readonly string[]) => (xs.length ? xs.slice(0, 4).join(', ') : '');

/** The why-line of a solved gain, naming the dialogue and bed tracks ("−3 dB, limited by dialogue A1"). */
export function levelReason(r: SolverEventResult, m: MeasuredSound, ceilingDb: number): string {
	const head = `${fmtDb(r.gainDb)} dB`;
	const plain = r.limitedBy.filter((l) => !l.startsWith('conflict:'));
	const conflicts = r.limitedBy.filter((l) => l.startsWith('conflict:'));
	const parts: string[] = [];
	if (plain.includes('silent-sound')) parts.push('silent sound, default level kept');
	const names = plain
		.filter((l) => l !== 'silent-sound')
		.map((l) => {
			switch (l) {
				case 'dialogue':
					return m.speechTracks.length ? `dialogue ${list(m.speechTracks)}` : 'dialogue';
				case 'bed-cap':
					return m.bedTracks.length ? `the bed level (${list(m.bedTracks)})` : 'the bed level';
				case 'hero-shadow':
					return 'a hero within 0.15 s';
				case 'consistency':
					return 'its repeats (±2 dB)';
				case 'headroom':
					return `headroom (${fmtDb(ceilingDb)} dBTP)`;
				case 'overlap-headroom':
					return `the sounds overlapping it (summed true peak ${fmtDb(ceilingDb)} dBTP)`;
				case 'clamp':
					return 'the gain range (−30…+12 dB)';
				case 'user-offset':
					return 'its variation offset';
				default:
					return l;
			}
		});
	if (names.length) parts.push(`limited by ${names.join(', ')}`);
	for (const c of conflicts) {
		const [kept, lost] = c.slice('conflict:'.length).split('/');
		parts.push(`conflict: ${kept} kept over ${lost}`);
	}
	if (parts.length === 0 && r.achievedLiftDb !== null)
		parts.push(
			r.achievedLiftDb >= SILENT_BED_LIFT_DB
				? 'nothing plays under it in the bed: its default level is kept'
				: r.achievedLiftDb > r.targetLiftDb + 0.05
					? `its default level already clears the bed by ${fmtDb(r.achievedLiftDb)} dB`
					: `target lift ${fmtDb(r.targetLiftDb)} dB reached`,
		);
	// the bed it clears includes the lower sound effects playing under it
	const n = r.maskedBy?.length ?? 0;
	if (n > 0 && (r.sfxMaskingDb ?? 0) >= 0.05)
		parts.push(`over the bed and ${n} sound effect${n === 1 ? '' : 's'} under it (+${fmtDb(r.sfxMaskingDb!).replace('+', '')} dB)`);
	return (parts.length ? `${head}, ${parts.join('; ')}` : head).slice(0, 300);
}

/** The report entry of one solved sound. */
export function solvedLevel(r: SolverEventResult, m: MeasuredSound, ceilingDb: number): SfxSolvedLevel {
	return {
		gainDb: r.gainDb,
		targetLiftDb: r.targetLiftDb,
		achievedLiftDb: r.achievedLiftDb === null ? null : r2(r.achievedLiftDb),
		limitedBy: [...r.limitedBy],
		reason: levelReason(r, m, ceilingDb),
		dominantBandsHz: [...r.dominantBands],
		peakOverBedLu: r.peakOverBedLu === null ? null : r2(r.peakOverBedLu),
		truePeakDb: r.truePeakDb === null ? null : r2(r.truePeakDb),
		speech: m.speechOverlap,
		speechTracks: [...m.speechTracks],
		bedTracks: [...m.bedTracks],
		window: { start: Math.round(m.window.start * 1000) / 1000, end: Math.round(m.window.end * 1000) / 1000 },
		...(r.sfxMaskingDb !== null && r.sfxMaskingDb !== undefined ? { sfxMaskingDb: r2(r.sfxMaskingDb) } : {}),
		...(r.maskedBy?.length ? { maskedBy: r.maskedBy.slice(0, 32) } : {}),
		...(r.overlapTruePeakDb !== null && r.overlapTruePeakDb !== undefined
			? { overlapTruePeakDb: r2(r.overlapTruePeakDb) }
			: {}),
	};
}

/** Conflicts of a solved result (one per `conflict:<kept>/<lost>`). */
export function conflictsOf(r: SolverEventResult, itemId?: string): SfxLevelConflict[] {
	return r.limitedBy
		.filter((l) => l.startsWith('conflict:'))
		.map((l) => {
			const [kept, lost] = l.slice('conflict:'.length).split('/') as [string, string];
			return {
				clipId: r.clipId,
				...(itemId ? { itemId } : {}),
				kept,
				lost,
				message: `${lost} could not hold together with ${kept}: ${kept} (the earlier, safety constraint) was kept`,
			};
		});
}

/** `sfx.level` report of `soundDesign.applyGains` for a solved sound. */
export function gainReport(level: SfxSolvedLevel) {
	return {
		targetLiftDb: level.targetLiftDb,
		achievedLiftDb:
			level.achievedLiftDb === null ? null : Math.max(-400, Math.min(400, level.achievedLiftDb)),
		limitedBy: level.limitedBy.slice(0, 16).map((l) => l.slice(0, 64)),
		reason: level.reason.slice(0, 300),
	};
}

/** Solves `events` at the delivery; never throws (the solver sanitises its input). */
export function solveAt(events: SolverEvent[], delivery: SoundDelivery): SolverResult {
	return solveSfxGains(events, levelOptions(delivery));
}

export { TARGET_LIFT_DB };
