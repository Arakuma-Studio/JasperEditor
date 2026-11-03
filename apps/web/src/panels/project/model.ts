// Project panel model (S05:PRJ-001…010, S01:PRJ-001…008): bins, breadcrumb, search/filter and the derived
// columns (Frame Rate, Media Start/End/Duration, Video/Audio Info, Usage, Proxy, Status), computed from
// the document plus runtime status and never stored (S01:PRJ-008).

import {
	FLICKS_PER_SECOND,
	flicksToFrames,
	type MediaAsset,
	mediaUsage,
	type ProjectDocument,
	type ProjectItem,
	sequenceDuration,
} from '@jasper/project';
import type { MediaRuntime } from '@jasper/session';
import { lutSizeText } from '../../color/model.ts';
import { formatTimecode } from '../../gaps/time-display.ts';
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

type ItemStatus = 'online' | 'offline' | 'error' | 'resolving' | 'analyzing' | 'needs-engine' | '';

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
		| 'mg-bundle'
		| 'color-config'
		// 3D models and HDR environments
		| 'model'
		| 'hdri'
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
};

export type SortKey = 'name' | 'frameRate' | 'duration' | 'usage' | 'status' | 'user';

/** Children of a bin (null = project root) in user order. */
function binChildren(doc: ProjectDocument, binId: string | null): string[] {
	if (!binId) return doc.rootItems;
	const bin = doc.items[binId];
	return bin?.kind === 'bin' ? bin.children : [];
}

/** The bin that holds an item (null = the project root). */
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

const CHANNEL_NAMES: Record<number, string> = { 1: 'Mono', 2: 'Stereo', 6: '5.1' };

function describeMedia(
	asset: MediaAsset,
): Pick<
	ProjectRow,
	'frameRate' | 'mediaStart' | 'mediaEnd' | 'duration' | 'durationFrames' | 'videoInfo' | 'audioInfo'
> {
	const vs = videoStream(asset);
	const rate = (asset.kind === 'video' ? vs?.frameRate : null) ?? { num: 30, den: 1 };
	const dur = asset.probe.durationFlicks;
	const box = displayBox(asset);
	const aud = audioStreams(asset)[0];
	const frames = dur !== null ? flicksToFrames(dur, rate, 'round') : null;
	const par = vs ? vs.pixelAspect.num / vs.pixelAspect.den : 1;
	return {
		frameRate: asset.kind === 'video' ? `${formatRate(rate)} fps` : '',
		mediaStart: dur !== null ? formatTimecode(0, rate) : '',
		mediaEnd: frames !== null ? formatTimecode(Math.max(0, frames - 1), rate) : '',
		duration: frames !== null ? formatTimecode(frames, rate) : '',
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

/** `33³ · Title` of a LUT asset (S06:LUT-002). */
function lutInfoText(asset: MediaAsset): string {
	const title = asset.lut?.title;
	return [lutSizeText(asset), title].filter(Boolean).join(' · ');
}

function statusOf(rt: MediaRuntime | undefined): ItemStatus {
	if (!rt) return '';
	if (rt.availability === 'offline') return 'offline';
	if (rt.availability === 'error') return 'error';
	if (rt.availability === 'resolving') return 'resolving';
	if (rt.availability === 'needs-engine') return 'needs-engine';
	const busy = (s: MediaRuntime['thumbs']) => s.state === 'queued' || s.state === 'running';
	// pp-wma-preview: the playback audio of audio the browser cannot decode counts as analysis too.
	if (busy(rt.thumbs) || busy(rt.peaks) || (rt.playbackAudio && busy(rt.playbackAudio))) return 'analyzing';
	return 'online';
}

function rowFor(
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
	};
	switch (item.kind) {
		case 'bin':
			return { ...base, type: 'bin' };
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
				// LUT items (S06:LUT-002): size and title in the info column / tile badge.
				...(asset.kind === 'lut' ? { videoInfo: lutInfoText(asset) } : {}),
				// OCIO configs show their colour space count.
				...(asset.kind === 'color-config' && asset.colorConfig
					? { videoInfo: `OCIO · ${asset.colorConfig.spaces.length} colour spaces` }
					: {}),
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

// Keep the default locale and the column's existing collation options, but build their
// ICU comparators once instead of once per comparison in a large bin's sort.
let nameCollator: Intl.Collator | undefined;
let rateCollator: Intl.Collator | undefined;

function compare(a: ProjectRow, b: ProjectRow, key: SortKey): number {
	switch (key) {
		case 'name':
			return (nameCollator ??= new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })).compare(
				a.name,
				b.name,
			);
		case 'frameRate':
			return (rateCollator ??= new Intl.Collator(undefined, { numeric: true })).compare(
				a.frameRate,
				b.frameRate,
			);
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

type RowQuery = {
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
			if (!flat || ((!search || row.name.toLowerCase().includes(search)) && matchesFilter(row, q.filter)))
				out.push(row);
			if (row.item.kind === 'bin' && (flat || q.expanded?.has(row.id)))
				visit(row.item.children, depth + 1, seen);
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
