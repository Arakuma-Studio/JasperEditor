// Sequence markers that ask for a sound (spec 12 §2.2): a marker named `sfx: <type>[+<type>]` (any marker type; for
// agent-note markers the comment may carry it too) becomes an explicit cue. Type names are type ids or their
// synonyms (`resolveTypeNames`: `sfx: swoosh+sub drop` → whoosh, boom). Explicit cues are exempt from the rate and gap
// budgets; the hero spacing and `maxCues` still apply.
import { readLibraryProvenance } from '../provenance.ts';
import { resolveTypeNames } from '../rank.ts';
import { soundCuesOf } from '../repair.ts';
import { SOUND_TYPES, type SoundTypeId, type SoundWeight } from '../taxonomy.ts';
import type { CueCandidate } from './types.ts';
import { type CueContext, candidate } from './util.ts';

const SFX = /^\s*sfx\s*:\s*(.*)$/i;
/** A trailing `(hero)` / `(support)` / `(ambient)`: the cue's weight (`SFX: whoosh+hit (hero)`, interchange markers). */
const WEIGHT_SUFFIX = /\(\s*(hero|support|ambient)\s*\)\s*$/i;

/** The type names of an `sfx:` request (`null` when the text is not one), and its weight when it names one. */
export function parseSfxRequest(
	text: unknown,
): { names: string[]; types: SoundTypeId[]; weight?: SoundWeight } | null {
	if (typeof text !== 'string') return null;
	const line = text.split(/\r?\n/, 1)[0] ?? '';
	const m = SFX.exec(line.slice(0, 500));
	if (!m) return null;
	let rest = m[1]!;
	const w = WEIGHT_SUFFIX.exec(rest);
	if (w) rest = rest.slice(0, w.index);
	const names = rest
		.split(/[+,]/)
		.map((s) => s.trim())
		.filter(Boolean)
		.slice(0, 8);
	return {
		names,
		types: resolveTypeNames(names),
		...(w ? { weight: w[1]!.toLowerCase() as SoundWeight } : {}),
	};
}

/** A sequence marker standing for a sound cue in an interchange export (spec 12 §2.11). */
export interface CueMarker {
	cueId: string;
	frame: number;
	/** `SFX: <type>[+<type>] (<weight>)`, read back by `parseSfxRequest` (Convert Markers to Cues). */
	name: string;
	/** The cue's label and reason (and "muted" for a muted cue). */
	comment: string;
	/** Always 0: a point at the cue frame. */
	duration: number;
}

const TYPE_WORD = /^[a-z][a-z0-9-]{0,39}$/;
const oneLine = (s: unknown) => (typeof s === 'string' ? s.replace(/[\r\n\t]+/g, ' ').trim() : '');

/**
 * The markers an interchange export writes for the cues of a sequence (spec 12 §2.11): one per cue, in frame order,
 * named `SFX: <type>[+<type>] (<weight>)` — the cue's types, else the library types of the sounds placed on it, else its
 * kind — so a re-import can turn them back into cues (Convert Markers to Cues). Cues made from a marker the sequence
 * still has are skipped (that marker is exported already). Never throws.
 */
export function cueMarkers(
	doc: { media?: Record<string, unknown> },
	seq: { soundDesign?: unknown; markers?: readonly { id?: unknown }[]; clips?: Record<string, unknown> },
): CueMarker[] {
	const markerIds = new Set((Array.isArray(seq?.markers) ? seq.markers : []).map((m) => m?.id));
	const out: CueMarker[] = [];
	for (const c of soundCuesOf(seq ?? {})) {
		if (!c || typeof c.id !== 'string' || !Number.isInteger(c.frame) || c.frame < 0) continue;
		const anchor = c.anchor as { type?: unknown; markerId?: unknown } | null | undefined;
		if (anchor?.type === 'marker' && markerIds.has(anchor.markerId)) continue;
		let types = (Array.isArray(c.types) ? c.types : []).filter(
			(t): t is string => typeof t === 'string' && TYPE_WORD.test(t),
		);
		if (!types.length)
			for (const id of Array.isArray(c.placedClipIds) ? c.placedClipIds : []) {
				const clip = seq.clips?.[id] as { mediaId?: unknown } | undefined;
				const media = typeof clip?.mediaId === 'string' ? doc.media?.[clip.mediaId] : undefined;
				const lib = readLibraryProvenance((media as { library?: unknown } | undefined)?.library);
				for (const t of lib?.types ?? []) if (TYPE_WORD.test(t) && !types.includes(t)) types.push(t);
				if (types.length) break;
			}
		if (!types.length && typeof c.kind === 'string' && TYPE_WORD.test(c.kind)) types = [c.kind];
		const weight = c.weight === 'hero' || c.weight === 'ambient' ? c.weight : 'support';
		const name = `SFX: ${(types.length ? types : ['sound']).slice(0, 8).join('+')} (${weight})`;
		const comment = [oneLine(c.label), oneLine(c.reason), c.muted ? 'muted' : '']
			.filter(Boolean)
			.join(' · ')
			.slice(0, 2000);
		// a point marker at the aligned frame (a cue's window is not carried: re-imported, it would start at the cue)
		out.push({ cueId: c.id, frame: c.frame, name, comment, duration: 0 });
	}
	return out.sort((a, b) => a.frame - b.frame || (a.cueId < b.cueId ? -1 : a.cueId > b.cueId ? 1 : 0));
}

export function deriveMarkerCues(ctx: CueContext): CueCandidate[] {
	const cues: CueCandidate[] = [];
	const markers = Array.isArray(ctx.seq.markers) ? ctx.seq.markers : [];
	for (const m of markers) {
		if (!m || typeof m.id !== 'string' || !Number.isInteger(m.frame)) continue;
		const req = parseSfxRequest(m.name) ?? (m.type === 'agent-note' ? parseSfxRequest(m.comment) : null);
		if (!req) continue;
		if (m.frame < ctx.range.start || m.frame >= ctx.range.end) continue;
		const first = req.types[0];
		const info = first ? SOUND_TYPES[first] : undefined;
		const unknown = req.names.filter((n) => resolveTypeNames([n]).length === 0);
		const dur = Number.isInteger(m.duration) && m.duration > 0 ? m.duration : 0;
		const who = m.type === 'agent-note' ? 'Agent note' : 'Marker';
		cues.push(
			candidate('markers', {
				key: `marker:${m.id}`,
				frame: m.frame,
				kind: 'manual',
				weight: req.weight ?? info?.defaultWeight ?? 'support',
				types: req.types,
				align: info?.defaultAlign ?? 'peak',
				anchor: { type: 'marker', markerId: m.id },
				confidence: 1,
				reason: `${who} '${String(m.name).slice(0, 60)}' asks for ${req.types.length ? req.types.join(' + ') : 'a sound'}${
					unknown.length ? ` (unknown: ${unknown.join(', ')})` : ''
				}`,
				...(dur ? { window: { start: m.frame, end: m.frame + dur } } : {}),
				source: 'marker',
				size: 1,
				explicit: true,
			}),
		);
	}
	return cues;
}
