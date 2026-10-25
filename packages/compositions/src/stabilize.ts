// Structural sharing between consecutive RenderDocs (S03:ARC-011, NFR-004). `buildRenderSnapshot`
// creates fresh objects on every call; the Program monitor rebuilds the doc on every gesture update, so
// without this every layer would re-render during a drag. `stabilizeRenderDoc(prev, next)` returns
// `next` with every clip, track list, media handle and font list replaced by the previous object when
// it is deeply equal. Unchanged clips then keep their identity (and their cached static props).
import { expressionBindingOf } from '@jasper/project';
import type { RenderDoc } from './types.ts';

/**
 * Deep equality for JSON-like values (plain objects, arrays, primitives). Wave expressions: Animatables bound to
 * different expression worlds are different (an expression reads other clips and sequences, so the same stored
 * expression can render differently after an edit elsewhere).
 */
export function jsonEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
		return typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b);
	}
	if (expressionBindingOf(a) !== expressionBindingOf(b)) return false;
	if (Array.isArray(a)) {
		if (!Array.isArray(b) || a.length !== b.length) return false;
		for (let i = 0; i < a.length; i++) if (!jsonEqual(a[i], b[i])) return false;
		return true;
	}
	if (Array.isArray(b)) return false;
	const ka = Object.keys(a);
	const kb = Object.keys(b);
	if (ka.length !== kb.length) return false;
	for (const k of ka) {
		if (!Object.hasOwn(b, k)) return false;
		if (!jsonEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
	}
	return true;
}

function reuse<T>(prev: T | undefined, next: T): T {
	return prev !== undefined && jsonEqual(prev, next) ? prev : next;
}

export function stabilizeRenderDoc(prev: RenderDoc | null, next: RenderDoc): RenderDoc {
	if (!prev) return next;
	if (prev === next) return prev;
	const prevClips = new Map(prev.videoTracks.flatMap((t) => t.clips.map((c) => [c.clipId, c] as const)));
	let tracksChanged = prev.videoTracks.length !== next.videoTracks.length;
	const videoTracks = next.videoTracks.map((t, i) => {
		const clips = t.clips.map((c) => reuse(prevClips.get(c.clipId), c));
		const pt = prev.videoTracks[i];
		if (
			pt &&
			pt.trackId === t.trackId &&
			pt.clips.length === clips.length &&
			pt.clips.every((c, j) => c === clips[j]) &&
			jsonEqual(pt.mattes, t.mattes)
		)
			return pt;
		tracksChanged = true;
		return { ...t, clips };
	});
	const prevAudio = new Map(prev.audioClips.map((c) => [c.clipId, c] as const));
	const audioClips = next.audioClips.map((c) => reuse(prevAudio.get(c.clipId), c));
	const audioSame =
		audioClips.length === prev.audioClips.length && audioClips.every((c, i) => c === prev.audioClips[i]);
	const media: RenderDoc['media'] = {};
	for (const [id, h] of Object.entries(next.media)) media[id] = reuse(prev.media[id], h);
	const ids = Object.keys(media);
	const mediaSame =
		ids.length === Object.keys(prev.media).length && ids.every((id) => prev.media[id] === media[id]);
	const out: RenderDoc = {
		...next,
		settings: reuse(prev.settings, next.settings),
		range: reuse(prev.range, next.range),
		videoTracks: tracksChanged ? videoTracks : prev.videoTracks,
		audioClips: audioSame ? prev.audioClips : audioClips,
		media: mediaSame ? prev.media : media,
		fonts: reuse(prev.fonts, next.fonts),
		master: reuse(prev.master, next.master),
		warnings: reuse(prev.warnings, next.warnings),
		// audio-mix: the mixer topology (pan, faders, sends, automation…) changes without any clip changing.
		...(next.audioMix ? { audioMix: reuse(prev.audioMix, next.audioMix) } : {}),
		...(next.matteTracks ? { matteTracks: reuse(prev.matteTracks, next.matteTracks) } : {}),
		...(next.emoji ? { emoji: reuse(prev.emoji, next.emoji) } : {}),
	};
	const same =
		out.version === prev.version &&
		out.sequenceId === prev.sequenceId &&
		out.durationFrames === prev.durationFrames &&
		out.settings === prev.settings &&
		out.range === prev.range &&
		out.videoTracks === prev.videoTracks &&
		out.audioClips === prev.audioClips &&
		out.media === prev.media &&
		out.fonts === prev.fonts &&
		out.master === prev.master &&
		out.audioMix === prev.audioMix &&
		out.matteTracks === prev.matteTracks &&
		out.warnings === prev.warnings;
	return same ? prev : out;
}
