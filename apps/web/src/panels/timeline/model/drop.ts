// Drop placement helpers (S02:TL-492…496): the duration a project item will occupy when placed, so
// several dropped items can be chained back to back in one "Place N Clips" transaction. Mirrors the
// `clip.place` duration rules (media marks or full length; stills use the project default).
import {
	flicksPerFrame,
	type MediaAsset,
	type ProjectDocument,
	type ProjectItem,
	type Rational,
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
		return still;
	}
	return null;
}
