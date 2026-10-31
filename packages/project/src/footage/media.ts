// Spec 18 AF-DIG-001 / AF-TAK-001: which media the footage digest and takes read, in what order, and how a media
// is described. Order: the Project panel's bin order (a depth-first walk of `rootItems` and bin `children`), then
// name, then id; media without a Project item come last. Pure.
import { transcriptForMedia } from '../captions/sequence-transcript.ts';
import { interpretedFrameRate, mediaDisplaySize, mediaDurationFlicks } from '../interpret/model.ts';
import type { ProjectDocument } from '../schema/document.ts';
import type { MediaAsset, Transcript } from '../schema/media.ts';
import { FLICKS_PER_SECOND } from '../time.ts';
import { oneLine } from './phrases.ts';

/** Bins nested deeper than this are not walked (a malformed document cannot recurse without bound). */
const MAX_BIN_DEPTH = 256;
/** Names are cut to this many characters in the digest. */
export const FOOTAGE_NAME_MAX = 120;

export type FootageMedia = {
	id: string;
	asset: MediaAsset;
	/** Its first Project item's name, else the file name (one line, ≤ FOOTAGE_NAME_MAX characters). */
	name: string;
	/** Position of its first Project item in bin order (Infinity without one). */
	order: number;
	transcript: Transcript | null;
	hasAudio: boolean;
	hasVideo: boolean;
};

/** A name on one line, at most `FOOTAGE_NAME_MAX` characters. */
export function footageName(s: unknown): string {
	const t = oneLine(typeof s === 'string' ? s : '');
	return t.length > FOOTAGE_NAME_MAX ? `${t.slice(0, FOOTAGE_NAME_MAX - 1)}…` : t;
}

/** First Project item (bin order) of each media: its position and name. */
function itemOrder(doc: ProjectDocument): Map<string, { order: number; name: string }> {
	const out = new Map<string, { order: number; name: string }>();
	const seen = new Set<string>();
	let n = 0;
	const items = doc.items ?? {};
	const walk = (ids: unknown, depth: number) => {
		if (!Array.isArray(ids) || depth > MAX_BIN_DEPTH) return;
		for (const id of ids) {
			if (typeof id !== 'string' || seen.has(id)) continue;
			seen.add(id);
			const it = items[id];
			if (!it) continue;
			if (it.kind === 'bin') walk(it.children, depth + 1);
			else if (it.kind === 'media' && typeof it.mediaId === 'string' && !out.has(it.mediaId))
				out.set(it.mediaId, { order: n++, name: it.name });
		}
	};
	walk(doc.rootItems, 0);
	return out;
}

const byOrder = (a: FootageMedia, b: FootageMedia) =>
	a.order - b.order ||
	(a.name < b.name ? -1 : a.name > b.name ? 1 : 0) ||
	(a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Describes one media of `doc` (null when it is not there). */
function describe(doc: ProjectDocument, id: string, order: Map<string, { order: number; name: string }>) {
	const asset = doc.media?.[id];
	if (!asset || typeof asset !== 'object') return null;
	const streams = Array.isArray(asset.probe?.streams) ? asset.probe.streams : [];
	const o = order.get(id);
	return {
		id,
		asset,
		name: footageName(o?.name || asset.originalName || id),
		order: o ? o.order : Number.POSITIVE_INFINITY,
		transcript: transcriptForMedia(doc, id),
		hasAudio: streams.some((s) => s?.type === 'audio'),
		// an audio file's cover art is not a picture of the footage
		hasVideo: asset.kind !== 'audio' && streams.some((s) => s?.type === 'video'),
	} satisfies FootageMedia;
}

/**
 * The media to read: `ids` (unknown ones listed in `missing`), or every transcribed media plus (`which` = `digest`)
 * every video / audio media with sound. Sorted in bin order then name, duplicates removed.
 */
export function footageMedia(
	doc: ProjectDocument,
	ids?: readonly string[] | null,
	which: 'digest' | 'transcribed' = 'digest',
): { media: FootageMedia[]; missing: string[] } {
	const order = itemOrder(doc);
	const media: FootageMedia[] = [];
	const missing: string[] = [];
	if (ids) {
		for (const id of new Set(ids)) {
			const m = describe(doc, id, order);
			if (m) media.push(m);
			else missing.push(id);
		}
	} else {
		for (const id of Object.keys(doc.media ?? {})) {
			const m = describe(doc, id, order);
			if (!m) continue;
			const footage = m.hasAudio && (m.asset.kind === 'video' || m.asset.kind === 'audio');
			if (m.transcript || (which === 'digest' && footage)) media.push(m);
		}
	}
	media.sort(byOrder);
	return { media, missing };
}

/** The media's duration in flicks (null when unknown or a still). */
export function footageDuration(asset: MediaAsset): number | null {
	try {
		const d = mediaDurationFlicks(asset);
		return d !== null && Number.isFinite(d) && d > 0 ? d : null;
	} catch {
		return null;
	}
}

/** "29.97", "25", "23.98": a frame rate with at most two decimals. */
export function fpsText(num: number, den: number): string | null {
	const fps = num / den;
	if (!Number.isFinite(fps) || fps <= 0) return null;
	return String(Math.round(fps * 100) / 100);
}

/** Seconds with one decimal ("43.0 s"). */
export const secondsText = (flicks: number) => `${(flicks / FLICKS_PER_SECOND).toFixed(1)} s`;

/** The digest header facts of a media: duration, picture, sound. */
export function mediaFacts(m: FootageMedia): string[] {
	const parts: string[] = [];
	const d = footageDuration(m.asset);
	let size: { width: number; height: number } | null = null;
	let rate: { num: number; den: number } | null = null;
	try {
		size = m.hasVideo ? mediaDisplaySize(m.asset) : null;
		rate = m.hasVideo ? interpretedFrameRate(m.asset) : null;
	} catch {
		size = null;
	}
	if (d !== null) parts.push(secondsText(d));
	if (size) {
		const fps = d !== null && rate ? fpsText(rate.num, rate.den) : null;
		parts.push(`${size.width}×${size.height}${fps ? ` ${fps} fps` : d === null ? ' still' : ''}`);
	} else if (d === null) parts.push('duration unknown');
	if (!m.hasVideo && m.hasAudio) parts.push('audio only');
	else if (!m.hasAudio) parts.push('no audio');
	return parts;
}
