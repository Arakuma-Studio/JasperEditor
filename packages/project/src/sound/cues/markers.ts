// Sequence markers that ask for a sound (spec 12 §2.2): a marker named `sfx: <type>[+<type>]` (any marker type; for
// agent-note markers the comment may carry it too) becomes an explicit cue. Type names are type ids or their
// synonyms (`resolveTypeNames`: `sfx: swoosh+sub drop` → whoosh, boom). Explicit cues are exempt from the rate and gap
// budgets; the hero spacing and `maxCues` still apply.
import { resolveTypeNames } from '../rank.ts';
import { SOUND_TYPES, type SoundTypeId } from '../taxonomy.ts';
import type { CueCandidate } from './types.ts';
import { type CueContext, candidate } from './util.ts';

const SFX = /^\s*sfx\s*:\s*(.*)$/i;

/** The type names of an `sfx:` request (`null` when the text is not one). */
export function parseSfxRequest(text: unknown): { names: string[]; types: SoundTypeId[] } | null {
	if (typeof text !== 'string') return null;
	const line = text.split(/\r?\n/, 1)[0] ?? '';
	const m = SFX.exec(line.slice(0, 500));
	if (!m) return null;
	const names = m[1]!
		.split(/[+,]/)
		.map((s) => s.trim())
		.filter(Boolean)
		.slice(0, 8);
	return { names, types: resolveTypeNames(names) };
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
				weight: info?.defaultWeight ?? 'support',
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
