// Track mattes (wp masks): Track Matte Key effects that read another video track (Premiere's Matte = Video n).
import type { RenderSnapshot, RenderVisualClip } from '../render/snapshot.ts';
import type { Animatable } from '../schema/common.ts';

export const TRACK_MATTE_EFFECT_ID = 'jasper.track-matte-key';

/**
 * The Track Matte Key params naming a video track of the sequence, and the texture each one's composite binds:
 * `matteTrack` (the matte) and `cleanPlateTrack` (Decontaminate Edges ▸ Clean Plate Track, read only in that mode).
 */
export const TRACK_MATTE_TRACK_PARAMS = [
	{ param: 'matteTrack', uniform: 'u_matte' },
	{ param: 'cleanPlateTrack', uniform: 'u_cleanPlate' },
] as const;

type FxLike = { enabled: boolean; effectId: string; params: Record<string, Animatable<unknown> | undefined> };

const held = (a: Animatable<unknown> | undefined): unknown[] =>
	a ? [a.value, ...a.keyframes.map((k) => k.value)] : [];

/**
 * The tracks one Track Matte Key reads at a frame, by texture, from its resolved param values (the clean plate only
 * while Decontaminate Edges is Clean Plate Track). Empty when the key reads no track (Matte = None).
 */
export function trackMatteBindings(fx: {
	effectId: string;
	params: Readonly<Record<string, unknown>>;
}): { uniform: string; trackId: string }[] {
	if (fx.effectId !== TRACK_MATTE_EFFECT_ID) return [];
	const out: { uniform: string; trackId: string }[] = [];
	for (const { param, uniform } of TRACK_MATTE_TRACK_PARAMS) {
		if (param === 'cleanPlateTrack' && fx.params.decontaminate !== 'cleanPlate') continue;
		const v = fx.params[param];
		if (typeof v === 'string' && v) out.push({ uniform, trackId: v });
	}
	return out;
}

/** The video track ids the clip's enabled Track Matte Keys read (mattes and clean plates, any key of their params). */
export function trackMatteTracksOf(c: { effects: readonly FxLike[] }): string[] {
	const out = new Set<string>();
	for (const fx of c.effects) {
		if (!fx.enabled || fx.effectId !== TRACK_MATTE_EFFECT_ID) continue;
		for (const { param } of TRACK_MATTE_TRACK_PARAMS) {
			if (param === 'cleanPlateTrack' && fx.params.decontaminate?.value !== 'cleanPlate') continue;
			for (const v of held(fx.params[param])) if (typeof v === 'string' && v) out.add(v);
		}
	}
	return [...out];
}

/** Every video track some clip of the snapshot uses as a track matte. */
export function matteTrackIds(snapshot: Pick<RenderSnapshot, 'videoTracks'>): Set<string> {
	const out = new Set<string>();
	for (const t of snapshot.videoTracks)
		for (const c of t.clips) for (const id of trackMatteTracksOf(c)) out.add(id);
	return out;
}

/** The clips of a matte track drawn at sequence frame `f` (transition handles included). */
export function matteClipsAt(clips: readonly RenderVisualClip[], f: number): RenderVisualClip[] {
	return clips.filter(
		(c) => f >= c.start - (c.headHandle ?? 0) && f < c.start + c.duration + (c.tailHandle ?? 0),
	);
}
