// The mixing side of sound design for the UI (spec 12 §2.4 / §2.7, P4-R4 / P4-R5; wp-note "Phase 4 → WP4.2b"). Pure:
// - a placed sound's level as Essential Sound shows it: the gain, who owns it (placement's default, the masking solver,
//   or the user — Auto gain off) and why it is what it is ("−3.0 dB · limited by dialogue A1"), translated from the
//   solver's `limitedBy` codes (the stored English reason only supplies the track names);
// - the room glue seen from one clip's track (the "SFX Room" bus, the track's send, or why it cannot send);
// - a cue's stop-before / build as the Cue Seam draws them: written into the mix (`soundDesign.mix.cues`) or only stored
//   on the cue, and why a stored one is not written;
// - validation of the Properties "Cue" stop-before / build fields;
// - the delivery presets for a select (with their numbers).
import { SILENT_BED_LIFT_DB } from '@jasper/audio-fx';
import {
	type AudioClip,
	type Clip,
	type ClipSfx,
	type Command,
	cueMixWritten,
	DELIVERY_PRESETS,
	DELIVERY_RELATIVE_LU,
	type DeliveryPreset,
	musicTracksUnder,
	type ProjectDocument,
	type Rational,
	ROOM_BUS_NAME,
	ROOM_GLUE_DEFAULT,
	type RoomGlue,
	readSoundDesignMix,
	readSoundDesignSettings,
	roomSendPlan,
	type Sequence,
	type SfxLevel,
	type SoundCue,
	type SoundDelivery,
	sfxGainOwner,
	type Track,
	type TrackSend,
} from '@jasper/project';
import { t } from '../i18n/runtime.ts';
import { clipSoundTitle, cueOfClip, seqTimecode, sfxOf, trackLabelOf } from './design-model.ts';

const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** "−3.0", "+1.5", "0.0" (one decimal, a real minus sign). */
export function fmtDb(db: number): string {
	if (!fin(db)) return '–';
	const v = Math.round(db * 10) / 10;
	if (v === 0) return '0.0';
	return `${v < 0 ? '−' : '+'}${Math.abs(v).toFixed(1)}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Levels

export type GainOwner = 'default' | 'solver' | 'user';

export type SfxLevelView = {
	/** Who owns the gain now (`sfxGainOwner`). */
	owner: GainOwner;
	/** Auto gain on: the default level or the solver sets it. */
	auto: boolean;
	/** Auto gain was turned off on purpose (the record is kept, `manual`). */
	manual: boolean;
	/** The clip's gain (dB). */
	gainDb: number;
	/** "Default", "Solver", "Manual". */
	badge: string;
	/** Why: "limited by dialogue A1", "target lift +5.0 dB reached", "set by you". */
	reason: string;
	/** "−3.0 dB · limited by dialogue A1". */
	text: string;
	targetLiftDb: number | null;
	achievedLiftDb: number | null;
};

/** The track names a solver reason gives for a limit ("dialogue A1, A2", "the bed level (A1)"). */
function tracksIn(reason: string | undefined, what: 'dialogue' | 'bed'): string | null {
	if (!reason) return null;
	const m =
		what === 'dialogue'
			? /dialogue ((?:[AV]\d+(?:, (?=[AV]\d))?)+)/.exec(reason)
			: /the bed level \(([^)]{1,80})\)/.exec(reason);
	return m?.[1] ?? null;
}

/** One `limitedBy` code in words (the masking solver's constraints, WP4.1a). */
export function limitPhrase(code: string, reason?: string): string {
	if (code.startsWith('conflict:')) {
		const [kept, lost] = code.slice('conflict:'.length).split('/');
		return t('conflict: {0} kept over {1}', limitPhrase(kept ?? '?'), limitPhrase(lost ?? '?'));
	}
	switch (code) {
		case 'dialogue': {
			const tr = tracksIn(reason, 'dialogue');
			return tr ? t('dialogue {0}', tr) : t('dialogue');
		}
		case 'bed-cap': {
			const tr = tracksIn(reason, 'bed');
			return tr ? t('the bed level ({0})', tr) : t('the bed level');
		}
		case 'hero-shadow':
			return t('a hero within 0.15 s');
		case 'consistency':
			return t('its repeats (±2 dB)');
		case 'headroom':
			return t('headroom');
		case 'overlap-headroom':
			return t('the sounds overlapping it (summed true peak)');
		case 'clamp':
			return t('the gain range (−30…+12 dB)');
		case 'user-offset':
			return t('its variation offset');
		case 'silent-sound':
			return t('silent sound');
		default:
			return code;
	}
}

/** The why of a solver level from its codes and lifts (translated), e.g. "limited by dialogue A1". */
export function solverReason(level: {
	limitedBy?: readonly string[];
	targetLiftDb?: number | null;
	achievedLiftDb?: number | null;
	reason?: string;
}): string {
	const codes = [...new Set(level.limitedBy ?? [])];
	const plain = codes.filter((c) => !c.startsWith('conflict:'));
	const conflicts = codes.filter((c) => c.startsWith('conflict:'));
	const parts: string[] = [];
	if (plain.includes('silent-sound')) parts.push(t('silent sound, default level kept'));
	const names = plain.filter((c) => c !== 'silent-sound').map((c) => limitPhrase(c, level.reason));
	if (names.length) parts.push(t('limited by {0}', names.join(', ')));
	for (const c of conflicts) parts.push(limitPhrase(c));
	if (parts.length === 0 && fin(level.achievedLiftDb) && fin(level.targetLiftDb))
		parts.push(
			level.achievedLiftDb >= SILENT_BED_LIFT_DB
				? t('nothing plays under it in the bed: default level kept')
				: level.achievedLiftDb > level.targetLiftDb + 0.05
					? t('clears the bed by {0} dB', fmtDb(level.achievedLiftDb))
					: t('target lift {0} dB reached', fmtDb(level.targetLiftDb)),
		);
	return parts.join('; ');
}

function defaultReason(limit: string): string {
	switch (limit) {
		case 'loudness':
			return t('default level: its loudness target');
		case 'peak':
			return t('default level: its true-peak ceiling');
		case 'range':
			return t('default level: the gain range');
		case 'unmeasured':
			return t('default level: no loudness measured');
		default:
			return t('default level');
	}
}

/** A placed sound's level as Essential Sound shows it. Never throws. */
export function sfxLevelView(clip: Clip): SfxLevelView | null {
	if (clip.kind !== 'audio') return null;
	const sfx = sfxOf(clip) as (ClipSfx & { level?: SfxLevel & { manual?: boolean } }) | null;
	const gainDb = fin((clip as AudioClip).gainDb) ? (clip as AudioClip).gainDb : 0;
	const level = sfx?.level;
	const owner = sfxGainOwner({ gainDb, sfx: sfx ?? null });
	const manual = level?.manual === true;
	let reason: string;
	let badge: string;
	if (owner === 'solver' && level?.by === 'solver') {
		badge = t('Solver');
		reason = solverReason(level);
	} else if (owner === 'default' && level?.by === 'default') {
		badge = t('Default');
		reason = defaultReason(level.limitedBy);
	} else {
		badge = t('Manual');
		reason =
			manual && level
				? level.by === 'solver'
					? t('Auto gain off (last solve: {0} dB)', fmtDb(level.gainDb))
					: t('Auto gain off (default: {0} dB)', fmtDb(level.gainDb))
				: t('set by you');
	}
	const solver = level?.by === 'solver' ? level : null;
	return {
		owner,
		auto: owner !== 'user',
		manual,
		gainDb,
		badge,
		reason,
		text: reason ? `${fmtDb(gainDb)} dB · ${reason}` : `${fmtDb(gainDb)} dB`,
		targetLiftDb: solver && fin(solver.targetLiftDb) ? solver.targetLiftDb : null,
		achievedLiftDb: solver && fin(solver.achievedLiftDb) ? solver.achievedLiftDb : null,
	};
}

/**
 * The gain a review row shows with its limit ("−16.2 dB · limited by dialogue A2"), from a plan item's `meta.level` or a
 * rebalance item's meta (`gainDb`, `limitedBy`); `db` (the drawn ghost's gain) when the meta has none. `alternative`: the
 * chosen set is an alternative (its own level is not in the item's meta: the ghost's gain alone is shown).
 */
export function reviewGainText(db: number | null, meta: unknown, alternative = false): string {
	const m = !alternative && meta && typeof meta === 'object' ? (meta as Record<string, unknown>) : null;
	const lv = m ? ((m.level && typeof m.level === 'object' ? m.level : m) as Record<string, unknown>) : null;
	// the item's own solved gain (its first layer) wins over the drawn ghost's: an item that requires a setup item
	// (the delivery preset) also changes the music's gain in its preview
	const own = lv && fin(lv.gainDb) ? lv.gainDb : null;
	const g = own ?? db;
	if (g === null || !fin(g)) return '';
	const head = `${fmtDb(g)} dB`;
	if (!lv) return head;
	const limitedBy = Array.isArray(lv.limitedBy)
		? lv.limitedBy.filter((x): x is string => typeof x === 'string').slice(0, 16)
		: [];
	if (!limitedBy.length) return head;
	const why = solverReason({ limitedBy, reason: typeof lv.reason === 'string' ? lv.reason : undefined });
	return why ? `${head} · ${why}` : head;
}

// ---------------------------------------------------------------------------------------------------------------
// Room glue

export type RoomView = {
	/** The glue `soundDesign.ensureBus` recorded (null: none). */
	glue: RoomGlue | null;
	/** The room bus (recorded, `settings.roomBus`, or a submix named "SFX Room"). */
	bus: Track | null;
	trackId: string;
	/** "A3". */
	trackLabel: string;
	/** The track's send to the bus. */
	send: TrackSend | null;
	/** The send level when it is static (null: automated in the mixer). */
	levelDb: number | null;
	/** Why the track cannot get a send here (interface sounds only, bed audio on the track, locked), or null. */
	blocked: string | null;
};

/** The room bus of a sequence (the recorded one, `settings.roomBus`, or a submix named "SFX Room"). */
export function roomBusOf(seq: Sequence): Track | null {
	const subs = seq.submixTracks ?? [];
	const glue = readSoundDesignMix(seq.soundDesign?.mix)?.room;
	const settings = readSoundDesignSettings(seq.soundDesign?.settings);
	return (
		(glue ? subs.find((s) => s.id === glue.busId) : undefined) ??
		(settings.roomBus ? subs.find((s) => s.id === settings.roomBus) : undefined) ??
		subs.find((s) => s.name === ROOM_BUS_NAME) ??
		null
	);
}

/** The room glue seen from a clip's track (Essential Sound ▸ Room send). Null for clips not on an audio track. */
export function roomViewOf(doc: Pick<ProjectDocument, 'media'>, seq: Sequence, clip: Clip): RoomView | null {
	return roomViewOfTrack(doc, seq, clip.trackId);
}

/** The room glue seen from an audio track. Null when it is not one of the sequence's audio tracks. */
export function roomViewOfTrack(
	doc: Pick<ProjectDocument, 'media'>,
	seq: Sequence,
	trackId: string,
): RoomView | null {
	const track = seq.audioTracks.find((x) => x.id === trackId);
	if (!track) return null;
	const glue = readSoundDesignMix(seq.soundDesign?.mix)?.room ?? null;
	const bus = roomBusOf(seq);
	const send = bus ? ((track.mixer?.sends ?? []).find((s) => s.target === bus.id) ?? null) : null;
	const levelDb = send && send.levelDb.keyframes.length === 0 ? send.levelDb.value : null;
	let blocked: string | null = null;
	const label = trackLabelOf(seq, track.id);
	if (!send) {
		const d = roomSendPlan(doc, seq, [track.id])[0];
		const sfx = roomSendPlan(doc, seq).find((x) => x.trackId === track.id);
		if (d && !d.send) blocked = t('{0} plays only interface sounds (UI, clicks, keys): they stay dry', label);
		// a track the glue does not consider holds no sound effect: the selected clip on it is bed audio (library music)
		else if (!sfx?.send)
			blocked = t(
				'{0} also plays dialogue, music or other bed audio: a send would put them in the room too',
				label,
			);
		else if (track.locked) blocked = t('{0} is locked', label);
	}
	return { glue, bus, trackId: track.id, trackLabel: label, send, levelDb, blocked };
}

/**
 * The room as Essential Sound shows it for a selection (sends are per track): every track of the selected clips, the
 * ones a gesture acts on (they send, or can get a send), the ones that cannot send (listed with why, skipped), the
 * toggle's state over the targets (mixed when their sends differ) and the slider's level (null when the levels differ).
 */
export type RoomSelection = {
	glue: RoomGlue | null;
	bus: Track | null;
	/** Every audio track of the selected clips, in track order. */
	tracks: RoomView[];
	/** The tracks a toggle or slider gesture acts on: they send to the room, or can get a send. */
	targets: RoomView[];
	/** Tracks without a send that cannot get one (`blocked` says why): every gesture skips them. */
	blocked: RoomView[];
	/** Targets whose send is on (present, not muted). */
	on: RoomView[];
	/** Over the targets: all on, none (also when there are no targets), or mixed. */
	state: boolean | 'mixed';
	/** The distinct static levels of the sends that are on, ascending (more than one: mixed). */
	levels: number[];
	/** The common level of the sends that are on; null when they differ or none is on. */
	levelDb: number | null;
	/** Sends that are on with an automated level (the slider leaves them alone). */
	automated: RoomView[];
	/** "A3, A4": the targets' tracks (every track's when none can send). */
	label: string;
};

/** The room seen from the selected clips' tracks. Null when none of them is on an audio track. Never throws. */
export function roomSelectionOf(
	doc: Pick<ProjectDocument, 'media'>,
	seq: Sequence,
	clips: readonly Clip[],
): RoomSelection | null {
	const ids = new Set(clips.map((c) => c.trackId));
	const tracks = seq.audioTracks
		.filter((x) => ids.has(x.id))
		.map((x) => roomViewOfTrack(doc, seq, x.id))
		.filter((v): v is RoomView => !!v);
	const first = tracks[0];
	if (!first) return null;
	const targets = tracks.filter((v) => !!v.send || !v.blocked);
	const blocked = tracks.filter((v) => !v.send && !!v.blocked);
	const on = targets.filter((v) => !!v.send && !v.send.mute);
	const state: boolean | 'mixed' = on.length === 0 ? false : on.length === targets.length ? true : 'mixed';
	const levels = [...new Set(on.map((v) => v.levelDb).filter(fin))].sort((a, b) => a - b);
	return {
		glue: first.glue,
		bus: first.bus,
		tracks,
		targets,
		blocked,
		on,
		state,
		levels,
		levelDb: levels.length === 1 ? (levels[0] ?? null) : null,
		automated: on.filter((v) => v.levelDb === null),
		label: (targets.length ? targets : tracks).map((v) => v.trackLabel).join(', '),
	};
}

const sendPatch = (seq: Sequence, v: RoomView, patch: { mute?: boolean; levelDb?: number }): Command =>
	({
		type: 'mixer.updateSend',
		sequenceId: seq.id,
		stripId: v.trackId,
		sendId: v.send?.id ?? '',
		patch,
	}) as Command;

/**
 * The ONE edit a Room toggle gesture makes on a selection (null: nothing to change). Off mutes every target's send (a
 * re-run of the glue keeps it muted). On: without a room bus the glue is created (`soundDesign.ensureBus`: the bus, its
 * reverb and the sends of every track that qualifies — the targets are those tracks); with one, each target's muted send
 * is unmuted and a target without a send gets one at the glue's level. Blocked tracks are never touched.
 */
export function roomToggleEdit(
	seq: Sequence,
	sel: RoomSelection,
	on: boolean,
): { label: string; commands: Command[] } | null {
	if (!on) {
		const commands = sel.on.map((v) => sendPatch(seq, v, { mute: true }));
		return commands.length ? { label: t('Room Send Off'), commands } : null;
	}
	const off = sel.targets.filter((v) => !v.send || v.send.mute);
	if (!off.length) return null;
	if (!sel.bus)
		return {
			label: t('SFX Room Glue'),
			commands: [{ type: 'soundDesign.ensureBus', sequenceId: seq.id } as Command],
		};
	const bus = sel.bus;
	return {
		label: t('Room Send On'),
		commands: off.map((v) =>
			v.send
				? sendPatch(seq, v, { mute: false })
				: ({
						type: 'mixer.addSend',
						sequenceId: seq.id,
						stripId: v.trackId,
						target: bus.id,
						levelDb: sel.glue?.sendDb ?? ROOM_GLUE_DEFAULT.sendDb,
					} as Command),
		),
	};
}

/** The slider's commands: every send that is on with a static level gets `db` (automated levels are left alone). */
export function roomLevelCommands(seq: Sequence, sel: RoomSelection, db: number): Command[] {
	if (!fin(db)) return [];
	return sel.on.filter((v) => v.levelDb !== null).map((v) => sendPatch(seq, v, { levelDb: db }));
}

// ---------------------------------------------------------------------------------------------------------------
// Selections: Auto gain level and the cue the sounds fill

export type LevelSelection = {
	views: SfxLevelView[];
	/** The badge of every view, or "Mixed" when their owners differ. */
	badge: string;
	owner: GainOwner | 'mixed';
	/** The one view's text; for several: the common text, or the range of their gains. */
	text: string;
	/** The lift line when every view has the same one. */
	lift: { achievedDb: number; targetDb: number } | null;
};

/** The Auto gain level line of a selection of placed sounds (null: no placed sound). Never throws. */
export function levelSelectionOf(clips: readonly Clip[]): LevelSelection | null {
	const views = clips.map((c) => sfxLevelView(c)).filter((v): v is SfxLevelView => !!v);
	const v0 = views[0];
	if (!v0) return null;
	const same = <T>(f: (v: SfxLevelView) => T) => views.every((v) => f(v) === f(v0));
	const owner = same((v) => v.owner) ? v0.owner : 'mixed';
	const gains = views.map((v) => v.gainDb);
	const lo = Math.min(...gains);
	const hi = Math.max(...gains);
	const text = same((v) => v.text)
		? v0.text
		: Math.abs(hi - lo) < 0.05
			? t('{0} dB · {1} sounds, different reasons', fmtDb(lo), views.length)
			: t('{0} to {1} dB across {2} sounds', fmtDb(lo), fmtDb(hi), views.length);
	const lift =
		v0.achievedLiftDb !== null &&
		v0.targetLiftDb !== null &&
		same((v) => v.achievedLiftDb) &&
		same((v) => v.targetLiftDb)
			? { achievedDb: v0.achievedLiftDb, targetDb: v0.targetLiftDb }
			: null;
	return { views, badge: owner === 'mixed' ? t('Mixed') : v0.badge, owner, text, lift };
}

/**
 * The cue Stop / Build act on for a selection: the one cue every selected sound fills; none when no sound fills a
 * cue; mixed (the editors are disabled with the reason; the state is shown over the cues) when the sounds fill
 * different cues or only some of them fill one — a stop-before and a build are a cue's, with their own length and depth.
 */
export type CueSelection =
	| { kind: 'one'; cue: SoundCue }
	| { kind: 'none' }
	| {
			kind: 'mixed';
			cues: SoundCue[];
			/** Selected sounds that fill no cue. */
			noCue: number;
			reason: string;
			state: Record<CueMixKind, boolean | 'mixed'>;
	  };

export function cueSelectionOf(seq: Sequence, clips: readonly Clip[]): CueSelection {
	const cues = new Map<string, SoundCue>();
	let noCue = 0;
	for (const c of clips) {
		const cue = cueOfClip(seq, c);
		if (cue) cues.set(cue.id, cue);
		else noCue++;
	}
	const list = [...cues.values()].sort((a, b) => a.frame - b.frame);
	const only = list[0];
	if (!only) return { kind: 'none' };
	if (list.length === 1 && noCue === 0) return { kind: 'one', cue: only };
	const tcs = list.slice(0, 4).map((c) => seqTimecode(seq, c.frame));
	if (list.length > 4) tcs.push('…');
	const reason =
		list.length > 1
			? t(
					'The selected sounds fill {0} different cues ({1}): select the sounds of one cue to edit its stop-before and build',
					list.length,
					tcs.join(', '),
				)
			: t(
					'{0} of the selected sounds fill no cue: select only the sounds of the cue at {1} to edit its stop-before and build',
					noCue,
					tcs[0] ?? '',
				);
	const stateOf = (kind: CueMixKind): boolean | 'mixed' => {
		const n = list.filter((c) => !!c[kind]).length;
		return n === 0 ? false : n === list.length ? true : 'mixed';
	};
	return {
		kind: 'mixed',
		cues: list,
		noCue,
		reason,
		state: { stopBefore: stateOf('stopBefore'), build: stateOf('build') },
	};
}

// ---------------------------------------------------------------------------------------------------------------
// Solver and job notes: conflicts and warnings in the UI language

/** A conflict or a warning of a mixing job's report, in words. */
export type SoundNote = {
	kind: 'conflict' | 'warning';
	/** `warning`: something to act on (advice in the text); `info`: what happened. */
	severity: 'warning' | 'info';
	code: string;
	text: string;
	clipId?: string;
};

/** Names a clip ("Click at 00:00:04:10") from a report's clip id (and a plan's item id); null when unknown. */
export type NoteWhere = (clipId: string | undefined, itemId?: string) => string | null;

type ConflictLike = { clipId: string; itemId?: string; kept: string; lost: string; message?: string };
type WarningLike = { code: string; message: string; clipId?: string };

const str = (v: unknown, max = 2000): v is string => typeof v === 'string' && v.length <= max;

/** A conflict as a report carries it (`{clipId, kept, lost, message}`), checked field by field. */
export function isConflictLike(v: unknown): v is ConflictLike {
	if (!v || typeof v !== 'object') return false;
	const o = v as Record<string, unknown>;
	return (
		str(o.clipId, 256) &&
		str(o.kept, 64) &&
		str(o.lost, 64) &&
		(o.itemId === undefined || str(o.itemId, 256)) &&
		(o.message === undefined || str(o.message))
	);
}

/** A warning as a report carries it (`{code, message, clipId?}`), checked field by field. */
export function isWarningLike(v: unknown): v is WarningLike {
	if (!v || typeof v !== 'object') return false;
	const o = v as Record<string, unknown>;
	return str(o.code, 64) && str(o.message) && (o.clipId === undefined || str(o.clipId, 256));
}

/** Solver and job warnings that ask for an action (the others say what happened). */
const ACTION_WARNINGS = new Set([
	'W_UNRESOLVED',
	'W_DIALOGUE_BAND',
	'W_MUSIC_OVER_VOICE',
	'W_AMBIENCE_OVER_VOICE',
	'W_NO_DUCK_TRIGGERS',
	'W_SILENT_MIX',
	'W_LIBRARY_EMPTY',
	'W_LEVELS_UNMEASURED',
	'W_LEVEL_UNMEASURED',
	'W_DELIVERY_UNMEASURED',
]);

/** "Click at 00:00:04:10: its repeats (±2 dB) kept over dialogue". */
export function conflictNote(c: ConflictLike, where: string | null): SoundNote {
	const kept = limitPhrase(c.kept);
	const lost = limitPhrase(c.lost);
	return {
		kind: 'conflict',
		severity: 'info',
		code: `conflict:${c.kept}/${c.lost}`,
		text: where
			? t('{0}: {1} kept over {2}', where, kept, lost)
			: t('A sound: {0} kept over {1}', kept, lost),
		clipId: c.clipId,
	};
}

/** "<itemId> (alternative k): …": a plan's warning about an item's k-th alternative. */
const ALTERNATIVE_PREFIX = /^([A-Za-z0-9_$#:.-]{1,128}) \(alternative (\d{1,3})\): /;

/** The id a solver message starts with ("clp_12: …"), when it has one. */
const idPrefix = (message: string): string | null =>
	/^([A-Za-z0-9_$#:.-]{1,128}): /.exec(message)?.[1] ?? null;

/** A warning in the UI language (the engine writes English; the text is rebuilt from the code and its numbers). */
export function warningNote(w: WarningLike, where: string | null): SoundNote {
	const who = where ?? t('A sound');
	const m = w.message;
	const num = (re: RegExp) => {
		const x = re.exec(m)?.[1];
		const n = x === undefined ? Number.NaN : Number(x.replace('−', '-'));
		return Number.isFinite(n) ? n : null;
	};
	let text: string;
	switch (w.code) {
		case 'W_DIALOGUE_BAND': {
			const types = /\(here: ([^)]{1,200})\)/.exec(m)?.[1];
			text = t(
				'{0}: its energy is in the speech band (1–4 kHz) while someone speaks; move it or pick a sound whose energy is outside 1–4 kHz, e.g. {1}',
				who,
				types?.trim() || 'boom',
			);
			break;
		}
		case 'W_UNRESOLVED': {
			const c = /: ([a-z-]{1,32}) does not hold/.exec(m)?.[1];
			text = t(
				'{0}: {1} does not hold after the solve and no conflict explains it; check its level by ear and report it',
				who,
				c ? limitPhrase(c) : t('a constraint'),
			);
			break;
		}
		case 'W_SILENT_SOUND':
			text = t('{0}: no energy between 125 Hz and 8 kHz; it keeps its default level', who);
			break;
		case 'W_UNMEASURED':
			text = t('{0}: its peak could not be measured; it is not boosted past what is safe', who);
			break;
		case 'W_LEVEL_UNMEASURED':
			text = t('{0}: its level could not be measured; placement’s default level applies', who);
			break;
		case 'W_LEVELS_UNMEASURED':
			text = t('The levels could not be measured: placement’s default levels apply');
			break;
		case 'W_DELIVERY_UNMEASURED':
			text = t(
				'The delivery preset could not be measured here and is left out: apply it with Delivery Target…',
			);
			break;
		case 'W_MUSIC_OVER_VOICE': {
			const lu = num(/is ([−+-]?[\d.]+) LU under/);
			text = t(
				'The music is only {0} LU under the voice during speech (target at least {1} LU): turn Ducking on for it or lower it',
				lu === null ? '?' : lu.toFixed(1).replace('-', '−'),
				DELIVERY_RELATIVE_LU.music,
			);
			break;
		}
		case 'W_AMBIENCE_OVER_VOICE': {
			const lu = num(/is ([−+-]?[\d.]+) LU under/);
			text = t(
				'The ambience is only {0} LU under the voice during speech (target at least {1} LU): turn Ducking on for it or lower it',
				lu === null ? '?' : lu.toFixed(1).replace('-', '−'),
				DELIVERY_RELATIVE_LU.ambience,
			);
			break;
		}
		case 'W_NO_DUCK_TRIGGERS':
			text = t('Nothing was ducked: no music or ambience clip has audible clips of its “Duck against” types');
			break;
		case 'W_SILENT_MIX':
			text = t('The sequence is silent: there is nothing to normalise');
			break;
		case 'W_LIBRARY_EMPTY':
			text = t(
				'No sound of the allowed sources is indexed: install the starter kit or rescan the sound library',
			);
			break;
		case 'W_PALETTE_MISSING': {
			const n = num(/^(\d+) palette/);
			text = t('{0} palette sounds are not in the library or the allowed sources', n ?? '?');
			break;
		}
		case 'W_REPORT_TRIMMED':
		case 'W_SKIPPED_TRUNCATED':
			text = t('The report was shortened; the first entries are listed');
			break;
		default: {
			// unknown codes keep the engine's English, with the clip named where the message starts with its id
			const id = w.clipId ?? idPrefix(m);
			text = where && id && m.startsWith(`${id}: `) ? `${where}: ${m.slice(id.length + 2)}` : m;
		}
	}
	return {
		kind: 'warning',
		severity: ACTION_WARNINGS.has(w.code) ? 'warning' : 'info',
		code: w.code,
		text,
		...(w.clipId ? { clipId: w.clipId } : {}),
	};
}

const MAX_NOTES = 200;

/**
 * The notes of a report (`conflicts?`, `warnings?` read defensively: either may be missing or malformed), in words:
 * W_UNRESOLVED first, then the warnings that ask for an action, the conflicts, the rest; repeated texts once. W_CONFLICT
 * warnings are left out when the report lists its conflicts (they say the same). Never throws.
 */
export function soundNotes(report: unknown, where: NoteWhere): SoundNote[] {
	const r = report && typeof report === 'object' ? (report as Record<string, unknown>) : {};
	const conflicts = Array.isArray(r.conflicts) ? r.conflicts.slice(0, 2000).filter(isConflictLike) : [];
	const warnings = Array.isArray(r.warnings) ? r.warnings.slice(0, 2000).filter(isWarningLike) : [];
	const safeWhere = (clipId: string | undefined, itemId?: string) => {
		try {
			return where(clipId, itemId);
		} catch {
			return null;
		}
	};
	const notes: SoundNote[] = [
		...conflicts.map((c) => conflictNote(c, safeWhere(c.clipId, c.itemId))),
		...warnings
			.filter((w) => !(w.code === 'W_CONFLICT' && conflicts.length))
			.map((w) => {
				// a plan names an alternative's own warning "<itemId> (alternative k): …" (final verification B: these
				// read "A sound: …" in the Auto Sound Pass notes); the note names the item and the alternative
				const alt = w.clipId ? null : ALTERNATIVE_PREFIX.exec(w.message);
				if (alt) {
					const base = safeWhere(undefined, alt[1]);
					return warningNote(
						{ code: w.code, message: `${alt[1]}: ${w.message.slice(alt[0].length)}` },
						base ? t('{0} (alternative {1})', base, alt[2]!) : null,
					);
				}
				return warningNote(w, safeWhere(w.clipId ?? idPrefix(w.message) ?? undefined));
			}),
	];
	const rank = (n: SoundNote) =>
		n.code === 'W_UNRESOLVED' ? 0 : n.severity === 'warning' ? 1 : n.kind === 'conflict' ? 2 : 3;
	const seen = new Set<string>();
	return notes
		.map((n, i) => ({ n, i }))
		.sort((a, b) => rank(a.n) - rank(b.n) || a.i - b.i)
		.map((x) => x.n)
		.filter((n) => {
			if (seen.has(n.text)) return false;
			seen.add(n.text);
			return true;
		})
		.slice(0, MAX_NOTES);
}

/** Names a clip of the sequence: "<sound> at <timecode of its start>" (null when it is not in the sequence). */
export function clipWhere(
	doc: Pick<ProjectDocument, 'media'>,
	seq: Sequence,
	clipId: string | undefined,
): string | null {
	if (!clipId || !Object.hasOwn(seq.clips, clipId)) return null;
	const c = seq.clips[clipId];
	if (!c) return null;
	return t('{0} at {1}', clipSoundTitle(doc, c), seqTimecode(seq, c.start));
}

// ---------------------------------------------------------------------------------------------------------------
// Stop-before and build of a cue

export type CueMixKind = 'stopBefore' | 'build';

export type CueMixPart = {
	/** On the cue (`cue.stopBefore` / `cue.build`). */
	stored: { start: number; end: number } | null;
	/** Written into the mix (`soundDesign.mix.cues`): the frames it was written for. */
	written: { start: number; end: number; places: string[] } | null;
	/** Why a stored one is not written (null when written or not stored). */
	why: string | null;
};

export type CueMixState = Record<CueMixKind, CueMixPart>;

const fpsOf = (rate: Rational) => (rate.den > 0 && rate.num > 0 ? rate.num / rate.den : 0);

/** Where a write went, for people: "A1 volume", "A1 filter", "clip volume". */
function placeLabel(seq: Sequence, w: { target: string; trackId?: string; clipId?: string }): string {
	const tr = w.trackId ?? (w.clipId ? seq.clips[w.clipId]?.trackId : undefined);
	const where = tr ? trackLabelOf(seq, tr) : '?';
	switch (w.target) {
		case 'trackVolume':
			return t('{0} track volume', where);
		case 'clipVolume':
			return t('{0} clip volume', where);
		case 'trackFilter':
			return t('{0} track filter', where);
		default:
			return t('{0} clip filter', where);
	}
}

/** A cue's stop-before and build: written into the mix vs only stored, in sequence frames. Never throws. */
export function cueMixState(seq: Sequence, cue: SoundCue): CueMixState {
	const fps = fpsOf(seq.settings.frameRate as Rational);
	const rec = readSoundDesignMix(seq.soundDesign?.mix)?.cues?.[cue.id];
	const filled = (cue.placedClipIds ?? []).some((id) => !!seq.clips[id]);
	const span = (frame: number, seconds: number) =>
		fps > 0 && fin(seconds) && seconds > 0 ? { start: frame - seconds * fps, end: frame } : null;
	const part = (kind: CueMixKind): CueMixPart => {
		const spec = cue[kind];
		// a muted cue's record is kept suspended (nothing written): stored only
		const r = cueMixWritten(rec?.[kind]) ? rec?.[kind] : undefined;
		const stored = spec ? span(cue.frame, spec.seconds) : null;
		const w = r ? span(r.frame, r.seconds) : null;
		const written = w && r ? { ...w, places: r.writes.map((x) => placeLabel(seq, x)) } : null;
		let why: string | null = null;
		if (spec && !written) {
			if (cue.muted) why = t('The cue is muted');
			else if (!filled) why = t('Written into the mix when the cue is filled');
			else if (!stored) why = t('It has no length');
			else {
				const uses = musicTracksUnder(seq, Math.floor(stored.start), Math.ceil(stored.end));
				why = uses.length
					? uses.every((u) => u.locked)
						? t('The music track is locked')
						: t('Not written yet')
					: t('No music plays under it');
			}
		}
		return { stored, written, why };
	};
	return { stopBefore: part('stopBefore'), build: part('build') };
}

// ---------------------------------------------------------------------------------------------------------------
// Validation (Properties "Cue", Essential Sound)

export type FieldError = { field: string; message: string };

/** Errors of a stop-before {seconds, depthDb} (empty = valid). */
export function validateStopBefore(v: { seconds: number; depthDb: number }): FieldError[] {
	const out: FieldError[] = [];
	if (!fin(v.seconds) || v.seconds <= 0 || v.seconds > 10)
		out.push({ field: 'seconds', message: t('Length must be more than 0 and at most 10 s') });
	if (!fin(v.depthDb) || v.depthDb >= 0 || v.depthDb < -60)
		out.push({ field: 'depthDb', message: t('Depth must be below 0 and at least −60 dB') });
	return out;
}

/** Errors of a build {seconds, fromHz, toHz} (empty = valid). A build rises: To is above From. */
export function validateBuild(v: { seconds: number; fromHz: number; toHz: number }): FieldError[] {
	const out: FieldError[] = [];
	if (!fin(v.seconds) || v.seconds <= 0 || v.seconds > 30)
		out.push({ field: 'seconds', message: t('Length must be more than 0 and at most 30 s') });
	const hz = (x: number) => fin(x) && x >= 20 && x <= 20_000;
	if (!hz(v.fromHz)) out.push({ field: 'fromHz', message: t('From must be 20–20000 Hz') });
	if (!hz(v.toHz)) out.push({ field: 'toHz', message: t('To must be 20–20000 Hz') });
	else if (hz(v.fromHz) && v.toHz <= v.fromHz)
		out.push({ field: 'toHz', message: t('A build rises: To must be above From') });
	return out;
}

/** A number typed by a person ("0,25" too); null when it is not one. */
export function parseNumber(s: string): number | null {
	const v = s.trim().replace(',', '.').replace('−', '-');
	if (!v) return null;
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------------------------------------------
// Delivery

export const DELIVERY_IDS = Object.keys(DELIVERY_PRESETS) as SoundDelivery[];

/** "Web / streaming · −14 LUFS · −1 dBTP" for a select. */
export function deliveryOptionLabel(p: DeliveryPreset): string {
	const name: Record<SoundDelivery, string> = {
		web: t('Web / streaming'),
		podcast: t('Podcast'),
		'broadcast-r128': t('Broadcast EBU R 128'),
		'atsc-a85': t('Broadcast ATSC A/85'),
	};
	return t(
		'{0} · {1} LUFS · {2} dBTP',
		name[p.id] ?? p.label,
		fmtDb(p.integratedLufs).replace('.0', ''),
		fmtDb(p.truePeakDb).replace('.0', ''),
	);
}

/** The sequence's delivery preset (its settings, read-time default web). */
export function sequenceDelivery(seq: Sequence | undefined): SoundDelivery {
	return readSoundDesignSettings(seq?.soundDesign?.settings).delivery;
}
