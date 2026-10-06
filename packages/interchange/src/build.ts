// Shared helpers for readers (building an `IProject`) and writers (walking one).
import type { Animatable, LabelColor } from '@jasper/project';
import type {
	IBinEntry,
	IClip,
	IGenerator,
	IMedia,
	IMediaKind,
	IProject,
	ISequence,
	ITrack,
	Rate,
} from './model.ts';
import { flicksPerFrame } from './time.ts';

// ---------------------------------------------------------------- clip arithmetic

/** Content consumed by a clip (flicks): `duration × speed`, 0 for a frame hold. */
export function sourceSpan(c: Pick<IClip, 'duration' | 'speed' | 'hold'>): number {
	if (c.hold !== undefined && c.hold !== null) return 0;
	return scaled(c.duration, c.speed);
}

/** Exclusive end of the content a clip uses. */
export function sourceOut(c: Pick<IClip, 'sourceIn' | 'duration' | 'speed' | 'hold'>): number {
	return c.sourceIn + sourceSpan(c);
}

export function clipEnd(c: Pick<IClip, 'start' | 'duration'>): number {
	return c.start + c.duration;
}

/** `d × speed` rounded to whole flicks (exact for integral speeds). */
export function scaled(d: number, speed: number): number {
	const s = Math.abs(speed);
	if (s === 1) return d;
	if (Number.isInteger(s)) return d * s;
	return Math.round(d * s);
}

/** Timeline duration of a content span at `speed`. */
export function unscaled(d: number, speed: number): number {
	const s = Math.abs(speed);
	if (s === 0 || s === 1) return d;
	return Math.round(d / s);
}

/** The default (empty) animatable. */
export function anim<T>(value: T): Animatable<T> {
	return { value, keyframes: [] };
}

export function isAnimated(a: Animatable<unknown> | undefined | null): boolean {
	return !!a && a.keyframes.length > 0;
}

// ---------------------------------------------------------------- level conversions

export function dbToGain(db: number): number {
	return db <= -287 ? 0 : 10 ** (db / 20);
}

export function gainToDb(g: number): number {
	return g <= 1e-15 ? -287.5 : 20 * Math.log10(g);
}

// ---------------------------------------------------------------- labels

const LABELS: readonly LabelColor[] = [
	'violet',
	'iris',
	'caribbean',
	'lavender',
	'cerulean',
	'forest',
	'rose',
	'mango',
	'purple',
	'blue',
	'teal',
	'magenta',
	'tan',
	'green',
	'brown',
	'yellow',
];

/** A JasperEditor label from a document label name (Premiere names, any case; FCP7 names like "Good Take" → null). */
export function labelFrom(s: string | null | undefined): LabelColor | null {
	if (!s) return null;
	const n = s.trim().toLowerCase();
	return LABELS.find((l) => l === n) ?? null;
}

/** Premiere-style label name ("Iris"). */
export function labelName(l: LabelColor): string {
	return l.charAt(0).toUpperCase() + l.slice(1);
}

/** Marker colours some formats use (FCPXML/Resolve/OTIO colour names) → labels. */
export function labelFromColorName(s: string | null | undefined): LabelColor | null {
	if (!s) return null;
	const direct = labelFrom(s);
	if (direct) return direct;
	switch (s.trim().toLowerCase()) {
		case 'red':
			return 'rose';
		case 'orange':
			return 'mango';
		case 'cyan':
			return 'caribbean';
		case 'pink':
			return 'magenta';
		case 'white':
		case 'black':
			return 'lavender';
		default:
			return null;
	}
}

/** OTIO / Resolve marker colour names for a label. */
export function colorNameOf(l: LabelColor): string {
	switch (l) {
		case 'rose':
			return 'RED';
		case 'mango':
			return 'ORANGE';
		case 'yellow':
			return 'YELLOW';
		case 'green':
		case 'forest':
			return 'GREEN';
		case 'caribbean':
		case 'teal':
			return 'CYAN';
		case 'blue':
		case 'cerulean':
		case 'iris':
			return 'BLUE';
		case 'violet':
		case 'purple':
		case 'lavender':
			return 'PURPLE';
		case 'magenta':
			return 'MAGENTA';
		default:
			return 'PINK';
	}
}

// ---------------------------------------------------------------- import builder

export type MediaInit = {
	name: string;
	kind?: IMediaKind;
	path?: string | null;
	url?: string | null;
	duration?: number | null;
	video?: IMedia['video'];
	audio?: IMedia['audio'];
	timecode?: IMedia['timecode'];
	reel?: string | null;
	generator?: IGenerator;
	label?: LabelColor;
	offline?: boolean;
	sizeBytes?: number | null;
	embedded?: IMedia['embedded'];
	jasper?: Record<string, unknown>;
};

/**
 * Builds an `IProject` for a reader: media deduplicated by a key (normally the resolved path), sequences,
 * bins, clip placement without overlaps, and `finish()` which grows media durations to cover their uses.
 */
export class Builder {
	readonly p: IProject;
	private readonly mediaByKey = new Map<string, string>();
	private n = 0;

	constructor(name: string) {
		this.p = { name, root: [], media: {}, sequences: {}, top: [] };
	}

	id(prefix: string): string {
		this.n++;
		return `${prefix}${this.n}`;
	}

	findMedia(key: string): string | null {
		return this.mediaByKey.get(key) ?? null;
	}

	/** Media deduplicated by `key`; added to `bin` (an entry list) the first time. */
	media(key: string, init: MediaInit, bin: IBinEntry[] | null = this.p.root): string {
		const known = this.mediaByKey.get(key);
		if (known) return known;
		const id = this.id('m');
		const kind: IMediaKind =
			init.kind ?? (init.generator ? 'generator' : init.video ? 'video' : init.audio ? 'audio' : 'video');
		const m: IMedia = {
			id,
			name: init.name,
			kind,
			path: init.path ?? null,
			duration: init.duration ?? null,
			markers: [],
			...(init.url ? { url: init.url } : {}),
			...(init.video ? { video: init.video } : {}),
			...(init.audio ? { audio: init.audio } : {}),
			...(init.timecode ? { timecode: init.timecode } : {}),
			...(init.reel ? { reel: init.reel } : {}),
			...(init.generator ? { generator: init.generator } : {}),
			...(init.label ? { label: init.label } : {}),
			...(init.offline ? { offline: true } : {}),
			...(init.sizeBytes != null ? { sizeBytes: init.sizeBytes } : {}),
			...(init.embedded ? { embedded: init.embedded } : {}),
			...(init.jasper ? { jasper: init.jasper } : {}),
		};
		this.p.media[id] = m;
		this.mediaByKey.set(key, id);
		if (bin) bin.push({ type: 'media', id });
		return id;
	}

	/** A bin entry list (child of `parent`, default the root). */
	bin(name: string, parent: IBinEntry[] = this.p.root, label?: LabelColor): IBinEntry[] {
		const children: IBinEntry[] = [];
		parent.push({ type: 'bin', name, children, ...(label ? { label } : {}) });
		return children;
	}

	/** A new sequence (registered; optionally listed in `bin` and as a top-level timeline). */
	sequence(
		init: Omit<ISequence, 'id' | 'video' | 'audio' | 'markers'> & Partial<Pick<ISequence, 'markers'>>,
		opts: { bin?: IBinEntry[] | null; top?: boolean } = {},
	): ISequence {
		const id = this.id('s');
		const seq: ISequence = { ...init, id, video: [], audio: [], markers: init.markers ?? [] };
		this.p.sequences[id] = seq;
		const bin = opts.bin === undefined ? this.p.root : opts.bin;
		if (bin) bin.push({ type: 'sequence', id });
		if (opts.top) this.p.top.push(id);
		return seq;
	}

	track(): ITrack {
		return { name: null, enabled: true, locked: false, clips: [], transitions: [] };
	}

	ensureTracks(seq: ISequence, kind: 'video' | 'audio', n: number): void {
		const list = seq[kind];
		while (list.length < n) list.push(this.track());
	}

	/**
	 * Put `clip` on track `preferred` (0-based) of `kind`, or on the first track above it with room (creating
	 * tracks as needed). Returns the track index used.
	 */
	place(seq: ISequence, kind: 'video' | 'audio', preferred: number, clip: IClip): number {
		let i = Math.max(0, preferred);
		for (;;) {
			this.ensureTracks(seq, kind, i + 1);
			const t = seq[kind][i]!;
			if (!t.clips.some((o) => o.start < clipEnd(clip) && clip.start < clipEnd(o))) {
				insertSorted(t, clip);
				return i;
			}
			i++;
		}
	}

	/** Overwrite `clip` onto a track (EDL record semantics): what it covers is trimmed or split. */
	overwrite(track: ITrack, clip: IClip): void {
		const s = clip.start;
		const e = clipEnd(clip);
		const out: IClip[] = [];
		for (const o of track.clips) {
			if (clipEnd(o) <= s || o.start >= e) {
				out.push(o);
				continue;
			}
			if (o.start < s) out.push({ ...o, duration: s - o.start });
			if (clipEnd(o) > e) {
				const cut = e - o.start;
				out.push({
					...o,
					id: this.id('c'),
					start: e,
					duration: clipEnd(o) - e,
					sourceIn: o.reverse ? o.sourceIn : o.sourceIn + scaled(cut, o.speed),
				});
			}
		}
		out.push(clip);
		out.sort((a, b) => a.start - b.start);
		track.clips = out;
	}

	/** Finish: sort clips, grow media durations to cover every use, drop empty trailing tracks of nothing. */
	finish(): IProject {
		const need = new Map<string, number>();
		for (const seq of Object.values(this.p.sequences)) {
			for (const t of [...seq.video, ...seq.audio]) {
				t.clips.sort((a, b) => a.start - b.start);
				t.transitions.sort((a, b) => a.start - b.start);
				for (const c of t.clips) {
					if (c.source.type !== 'media') continue;
					const end = Math.max(sourceOut(c), (c.hold ?? c.sourceIn) + 1);
					need.set(c.source.mediaId, Math.max(need.get(c.source.mediaId) ?? 0, end));
				}
			}
		}
		for (const [id, end] of need) {
			const m = this.p.media[id];
			if (m && m.kind !== 'image' && m.kind !== 'generator' && (m.duration === null || m.duration < end))
				m.duration = end;
		}
		return this.p;
	}
}

export function insertSorted(t: ITrack, clip: IClip): void {
	let k = t.clips.length;
	while (k > 0 && t.clips[k - 1]!.start > clip.start) k--;
	t.clips.splice(k, 0, clip);
}

/** A new clip with defaults (enabled, speed 1, no effects). */
export function newClip(
	init: Pick<IClip, 'id' | 'name' | 'start' | 'duration' | 'sourceIn' | 'source'> & Partial<IClip>,
): IClip {
	return {
		speed: 1,
		reverse: false,
		enabled: true,
		markers: [],
		effects: [],
		...init,
	};
}

// ---------------------------------------------------------------- writer helpers

/** Every bin path of an entry (for writers that rebuild the bin tree). */
export function findInBins(root: IBinEntry[], pred: (e: IBinEntry) => boolean): IBinEntry[][] | null {
	const walk = (list: IBinEntry[], trail: IBinEntry[][]): IBinEntry[][] | null => {
		for (const e of list) {
			if (pred(e)) return [...trail, list];
			if (e.type === 'bin') {
				const r = walk(e.children, [...trail, list]);
				if (r) return r;
			}
		}
		return null;
	};
	return walk(root, []);
}

/** Sequences nested (directly or not) in `seqId`, children before parents; cycles are cut. */
export function nestedSequences(p: IProject, seqId: string): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	const visit = (id: string) => {
		if (seen.has(id)) return;
		seen.add(id);
		const s = p.sequences[id];
		if (!s) return;
		for (const t of [...s.video, ...s.audio])
			for (const c of t.clips) if (c.source.type === 'sequence') visit(c.source.sequenceId);
		out.push(id);
	};
	visit(seqId);
	return out;
}

/** Sequence duration (end of the last clip). */
export function sequenceDuration(s: ISequence): number {
	let end = 0;
	for (const t of [...s.video, ...s.audio]) for (const c of t.clips) end = Math.max(end, clipEnd(c));
	return end;
}

/** Frame number of a flick time (for report messages). */
export function frameOf(t: number, rate: Rate): number {
	return Math.round(t / flicksPerFrame(rate));
}

/** How reports name a clip: `text clip "Title" at frame 48`. */
export function describeClip(c: IClip, rate: Rate): string {
	const what =
		c.source.type === 'none' ? c.source.what : c.source.type === 'sequence' ? 'nested sequence' : 'clip';
	return `${what} "${c.name}" at frame ${frameOf(c.start, rate)}`;
}
