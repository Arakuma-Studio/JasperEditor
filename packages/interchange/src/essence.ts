// Audio essence for the AAF and OMF exporters. This package decodes no media; an export that embeds audio,
// consolidates (trims) it into new files or renders clip effects works in three steps:
//
// 1. `audioNeeds` lists the audio ranges the document will reference (with handles);
// 2. the caller (the engine) decodes / renders each range and writes or keeps the PCM;
// 3. the caller passes the results as `AudioEssence` in `ExportOptions.media.essence` (and a rendered video file as
//    `media.mixdownVideo`).
//
// Port of FilmCraft `crates/interchange/src/essence.rs` (MIT OR Apache-2.0).
import { sourceOut } from './build.ts';
import type { IProject } from './model.ts';
import type { EssenceKey } from './options.ts';

/** One range of source audio an export references. */
export type AudioNeed = {
	key: EssenceKey;
	/** The media (for a clip key: the clip's media). */
	mediaId: string;
	path: string | null;
	/** Media time range to supply (flicks, handles included, clamped to the media). */
	start: number;
	end: number;
	channels: number;
	sampleRate: number;
};

export type NeedOptions = {
	/** Extra media before and after every used range (flicks). */
	handles?: number;
	/** One range per clip (to render clip effects) instead of one per media item covering all its uses. */
	perClip?: boolean;
	/** Whole media instead of the used range (embedding / copying without trimming). */
	wholeMedia?: boolean;
};

/** The audio ranges the audio tracks of `sequenceId` reference, in a stable order. */
export function audioNeeds(p: IProject, sequenceId: string, opts: NeedOptions = {}): AudioNeed[] {
	const s = p.sequences[sequenceId];
	if (!s) return [];
	const handles = Math.max(0, opts.handles ?? 0);
	const out = new Map<string, AudioNeed>();
	for (const t of s.audio)
		for (const c of t.clips) {
			if (c.source.type !== 'media') continue;
			const m = p.media[c.source.mediaId];
			if (!m?.audio || m.generator) continue;
			const lo = c.hold ?? c.sourceIn;
			const hi = c.hold != null ? lo + c.duration : sourceOut(c);
			let start = Math.max(0, lo - handles);
			let end = hi + handles;
			if (m.duration) end = Math.min(end, m.duration);
			if (opts.wholeMedia) {
				start = 0;
				end = Math.max(m.duration ?? 0, end);
			}
			const key: EssenceKey = opts.perClip ? { clip: c.id } : { media: m.id };
			const k = JSON.stringify(key);
			const known = out.get(k);
			if (known) {
				known.start = Math.min(known.start, start);
				known.end = Math.max(known.end, end);
			} else
				out.set(k, {
					key,
					mediaId: m.id,
					path: m.path,
					start,
					end,
					channels: m.audio.channels,
					sampleRate: m.audio.sampleRate,
				});
		}
	return [...out.values()].sort((a, b) => JSON.stringify(a.key).localeCompare(JSON.stringify(b.key)));
}
