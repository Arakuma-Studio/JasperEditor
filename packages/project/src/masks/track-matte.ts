// Track mattes (wp masks): Track Matte Key effects that read another video track (Premiere's Matte = Video n).
import type { RenderSnapshot, RenderVisualClip } from '../render/snapshot.ts';
import type { Animatable } from '../schema/common.ts';

export const TRACK_MATTE_EFFECT_ID = 'jasper.track-matte-key';

type FxLike = { enabled: boolean; effectId: string; params: Record<string, Animatable<unknown> | undefined> };

/** The video track ids the clip's enabled Track Matte Keys read (any key of the hold-only `matteTrack` param). */
export function trackMatteTracksOf(c: { effects: readonly FxLike[] }): string[] {
	const out = new Set<string>();
	for (const fx of c.effects) {
		if (!fx.enabled || fx.effectId !== TRACK_MATTE_EFFECT_ID) continue;
		const a = fx.params.matteTrack;
		if (!a) continue;
		for (const v of [a.value, ...a.keyframes.map((k) => k.value)]) if (typeof v === 'string' && v) out.add(v);
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
