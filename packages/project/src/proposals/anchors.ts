// What a proposal item was built against (spec 12 §2.5: "ghosts follow their anchors"; accept reports stale items).
// At validation every entity id an item's commands name is recorded with a fingerprint of where that entity was;
// `revalidate` compares them with the current document: an anchor that is gone or moved makes the item stale.
import { canonicalJson } from '../canonical-json.ts';
import { looksLikeId } from '../ids.ts';
import type { ProjectDocument } from '../schema/document.ts';

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
		for (const key of ['links', 'groups'])
			for (const id of Object.keys(rec(seq[key]))) m.set(id, key);
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

/** Describes why anchors no longer hold ("clp_… was deleted", "clp_… moved"), or null when all hold. */
export function anchorsProblem(doc: ProjectDocument, anchors: Record<string, string> | undefined): string | null {
	if (!anchors) return null;
	for (const [id, fp] of Object.entries(anchors)) {
		const now = anchorFingerprint(doc, id);
		if (now === null) return `${id} no longer exists`;
		if (now !== fp) return `${id} changed since the proposal was made (${describeMove(fp, now)})`;
	}
	return null;
}

function describeMove(before: string, after: string): string {
	const a = before.split(':');
	const b = after.split(':');
	if (a[0] === 'clip' && b[0] === 'clip') {
		if (a[1] !== b[1]) return 'moved to another track';
		if (a[2] !== b[2]) return `start ${a[2]} → ${b[2]}`;
		if (a[3] !== b[3]) return `length ${a[3]} → ${b[3]}`;
		return 'trimmed or retimed';
	}
	if ((a[0] === 'cue' || a[0] === 'marker') && a[1] !== b[1]) return `frame ${a[1]} → ${b[1]}`;
	return 'moved';
}
