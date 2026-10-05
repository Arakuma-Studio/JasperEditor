// Semantic addressing for agents (S01:AGT-005, S02:TL-952): agents may name things instead of computing
// ids. Resolved before validation, so the command schemas only ever see ids:
//   { "mediaByName": "interview_A.mov" }          → the media id (E_AMBIGUOUS when not unique)
//   { "clipAt": { "track": "V1", "at": "00:00:01:00" } } → the clip covering that frame on that track
//   { "markerByName": "Intro" }                     → the sequence marker id
// Used as an id value (`"mediaId": {"mediaByName": …}`) the object is replaced by the id. Inside another
// object (`"source": {"mediaByName": …}`) the key is rewritten to `mediaId` / `clipId` / `markerId`.
// Track labels ("V2"), temp refs ("$title") and "$selection" are resolved later by applyTransaction.

import type { Issue } from '../commands/types.ts';
import { clipAt as clipAtFrame, resolveTrackRef } from '../derive/index.ts';
import type { ProjectDocument } from '../schema/document.ts';
import type { Sequence } from '../schema/sequence.ts';
import { type Rational, secondsToFrames } from '../time.ts';
import { parseTimecode } from '../timecode.ts';

export class AddressError extends Error {
	constructor(
		readonly code: 'E_NOT_FOUND' | 'E_AMBIGUOUS' | 'E_INVALID_PARAM',
		message: string,
	) {
		super(message);
		this.name = 'AddressError';
	}
}

const ADDRESS_KEYS = { mediaByName: 'mediaId', clipAt: 'clipId', markerByName: 'markerId' } as const;
type AddressKey = keyof typeof ADDRESS_KEYS;

/** Sequence time input (frames, {frames}, {seconds}, timecode) → frame, like the command handlers. */
export function resolveFrameInput(seq: Sequence, input: unknown): number {
	const rate = seq.settings.frameRate as Rational;
	if (typeof input === 'number' && Number.isFinite(input)) return Math.round(input);
	if (typeof input === 'string') {
		const f = parseTimecode(input, rate, {
			dropFrame: input.includes(';') || seq.settings.dropFrame,
			startFrames: seq.settings.startTimecodeFrames,
		});
		if (f === null) throw new AddressError('E_INVALID_PARAM', `Invalid timecode: ${input}`);
		return f;
	}
	if (input && typeof input === 'object') {
		const o = input as { frames?: unknown; seconds?: unknown };
		if (typeof o.frames === 'number') return Math.round(o.frames);
		if (typeof o.seconds === 'number') return secondsToFrames(o.seconds, rate, 'round');
	}
	throw new AddressError('E_INVALID_PARAM', `Invalid time: ${JSON.stringify(input)}`);
}

/** The sequence a query/command addresses: explicit id, else the only one, else the fallback. */
export function pickSequence(
	doc: ProjectDocument,
	sequenceId?: string | null,
	fallback?: string | null,
): Sequence {
	if (sequenceId) {
		const s = doc.sequences[sequenceId];
		if (!s) throw new AddressError('E_NOT_FOUND', `Sequence not found: ${sequenceId}`);
		return s;
	}
	if (fallback && doc.sequences[fallback]) return doc.sequences[fallback]!;
	const all = Object.values(doc.sequences);
	if (all.length === 0) throw new AddressError('E_NOT_FOUND', 'The project has no sequence');
	if (all.length > 1 && !fallback)
		throw new AddressError('E_AMBIGUOUS', 'sequenceId is required when the project has several sequences');
	return all[0]!;
}

/** Media id by project item name (or original file name) when unique (S01:AGT-005). */
function mediaIdByName(doc: ProjectDocument, name: string): string {
	const byItem = new Set<string>();
	for (const item of Object.values(doc.items))
		if (item.kind === 'media' && item.name === name) byItem.add(item.mediaId);
	const ids = byItem.size
		? byItem
		: new Set(
				Object.values(doc.media)
					.filter((m) => m.originalName === name)
					.map((m) => m.id),
			);
	if (ids.size === 0) throw new AddressError('E_NOT_FOUND', `No media named "${name}"`);
	if (ids.size > 1)
		throw new AddressError('E_AMBIGUOUS', `"${name}" names ${ids.size} media assets: ${[...ids].join(', ')}`);
	return [...ids][0]!;
}

function clipIdAt(doc: ProjectDocument, spec: unknown, sequenceId?: string): string {
	if (!spec || typeof spec !== 'object')
		throw new AddressError('E_INVALID_PARAM', 'clipAt needs {track, at}');
	const s = spec as { track?: unknown; at?: unknown; sequenceId?: unknown };
	const seq = pickSequence(doc, typeof s.sequenceId === 'string' ? s.sequenceId : sequenceId);
	if (typeof s.track !== 'string') throw new AddressError('E_INVALID_PARAM', 'clipAt.track is required');
	const trackId = resolveTrackRef(seq, s.track);
	if (!trackId) throw new AddressError('E_NOT_FOUND', `Track not found: ${s.track}`);
	const frame = resolveFrameInput(seq, s.at);
	const clip = clipAtFrame(seq, trackId, frame);
	if (!clip) throw new AddressError('E_NOT_FOUND', `No clip on ${s.track} at ${JSON.stringify(s.at)}`);
	return clip.id;
}

function markerIdByName(doc: ProjectDocument, name: unknown, sequenceId?: string): string {
	if (typeof name !== 'string') throw new AddressError('E_INVALID_PARAM', 'markerByName must be a string');
	const seqs = sequenceId ? [pickSequence(doc, sequenceId)] : Object.values(doc.sequences);
	const hits = seqs.flatMap((s) => s.markers.filter((m) => m.name === name).map((m) => m.id));
	if (hits.length === 0) throw new AddressError('E_NOT_FOUND', `No marker named "${name}"`);
	if (hits.length > 1) throw new AddressError('E_AMBIGUOUS', `"${name}" names ${hits.length} markers`);
	return hits[0]!;
}

function addressKeyOf(o: Record<string, unknown>): AddressKey | null {
	for (const k of Object.keys(ADDRESS_KEYS) as AddressKey[]) if (k in o) return k;
	return null;
}

function resolveAddress(doc: ProjectDocument, key: AddressKey, value: unknown, sequenceId?: string): string {
	switch (key) {
		case 'mediaByName':
			if (typeof value !== 'string')
				throw new AddressError('E_INVALID_PARAM', 'mediaByName must be a string');
			return mediaIdByName(doc, value);
		case 'clipAt':
			return clipIdAt(doc, value, sequenceId);
		case 'markerByName':
			return markerIdByName(doc, value, sequenceId);
	}
}

function walk(doc: ProjectDocument, v: unknown, parentKey: string | null, sequenceId?: string): unknown {
	if (Array.isArray(v)) return v.map((x) => walk(doc, x, parentKey, sequenceId));
	if (!v || typeof v !== 'object') return v;
	const o = v as Record<string, unknown>;
	const key = addressKeyOf(o);
	if (key) {
		const id = resolveAddress(doc, key, o[key], sequenceId);
		const rest = { ...o };
		delete rest[key];
		// As a bare id value (`mediaId: {...}`, `clipIds: [{...}]`) the whole object becomes the id.
		if (Object.keys(rest).length === 0 && parentKey !== null && /(Id|Ids|target|track)$/.test(parentKey))
			return id;
		return { [ADDRESS_KEYS[key]]: id, ...rest };
	}
	let changed = false;
	const out: Record<string, unknown> = {};
	for (const [k, x] of Object.entries(o)) {
		// Text content is user data, a clipboard payload is another document's data, an effect preset (S03:FX-030)
		// is library data: never rewrite inside them.
		const next =
			k === 'content' || k === 'comment' || k === 'payload' || k === 'preset'
				? x
				: walk(doc, x, k, sequenceId);
		if (next !== x) changed = true;
		out[k] = next;
	}
	return changed ? out : o;
}

/**
 * Rewrites semantic addresses in the commands of a transaction. Returns the new command list, or the
 * first failure as an Issue (`commandIndex` set) so the caller can reject the transaction atomically.
 */
export function resolveAgentAddresses(
	doc: ProjectDocument,
	commands: readonly unknown[],
	opts: { sequenceId?: string } = {},
): { ok: true; commands: unknown[] } | { ok: false; errors: Issue[] } {
	const out: unknown[] = [];
	for (let i = 0; i < commands.length; i++) {
		try {
			const c = commands[i] as { sequenceId?: unknown };
			const seqId = typeof c?.sequenceId === 'string' ? c.sequenceId : opts.sequenceId;
			out.push(walk(doc, commands[i], null, seqId));
		} catch (e) {
			if (e instanceof AddressError)
				return { ok: false, errors: [{ commandIndex: i, code: e.code, message: e.message }] };
			throw e;
		}
	}
	return { ok: true, commands: out };
}
