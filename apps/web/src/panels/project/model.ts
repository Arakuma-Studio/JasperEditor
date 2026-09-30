// Project panel model (S05:PRJ-001…010, S01:PRJ-001…008): bins, breadcrumb, search/filter and the derived
// columns (Frame Rate, Media Start/End/Duration, Video/Audio Info, Usage, Proxy, Status), computed from
// the document plus runtime status and never stored (S01:PRJ-008).
import {
	FLICKS_PER_SECOND,
	flicksToFrames,
	formatTimecode,
	type MediaAsset,
	mediaUsage,
	type ProjectDocument,
	type ProjectItem,
	type Rational,
	sequenceDuration,
} from '@jasper/project';
import type { MediaRuntime } from '@jasper/session';
import { audioStreams, displayBox, formatRate, videoStream } from '../../import/assets.ts';

export type ProjectFilter =
	| 'all'
	| 'video'
	| 'audio'
	| 'stills'
	| 'sequences'
	| 'graphics'
	| 'offline'
	| 'unused';
export const FILTERS: { id: ProjectFilter; label: string }[] = [
	{ id: 'all', label: 'All' },
	{ id: 'video', label: 'Video' },
	{ id: 'audio', label: 'Audio' },
	{ id: 'stills', label: 'Stills' },
	{ id: 'sequences', label: 'Sequences' },
	{ id: 'graphics', label: 'Graphics' },
	{ id: 'offline', label: 'Offline' },
	{ id: 'unused', label: 'Unused' },
];

export type ItemStatus = 'online' | 'offline' | 'error' | 'resolving' | 'analyzing' | 'needs-engine' | '';

export type ProjectRow = {
	id: string;
	item: ProjectItem;
	depth: number;
	name: string;
	/** Media-type key for the icon and label defaults. */
	type:
		| 'bin'
		| 'video'
		| 'audio'
		| 'image'
		| 'animated-image'
		| 'sequence'
		| 'synthetic'
		| 'font'
		| 'lut'
		| 'search-bin';
	mediaId: string | null;
	frameRate: string;
	mediaStart: string;
	mediaEnd: string;
	duration: string;
	durationFrames: number | null;
	videoInfo: string;
	audioInfo: string;
	usage: number;
	proxy: string;
	status: ItemStatus;
	/** Children count for bins. */
	children: number;
};

export type SortKey = 'name' | 'frameRate' | 'duration' | 'usage' | 'status' | 'user';

/** Children of a bin (null = project root) in user order. */
export function binChildren(doc: ProjectDocument, binId: string | null): string[] {
	if (!binId) return doc.rootItems;
	const bin = doc.items[binId];
	return bin?.kind === 'bin' ? bin.children : [];
}

export function parentBinOf(doc: ProjectDocument, itemId: string): string | null {
	for (const it of Object.values(doc.items))
		if (it.kind === 'bin' && it.children.includes(itemId)) return it.id;
	return null;
}

/** Breadcrumb from the project root to `binId` (S05:PRJ-001). */
export function breadcrumb(
	doc: ProjectDocument,
	binId: string | null,
): { id: string | null; name: string }[] {
	const out: { id: string | null; name: string }[] = [];
	let cur = binId;
	const seen = new Set<string>();
	while (cur && doc.items[cur] && !seen.has(cur)) {
		seen.add(cur);
		out.unshift({ id: cur, name: doc.items[cur]!.name });
		cur = parentBinOf(doc, cur);
	}
	out.unshift({ id: null, name: doc.name });
	return out;
}

/** Bin ids that contain `itemId` transitively (used to refuse moving a bin into itself). */
export function isInside(doc: ProjectDocument, binId: string, itemId: string): boolean {
	let cur: string | null = binId;
	const seen = new Set<string>();
	while (cur && !seen.has(cur)) {
		if (cur === itemId) return true;
		seen.add(cur);
		cur = parentBinOf(doc, cur);
	}
	return false;
}

function mediaRate(asset: MediaAsset): Rational | null {
	const vs = videoStream(asset);
	if (!vs || asset.kind !== 'video') return null;
	return vs.frameRate;
}

/** Media timecodes are non-drop-frame (source files carry no drop-frame flag in the M1 probe). */
function timecodeAt(flicks: number, rate: Rational): string {
	return formatTimecode(flicksToFrames(flicks, rate, 'round'), rate);
}

const CHANNEL_NAMES: Record<number, string> = { 1: 'Mono', 2: 'Stereo', 6: '5.1' };

export function describeMedia(
	asset: MediaAsset,
): Pick<
	ProjectRow,
	'frameRate' | 'mediaStart' | 'mediaEnd' | 'duration' | 'durationFrames' | 'videoInfo' | 'audioInfo'
> {
	const rate = mediaRate(asset) ?? { num: 30, den: 1 };
	const dur = asset.probe.durationFlicks;
	const box = displayBox(asset);
	const vs = videoStream(asset);
	const aud = audioStreams(asset)[0];
	const startFrames = 0;
	const frames = dur !== null ? flicksToFrames(dur, rate, 'round') : null;
	const par = vs ? vs.pixelAspect.num / vs.pixelAspect.den : 1;
	return {
		frameRate: asset.kind === 'video' ? `${formatRate(rate)} fps` : '',
		mediaStart: dur !== null ? formatTimecode(startFrames, rate) : '',
		mediaEnd: frames !== null ? formatTimecode(Math.max(0, frames - 1), rate) : '',
		duration: dur !== null ? timecodeAt(dur, rate) : '',
		durationFrames: frames,
		videoInfo: box ? `${box.width} x ${box.height} (${par.toFixed(1)})` : '',
		audioInfo: aud ? `${aud.sampleRate} Hz - ${CHANNEL_NAMES[aud.channels] ?? `${aud.channels} ch`}` : '',
	};
}

function derivativeText(rt: MediaRuntime | undefined): string {
	if (!rt) return '';
	const p = rt.proxy;
	if (p.state === 'ready') return 'Ready';
	if (p.state === 'running') return `${Math.round(p.progress * 100)}%`;
	if (p.state === 'queued') return 'Queued';
	if (p.state === 'failed') return 'Failed';
	return '';
}

export function statusOf(rt: MediaRuntime | undefined): ItemStatus {
	if (!rt) return '';
	if (rt.availability === 'offline') return 'offline';
	if (rt.availability === 'error') return 'error';
	if (rt.availability === 'resolving') return 'resolving';
	if (rt.availability === 'needs-engine') return 'needs-engine';
	const busy = (s: MediaRuntime['thumbs']) => s.state === 'queued' || s.state === 'running';
	if (busy(rt.thumbs) || busy(rt.peaks)) return 'analyzing';
	return 'online';
}

export function rowFor(
	doc: ProjectDocument,
	item: ProjectItem,
	depth: number,
	runtime: Record<string, MediaRuntime>,
	usage: Record<string, { clips: number }>,
): ProjectRow {
	const base = {
		id: item.id,
		item,
		depth,
		name: item.name,
		mediaId: null as string | null,
		frameRate: '',
		mediaStart: '',
		mediaEnd: '',
		duration: '',
		durationFrames: null as number | null,
		videoInfo: '',
		audioInfo: '',
		usage: 0,
		proxy: '',
		status: '' as ItemStatus,
		children: 0,
	};
	switch (item.kind) {
		case 'bin':
			return { ...base, type: 'bin', children: item.children.length };
		case 'search-bin':
			return { ...base, type: 'search-bin' };
		case 'sequence': {
			const seq = doc.sequences[item.sequenceId];
			if (!seq) return { ...base, type: 'sequence' };
			const frames = sequenceDuration(seq);
			const r = seq.settings.frameRate;
			const drop = seq.settings.dropFrame;
			return {
				...base,
				type: 'sequence',
				frameRate: `${formatRate(r)} fps`,
				mediaStart: formatTimecode(0, r, { dropFrame: drop, startFrames: seq.settings.startTimecodeFrames }),
				mediaEnd: formatTimecode(Math.max(0, frames - 1), r, {
					dropFrame: drop,
					startFrames: seq.settings.startTimecodeFrames,
				}),
				duration: formatTimecode(frames, r, { dropFrame: drop }),
				durationFrames: frames,
				videoInfo: `${seq.settings.width} x ${seq.settings.height} (1.0)`,
				audioInfo: `${seq.settings.audioSampleRate} Hz - Stereo`,
				status: 'online',
			};
		}
		case 'synthetic':
			return { ...base, type: 'synthetic', status: 'online' };
		case 'media': {
			const asset = doc.media[item.mediaId];
			if (!asset) return { ...base, type: 'video', mediaId: item.mediaId, status: 'offline' };
			const rt = runtime[asset.id];
			return {
				...base,
				type: asset.kind,
				mediaId: asset.id,
				...describeMedia(asset),
				usage: usage[asset.id]?.clips ?? 0,
				proxy: derivativeText(rt),
				status: statusOf(rt),
			};
		}
	}
	return { ...base, type: 'bin' };
}

function matchesFilter(row: ProjectRow, filter: ProjectFilter): boolean {
	switch (filter) {
		case 'all':
			return true;
		case 'video':
			return row.type === 'video';
		case 'audio':
			return row.type === 'audio';
		case 'stills':
			return row.type === 'image' || row.type === 'animated-image';
		case 'sequences':
			return row.type === 'sequence';
		case 'graphics':
			return row.type === 'synthetic';
		case 'offline':
			return row.status === 'offline';
		case 'unused':
			return row.mediaId !== null && row.usage === 0;
	}
}

function compare(a: ProjectRow, b: ProjectRow, key: SortKey): number {
	switch (key) {
		case 'name':
			return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
		case 'frameRate':
			return a.frameRate.localeCompare(b.frameRate, undefined, { numeric: true });
		case 'duration':
			return (a.durationFrames ?? -1) - (b.durationFrames ?? -1);
		case 'usage':
			return a.usage - b.usage;
		case 'status':
			return a.status.localeCompare(b.status);
		default:
			return 0;
	}
}

export type RowQuery = {
	binId: string | null;
	search: string;
	filter: ProjectFilter;
	/** Bins expanded inline (list view disclosure triangles). */
	expanded?: ReadonlySet<string>;
	sort?: { key: SortKey; dir: 1 | -1 };
};

/**
 * Rows for the current bin: with an empty search and the "All" filter, the bin's children in user order
 * (expanded bins inline); otherwise a flat list of every matching item below the bin.
 */
export function projectRows(
	doc: ProjectDocument,
	runtime: Record<string, MediaRuntime>,
	q: RowQuery,
): ProjectRow[] {
	const usage = mediaUsage(doc);
	const search = q.search.trim().toLowerCase();
	const flat = search.length > 0 || q.filter !== 'all';
	const out: ProjectRow[] = [];
	const visit = (ids: string[], depth: number, seen: Set<string>) => {
		const rows = ids
			.map((id) => doc.items[id])
			.filter((it): it is ProjectItem => !!it && !seen.has(it.id))
			.map((it) => rowFor(doc, it, flat ? 0 : depth, runtime, usage));
		if (q.sort && q.sort.key !== 'user') {
			const { key, dir } = q.sort;
			rows.sort((a, b) => {
				if (a.type === 'bin' && b.type !== 'bin') return -1;
				if (b.type === 'bin' && a.type !== 'bin') return 1;
				return compare(a, b, key) * dir;
			});
		}
		for (const row of rows) {
			seen.add(row.id);
			const isBin = row.item.kind === 'bin';
			if (flat) {
				if ((!search || row.name.toLowerCase().includes(search)) && matchesFilter(row, q.filter))
					out.push(row);
				if (isBin) visit((row.item as { children: string[] }).children, depth + 1, seen);
			} else {
				out.push(row);
				if (isBin && q.expanded?.has(row.id))
					visit((row.item as { children: string[] }).children, depth + 1, seen);
			}
		}
	};
	visit(binChildren(doc, q.binId), 0, new Set());
	return out;
}

/** Seconds → frames helper for hover scrub on media without a video stream rate. */
export function durationSeconds(asset: MediaAsset | undefined): number {
	const d = asset?.probe.durationFlicks;
	return d ? d / FLICKS_PER_SECOND : 0;
}
