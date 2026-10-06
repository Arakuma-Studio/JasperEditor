// Multi-camera model helpers (wp-multicam): angles of a multi-camera source sequence, the cameras shown in the
// Multi-Camera view, audible tracks per audio mode, and the multi-camera clips that show them.
//
// A multi-camera SOURCE sequence is an ordinary sequence with `multicam` set: each angle (camera) is one video
// track plus its audio tracks, the clips already synchronised (their placement IS the sync). A multi-camera CLIP
// is a `nest-video` / `nest-audio` clip of such a sequence with `multicam` set: an enabled one shows only its
// angle's video track (video) or plays the audible tracks of its angle (audio) instead of the composite.
import type {
	Clip,
	MulticamAngle,
	MulticamSelection,
	MulticamSource,
	NestAudioClip,
	NestVideoClip,
	Sequence,
} from '../schema/sequence.ts';

export type MulticamClip = (NestVideoClip | NestAudioClip) & { multicam: MulticamSelection };

/** A nest clip carrying a multi-camera selection (enabled or not). */
export function isMulticamClip(c: Clip | undefined | null): c is MulticamClip {
	return !!c && (c.kind === 'nest-video' || c.kind === 'nest-audio') && !!(c as { multicam?: unknown }).multicam;
}

/** An enabled multi-camera clip (Multi-Camera ▸ Enable on). */
export function isEnabledMulticamClip(c: Clip | undefined | null): c is MulticamClip {
	return isMulticamClip(c) && c.multicam.enabled;
}

export function multicamSourceOf(seq: Sequence | undefined | null): MulticamSource | null {
	return (seq as { multicam?: MulticamSource } | undefined)?.multicam ?? null;
}

/** Angles with a video track (the grid), in camera order. */
export function videoAngles(src: MulticamSource): MulticamAngle[] {
	return src.angles.filter((a) => a.videoTrackId !== null);
}

/** Enabled video angles: the cameras shown in the Multi-Camera view; "Camera N" = the Nth of these. */
export function shownAngles(src: MulticamSource): MulticamAngle[] {
	return videoAngles(src).filter((a) => a.enabled);
}

export function firstVideoAngle(src: MulticamSource): MulticamAngle | null {
	return videoAngles(src)[0] ?? null;
}

export function angleById(src: MulticamSource, id: string): MulticamAngle | null {
	return src.angles.find((a) => a.id === id) ?? null;
}

/** 1-based camera number of an angle in the shown order (0 when hidden or audio-only). */
export function cameraNumber(src: MulticamSource, angleId: string): number {
	return shownAngles(src).findIndex((a) => a.id === angleId) + 1;
}

/**
 * Resolve an angle reference: an angle id, a 1-based camera number among the shown angles (`camera: 3`), or an
 * angle/track name (case-insensitive). Null when nothing matches.
 */
export function resolveAngle(src: MulticamSource, ref: string | number): MulticamAngle | null {
	if (typeof ref === 'number') return shownAngles(src)[ref - 1] ?? null;
	const byId = angleById(src, ref);
	if (byId) return byId;
	const m = /^(?:camera\s*|cam\s*|#)?(\d+)$/i.exec(ref.trim());
	if (m) return shownAngles(src)[Number(m[1]) - 1] ?? null;
	const lower = ref.trim().toLowerCase();
	return src.angles.find((a) => a.name.toLowerCase() === lower) ?? null;
}

/**
 * Audio tracks of the source that play for a multi-camera audio clip showing `angleId` (null = the source's
 * default): audio-only angles always; camera angles per the audio mode — `camera1` the first video angle, `all`
 * every angle, `switch` the selected angle (else the first video angle).
 */
export function audibleTrackIds(src: MulticamSource, angleId: string | null): string[] {
	const first = firstVideoAngle(src);
	const selected = (angleId && angleById(src, angleId)) || first;
	const out: string[] = [];
	for (const a of src.angles) {
		const audioOnly = a.videoTrackId === null;
		const on =
			audioOnly ||
			(src.audio === 'all'
				? true
				: src.audio === 'camera1'
					? a.id === first?.id
					: a.id === (selected?.id ?? first?.id));
		if (on) out.push(...a.audioTrackIds);
	}
	return out;
}

/** The angle whose video is on `trackId`, or null. */
export function angleOfVideoTrack(src: MulticamSource, trackId: string): MulticamAngle | null {
	return src.angles.find((a) => a.videoTrackId === trackId) ?? null;
}

/** The angle an audio track belongs to, or null. */
export function angleOfAudioTrack(src: MulticamSource, trackId: string): MulticamAngle | null {
	return src.angles.find((a) => a.audioTrackIds.includes(trackId)) ?? null;
}

/** Short badge of a multi-camera clip in the timeline (Premiere shows "[MC2] name"). */
export function multicamBadge(src: MulticamSource | null, clip: MulticamClip): string {
	if (!clip.multicam.enabled) return '';
	const n = src ? cameraNumber(src, clip.multicam.angle) : 0;
	if (n > 0) return `MC${n}`;
	const a = src ? angleById(src, clip.multicam.angle) : null;
	return a ? `MC ${a.name}` : 'MC';
}

/**
 * Drop angle references to tracks the sequence no longer has, and angles left without any track (after
 * track.remove or on repair). Works on drafts. Returns the ids of removed angles; removes `multicam` when none is
 * left.
 */
export function pruneMulticamAngles(seq: Pick<Sequence, 'videoTracks' | 'audioTracks'> & { multicam?: MulticamSource }): string[] {
	const mc = seq.multicam;
	if (!mc) return [];
	const v = new Set(seq.videoTracks.map((t) => t.id));
	const a = new Set(seq.audioTracks.map((t) => t.id));
	const removed: string[] = [];
	for (const angle of mc.angles) {
		if (angle.videoTrackId !== null && !v.has(angle.videoTrackId)) angle.videoTrackId = null;
		const keep = angle.audioTrackIds.filter((id) => a.has(id));
		if (keep.length !== angle.audioTrackIds.length) angle.audioTrackIds = keep;
	}
	const alive = mc.angles.filter((x) => {
		const ok = x.videoTrackId !== null || x.audioTrackIds.length > 0;
		if (!ok) removed.push(x.id);
		return ok;
	});
	if (alive.length !== mc.angles.length) mc.angles = alive;
	if (mc.angles.length === 0) delete seq.multicam;
	return removed;
}

/** Problems of a multi-camera source description (invariants). */
export function multicamSourceIssues(seq: Pick<Sequence, 'videoTracks' | 'audioTracks'>, mc: MulticamSource): string[] {
	const out: string[] = [];
	const v = new Set(seq.videoTracks.map((t) => t.id));
	const a = new Set(seq.audioTracks.map((t) => t.id));
	const ids = new Set<string>();
	if (mc.angles.length === 0) out.push('has no angles');
	for (const angle of mc.angles) {
		if (ids.has(angle.id)) out.push(`angle id ${angle.id} is used twice`);
		ids.add(angle.id);
		if (angle.videoTrackId !== null && !v.has(angle.videoTrackId))
			out.push(`angle ${angle.id} references missing video track ${angle.videoTrackId}`);
		for (const t of angle.audioTrackIds)
			if (!a.has(t)) out.push(`angle ${angle.id} references missing audio track ${t}`);
		if (angle.videoTrackId === null && angle.audioTrackIds.length === 0) out.push(`angle ${angle.id} has no tracks`);
	}
	const vt = mc.angles.flatMap((x) => (x.videoTrackId ? [x.videoTrackId] : []));
	if (new Set(vt).size !== vt.length) out.push('two angles share a video track');
	return out;
}

/**
 * Multi-camera selections that no longer resolve: clips of a sequence that is no longer a multi-camera source lose
 * `multicam` (they play as nests), clips whose angle is gone show the first video angle. Works on drafts; returns
 * the ids of changed clips.
 */
export function fixMulticamSelections(doc: { sequences: Record<string, Sequence> }): string[] {
	const changed: string[] = [];
	for (const seq of Object.values(doc.sequences)) {
		for (const c of Object.values(seq.clips)) {
			if (!isMulticamClip(c)) continue;
			const mc = multicamSourceOf(doc.sequences[c.sequenceId]);
			if (!mc) {
				delete (c as { multicam?: unknown }).multicam;
				changed.push(c.id);
				continue;
			}
			const a = angleById(mc, c.multicam.angle);
			const ok = a && (c.kind === 'nest-audio' || a.videoTrackId !== null);
			if (!ok) {
				const next = (c.kind === 'nest-video' ? firstVideoAngle(mc) : (firstVideoAngle(mc) ?? mc.angles[0])) ?? null;
				if (next) c.multicam.angle = next.id;
				else delete (c as { multicam?: unknown }).multicam;
				changed.push(c.id);
			}
		}
	}
	return changed;
}
