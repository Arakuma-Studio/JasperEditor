// What a proposal item was built against (spec 12 §2.5: "ghosts follow their anchors"; accept reports stale items).
// At validation every entity id an item's commands name is recorded with a fingerprint of where that entity was;
// `revalidate` compares them with the current document: an anchor that is gone or moved makes the item stale.
import { canonicalJson } from '../canonical-json.ts';
import { looksLikeId } from '../ids.ts';
import type { ProjectDocument } from '../schema/document.ts';
import type { Rational } from '../time.ts';
import { formatTimecode } from '../timecode.ts';

/** Two FNV-1a 32-bit hashes (different offsets) as 16 hex digits. For change detection, not security. */
export function stableHash(text: string): string {
	let a = 0x811c9dc5;
	let b = 0x01000193 ^ 0x5bd1e995;
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i);
		a = Math.imul(a ^ c, 0x01000193);
		b = Math.imul(b ^ c, 0x01000193) ^ (b >>> 15);
	}
	return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}

const hashCache = new WeakMap<object, string>();
/** Content hash of a document (canonical JSON: key order does not matter). Cached per document object. */
export function documentHash(doc: ProjectDocument): string {
	const hit = hashCache.get(doc);
	if (hit) return hit;
	let h: string;
	try {
		h = stableHash(canonicalJson(doc));
	} catch {
		h = 'unhashable';
	}
	hashCache.set(doc, h);
	return h;
}

/** Most entity ids recorded per item (the rest are still checked by the dry run). */
export const MAX_ANCHORS_PER_ITEM = 256;
// Same exclusions as the transaction's touched-entity walk: a clipboard payload's or an effect preset's ids are data.
const DATA_KEYS = new Set(['payload', 'preset']);

/** Entity ids named anywhere in commands (bounded depth and count), in first-seen order. */
export function commandEntityIds(commands: readonly unknown[], max = MAX_ANCHORS_PER_ITEM): string[] {
	const out = new Set<string>();
	const walk = (v: unknown, depth: number) => {
		if (out.size >= max || depth > 32) return;
		if (looksLikeId(v)) out.add(v);
		else if (Array.isArray(v)) for (const x of v) walk(x, depth + 1);
		else if (v && typeof v === 'object')
			for (const [k, x] of Object.entries(v)) if (!DATA_KEYS.has(k)) walk(x, depth + 1);
	};
	for (const c of commands) walk(c, 0);
	return [...out];
}

type Indexable = Record<string, unknown>;
const rec = (v: unknown): Indexable => (v && typeof v === 'object' ? (v as Indexable) : {});
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 'x');

const indexCache = new WeakMap<object, Map<string, string>>();

/**
 * id → fingerprint of every addressable entity: clips by track, start, length, In point and speed; transitions by
 * track, clips, length and alignment; sequence markers and sound cues by frame; everything else by presence.
 */
function anchorIndex(doc: ProjectDocument): Map<string, string> {
	const hit = indexCache.get(doc);
	if (hit) return hit;
	const m = new Map<string, string>();
	m.set(doc.projectId, 'project');
	for (const key of ['items', 'media', 'synthetics', 'transcripts', 'fonts'] as const)
		for (const id of Object.keys(rec(doc[key]))) m.set(id, key);
	for (const [sid, seqRaw] of Object.entries(rec(doc.sequences))) {
		const seq = rec(seqRaw);
		m.set(sid, 'sequence');
		for (const list of ['videoTracks', 'audioTracks', 'captionTracks'])
			for (const t of Array.isArray(seq[list]) ? (seq[list] as unknown[]) : [])
				if (typeof rec(t).id === 'string') m.set(rec(t).id as string, 'track');
		for (const [id, cRaw] of Object.entries(rec(seq.clips))) {
			const c = rec(cRaw);
			m.set(
				id,
				`clip:${String(c.trackId)}:${num(c.start)}:${num(c.duration)}:${num(c.sourceIn)}:${num(rec(c.speed).rate)}:${rec(c.speed).reverse === true}`,
			);
		}
		for (const [id, tRaw] of Object.entries(rec(seq.transitions))) {
			const t = rec(tRaw);
			m.set(
				id,
				`transition:${String(t.trackId)}:${String(t.outgoingClipId)}:${String(t.incomingClipId)}:${num(t.duration)}:${String(t.alignment)}`,
			);
		}
		for (const key of ['links', 'groups']) for (const id of Object.keys(rec(seq[key]))) m.set(id, key);
		for (const mk of Array.isArray(seq.markers) ? (seq.markers as unknown[]) : []) {
			const r = rec(mk);
			if (typeof r.id === 'string') m.set(r.id, `marker:${num(r.frame)}:${num(r.duration)}`);
		}
		for (const [id, cue] of Object.entries(rec(rec(seq.soundDesign).cues)))
			m.set(id, `cue:${num(rec(cue).frame)}`);
	}
	indexCache.set(doc, m);
	return m;
}

/** Where an entity is (see `anchorIndex`), or null when the document has no such top-level entity. */
export function anchorFingerprint(doc: ProjectDocument, id: string): string | null {
	return anchorIndex(doc).get(id) ?? null;
}

/** The anchors of a command set: every named entity the document has, with its fingerprint. */
export function itemAnchors(doc: ProjectDocument, commands: readonly unknown[]): Record<string, string> {
	const out: Record<string, string> = {};
	for (const id of commandEntityIds(commands)) {
		const fp = anchorFingerprint(doc, id);
		if (fp !== null) out[id] = fp;
	}
	return out;
}

/** What an anchor was, for a reason a person can read: an entity kind, and where it was / is (sequence frames). */
export type AnchorProblem = {
	id: string;
	entity: 'clip' | 'cue' | 'marker' | 'transition' | 'track' | 'media' | 'item' | 'sequence' | 'other';
	/**
	 * deleted: gone from the document; track: a clip on another track; start: a clip moved in time; length: trimmed;
	 * retimed: In point or speed changed; frame: a cue or marker moved; changed: anything else about it.
	 */
	change: 'deleted' | 'track' | 'start' | 'length' | 'retimed' | 'frame' | 'changed';
	/** Where it was and is (frames of the sequence): a clip's start, a cue's or marker's frame. */
	at?: number;
	to?: number;
	/** A clip's length before and after (frames), for `length`. */
	length?: number;
	lengthTo?: number;
	/** The clip's or marker's name, when the document still has it. */
	name?: string;
	/** The cue's kind (`cut`, `move`, `land`…), from the document or the item's `meta.kind` for its own cue. */
	cueKind?: string;
	/** The sequence it is in (or was in: the proposal's), for timecodes. */
	sequenceId?: string;
};

const ENTITY_OF_PREFIX: Record<string, AnchorProblem['entity']> = {
	clip: 'clip',
	cue: 'cue',
	marker: 'marker',
	transition: 'transition',
	track: 'track',
	media: 'media',
	items: 'item',
	sequence: 'sequence',
};

function entityOf(fp: string): AnchorProblem['entity'] {
	return ENTITY_OF_PREFIX[fp.split(':')[0]!] ?? 'other';
}

/** Where an entity is in the document now: its sequence and name / cue kind (bounded lookups). */
function locate(doc: ProjectDocument, id: string): { sequenceId?: string; name?: string; cueKind?: string } {
	for (const [sid, seqRaw] of Object.entries(rec(doc.sequences))) {
		const seq = rec(seqRaw);
		const clip = rec(rec(seq.clips)[id]);
		if (Object.hasOwn(rec(seq.clips), id))
			return { sequenceId: sid, ...(typeof clip.name === 'string' ? { name: clip.name } : {}) };
		const cue = rec(rec(rec(seq.soundDesign).cues)[id]);
		if (Object.hasOwn(rec(rec(seq.soundDesign).cues), id))
			return { sequenceId: sid, ...(typeof cue.kind === 'string' ? { cueKind: cue.kind } : {}) };
		for (const mk of Array.isArray(seq.markers) ? (seq.markers as unknown[]) : []) {
			const m = rec(mk);
			if (m.id === id)
				return { sequenceId: sid, ...(typeof m.name === 'string' && m.name ? { name: m.name } : {}) };
		}
		if (Object.hasOwn(rec(seq.transitions), id)) return { sequenceId: sid };
	}
	return {};
}

const frameAt = (parts: string[], i: number): number | undefined => {
	const n = Number(parts[i]);
	return parts[i] !== undefined && parts[i] !== 'x' && Number.isFinite(n) ? n : undefined;
};

/**
 * The first anchor that no longer holds, described (null when all hold). `opts.sequenceId` is the proposal's sequence
 * (where a deleted entity was); `opts.meta` the item's meta (`{cueId, kind}` names its own cue's kind).
 */
export function anchorProblem(
	doc: ProjectDocument,
	anchors: Record<string, string> | undefined,
	opts: { sequenceId?: string | null; meta?: unknown } = {},
): AnchorProblem | null {
	if (!anchors) return null;
	for (const [id, fp] of Object.entries(anchors)) {
		const now = anchorFingerprint(doc, id);
		if (now === fp) continue;
		const a = fp.split(':');
		const entity = entityOf(fp);
		const where = now === null ? {} : locate(doc, id);
		const meta = rec(opts.meta);
		const cueKind =
			where.cueKind ??
			(entity === 'cue' && meta.cueId === id && typeof meta.kind === 'string' ? meta.kind : undefined);
		const sequenceId = where.sequenceId ?? opts.sequenceId ?? undefined;
		const base: AnchorProblem = {
			id,
			entity,
			change: 'changed',
			...(sequenceId ? { sequenceId } : {}),
			...(where.name ? { name: where.name } : {}),
			...(cueKind ? { cueKind } : {}),
		};
		if (entity === 'clip') {
			const at = frameAt(a, 2);
			const length = frameAt(a, 3);
			if (at !== undefined) base.at = at;
			if (now === null) return { ...base, change: 'deleted' };
			const b = now.split(':');
			if (a[1] !== b[1]) return { ...base, change: 'track' };
			const to = frameAt(b, 2);
			if (a[2] !== b[2]) return { ...base, change: 'start', ...(to !== undefined ? { to } : {}) };
			const lengthTo = frameAt(b, 3);
			if (a[3] !== b[3])
				return {
					...base,
					change: 'length',
					...(length !== undefined ? { length } : {}),
					...(lengthTo !== undefined ? { lengthTo } : {}),
				};
			return { ...base, change: 'retimed' };
		}
		if (entity === 'cue' || entity === 'marker') {
			const at = frameAt(a, 1);
			if (at !== undefined) base.at = at;
			if (now === null) return { ...base, change: 'deleted' };
			const to = frameAt(now.split(':'), 1);
			if (to !== undefined && to !== at) return { ...base, change: 'frame', to };
			return base;
		}
		return { ...base, change: now === null ? 'deleted' : 'changed' };
	}
	return null;
}

/** Timecode of a sequence frame (falls back to the frame number when the sequence is unknown). */
function tcOf(doc: ProjectDocument, sequenceId: string | undefined, frame: number): string {
	const seq = sequenceId ? doc.sequences[sequenceId] : undefined;
	if (!seq) return `frame ${frame}`;
	try {
		return formatTimecode(frame, seq.settings.frameRate as Rational, {
			dropFrame: seq.settings.dropFrame,
			startFrames: seq.settings.startTimecodeFrames,
		});
	} catch {
		return `frame ${frame}`;
	}
}

/**
 * English text of an anchor problem, with timecodes ("The cut cue at 00:00:03:00 moved to 00:00:03:10"); the editor
 * renders `AnchorProblem` in the user's language itself. These are also the reasons agents read.
 */
export function anchorProblemText(doc: ProjectDocument, p: AnchorProblem): string {
	const tc = (f: number | undefined) => (f === undefined ? '' : tcOf(doc, p.sequenceId, f));
	const at = p.at !== undefined ? ` at ${tc(p.at)}` : '';
	const quoted = p.name ? ` “${p.name}”` : '';
	if (p.entity === 'cue') {
		const what = `The ${p.cueKind ? `${p.cueKind} ` : ''}cue${at}`;
		if (p.change === 'deleted') return `${what} was deleted`;
		if (p.change === 'frame' && p.to !== undefined) return `${what} moved to ${tc(p.to)}`;
		return `${what} changed`;
	}
	if (p.entity === 'marker') {
		const what = `The marker${quoted}${at}`;
		if (p.change === 'deleted') return `${what} was deleted`;
		if (p.change === 'frame' && p.to !== undefined) return `${what} moved to ${tc(p.to)}`;
		return `${what} changed`;
	}
	if (p.entity === 'clip') {
		const what = `The clip${quoted}${at}`;
		if (p.change === 'deleted') return `${what} was deleted`;
		if (p.change === 'track') return `${what} moved to another track`;
		if (p.change === 'start' && p.to !== undefined) return `${what} moved to ${tc(p.to)}`;
		if (p.change === 'length' && p.length !== undefined && p.lengthTo !== undefined)
			return `${what} was trimmed (${p.length} → ${p.lengthTo} frames)`;
		return `${what} was trimmed or retimed`;
	}
	const noun =
		p.entity === 'transition'
			? 'A transition it uses'
			: p.entity === 'track'
				? 'A track it uses'
				: p.entity === 'media'
					? 'A media file it uses'
					: p.entity === 'item'
						? 'A project item it uses'
						: p.entity === 'sequence'
							? 'The sequence'
							: `Something it uses (${p.id})`;
	return `${noun} ${p.change === 'deleted' ? 'was deleted' : 'changed'}`;
}

/** Describes why anchors no longer hold ("The cut cue at 00:00:03:00 moved to 00:00:03:10"), or null when all hold. */
export function anchorsProblem(
	doc: ProjectDocument,
	anchors: Record<string, string> | undefined,
	opts: { sequenceId?: string | null; meta?: unknown } = {},
): string | null {
	const p = anchorProblem(doc, anchors, opts);
	return p ? anchorProblemText(doc, p) : null;
}
