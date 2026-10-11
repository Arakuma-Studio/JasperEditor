// Drop placement helpers (S02:TL-492…496): the duration a project item will occupy when placed, so
// several dropped items can be chained back to back in one "Place N Clips" transaction. Mirrors the
// `clip.place` duration rules (media marks or full length; stills use the project default).
import {
	flicksPerFrame,
	type MediaAsset,
	type ProjectDocument,
	type ProjectItem,
	type Rational,
	SYNTHETIC_INFO,
	sequenceDuration,
} from '@jasper/project';

export function itemDurationFrames(doc: ProjectDocument, item: ProjectItem, rate: Rational): number | null {
	const F = flicksPerFrame(rate);
	const still = Math.max(
		1,
		Math.round((doc.settings.defaultStillDurationFrames * rate.num) / (rate.den * 30)),
	);
	if (item.kind === 'media') {
		const asset = doc.media[item.mediaId] as MediaAsset | undefined;
		if (!asset) return null;
		if (asset.kind !== 'video' && asset.kind !== 'audio')
			return asset.kind === 'image' || asset.kind === 'animated-image' ? still : null;
		const dur = asset.probe.durationFlicks;
		if (dur === null) return null;
		const inF = item.marks.in?.flicks ?? 0;
		const outF = Math.min(item.marks.out?.flicks ?? dur, dur);
		return Math.max(1, Math.floor(outF / F - inF / F + 1e-9));
	}
	if (item.kind === 'synthetic') {
		const m = item.marks;
		if (m.in && m.out) return Math.max(1, Math.round((m.out.flicks - m.in.flicks) / F));
		// Bars and Tone 1 s, the counting leader 11 s, the others the still default.
		const syn = doc.synthetics[item.syntheticId];
		const secs = syn ? SYNTHETIC_INFO[syn.kind].defaultSeconds : null;
		return secs === null ? still : Math.max(1, Math.round((secs * rate.num) / rate.den));
	}
	if (item.kind === 'sequence') {
		// its In/Out (else all of it), in this sequence's frames.
		const seq = doc.sequences[item.sequenceId];
		if (!seq) return null;
		const Fs = flicksPerFrame(seq.settings.frameRate);
		const end = sequenceDuration(seq);
		if (end === 0) return null;
		const a = (seq.inPoint ?? 0) * Fs;
		const b = (seq.outPoint ?? end) * Fs;
		return b > a ? Math.max(1, Math.floor((b - a) / F + 1e-6)) : null;
	}
	return null;
}

/** whether a placed item brings a picture and / or sound (sequences, synthetics). */
export function itemAvKinds(doc: ProjectDocument, item: ProjectItem): { video: boolean; audio: boolean } {
	if (item.kind === 'synthetic') {
		const syn = doc.synthetics[item.syntheticId];
		return { video: true, audio: !!syn && SYNTHETIC_INFO[syn.kind].hasAudio };
	}
	if (item.kind === 'sequence') {
		const seq = doc.sequences[item.sequenceId];
		if (!seq) return { video: true, audio: false };
		const v = new Set(seq.videoTracks.map((t) => t.id));
		const a = new Set(seq.audioTracks.map((t) => t.id));
		const clips = Object.values(seq.clips);
		const audio = clips.some((c) => a.has(c.trackId));
		return { video: clips.some((c) => v.has(c.trackId)) || !audio, audio };
	}
	return { video: true, audio: false };
}
