// The mixing side of sound design for the UI (spec 12 §2.4 / §2.7, P4-R4 / P4-R5; wp-note "Phase 4 → WP4.2b"). Pure:
// - a placed sound's level as Essential Sound shows it: the gain, who owns it (placement's default, the masking solver,
//   or the user — Auto gain off) and why it is what it is ("−3.0 dB · limited by dialogue A1"), translated from the
//   solver's `limitedBy` codes (the stored English reason only supplies the track names);
// - the room glue seen from one clip's track (the "SFX Room" bus, the track's send, or why it cannot send);
// - a cue's stop-before / build as the Cue Seam draws them: written into the mix (`soundDesign.mix.cues`) or only stored
//   on the cue, and why a stored one is not written;
// - validation of the Properties "Cue" stop-before / build fields;
// - the delivery presets for a select (with their numbers).
import {
	type AudioClip,
	type Clip,
	type ClipSfx,
	DELIVERY_PRESETS,
	type DeliveryPreset,
	musicTracksUnder,
	type ProjectDocument,
	type Rational,
	ROOM_BUS_NAME,
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
import { sfxOf, trackLabelOf } from './design-model.ts';

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
			level.achievedLiftDb > level.targetLiftDb + 0.05
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
	const track = seq.audioTracks.find((x) => x.id === clip.trackId);
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
		else if (sfx && !sfx.send)
			blocked = t(
				'{0} also plays dialogue, music or other bed audio: a send would put them in the room too',
				label,
			);
		else if (track.locked) blocked = t('{0} is locked', label);
	}
	return { glue, bus, trackId: track.id, trackLabel: label, send, levelDb, blocked };
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
		const r = rec?.[kind];
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
