// Sound credits (spec 12 §2.1 "Credits", P1-R8): the library sounds a sequence (with everything nested in it) or the
// whole project uses, with their licences and credit lines, as rows and as plain text, Markdown and CSV, plus
// warnings for licences that need a look (non-commercial, no-derivatives, unknown, undeclared user files). Pure.
import type { ProjectDocument } from '../schema/document.ts';
import type { MediaAsset } from '../schema/media.ts';
import { soundDesignSettingsOf } from '../schema/sound.ts';
import { MAX_NEST_DEPTH, nestedClosure } from '../structure/nest.ts';
import { licenseClass, licenseUrlOf, requiresAttribution } from './license.ts';
import { type LibraryProvenance, readLibraryProvenance } from './provenance.ts';

export interface SoundCreditRow {
	/** The media carrying the provenance (for a processed version, its library original). */
	mediaId: string;
	soundId: string;
	title: string;
	author: string;
	license: string;
	/** The provenance's licence URL, else the canonical Creative Commons deed; null when unknown. */
	licenseUrl: string | null;
	sourceUrl: string | null;
	/** The credit line the licence asks for, verbatim. */
	attribution: string | null;
	requiresAttribution: boolean;
	/** Clips that play the sound (in the sequence and the sequences nested in it), sorted. */
	usedIn: string[];
	/** Sequences those clips are in, sorted. */
	sequenceIds: string[];
}

export type SoundCreditWarningCode =
	| 'W_LICENSE_NC'
	| 'W_LICENSE_ND'
	| 'W_LICENSE_UNKNOWN'
	| 'W_USER_PROVIDED'
	| 'W_CREDIT_INCOMPLETE'
	| 'W_SEQUENCE_NOT_FOUND';

export interface SoundCreditWarning {
	code: SoundCreditWarningCode;
	mediaId: string | null;
	message: string;
}

export interface SoundCredits {
	rows: SoundCreditRow[];
	/** Plain text, one credit per line under a heading; empty string when there are no rows. */
	text: string;
	markdown: string;
	/** RFC 4180 CSV with a header row (cells that could start a spreadsheet formula are prefixed with `'`). */
	csv: string;
	warnings: SoundCreditWarning[];
}

export interface SoundCreditsOptions {
	/** Also list library media the clips do not use (only without a sequence id). Default false. */
	includeUnused?: boolean;
	/**
	 * Only the sounds whose licence asks for a credit (CC-BY, CC-BY-SA…: `requiresAttribution`). Warnings still cover
	 * every sound used. Default false.
	 */
	attributionOnly?: boolean;
	/**
	 * Count only these played clips instead of every clip of the sequence (spec 12 §2.11: an export credits the sounds
	 * audible in its range — `playedLibraryClips` of the export's render snapshot: enabled clips on tracks that play,
	 * inside the range, through nested sequences, `nest>inner` ids for clips of nests). With a sequence id only.
	 */
	played?: readonly PlayedClip[];
}

/** A clip the mixer plays (an export's render snapshot), by id and media. */
export interface PlayedClip {
	clipId: string;
	mediaId: string;
}

/**
 * The clips an export's mixer plays (`RenderSnapshot.audioClips`: the range, nested sequences flattened, disabled clips
 * and tracks that never sound left out), without synthetic sources. What `soundCredits(…, {played})` counts.
 */
export function playedLibraryClips(snapshot: { audioClips?: readonly unknown[] }): PlayedClip[] {
	const out: PlayedClip[] = [];
	for (const c of Array.isArray(snapshot?.audioClips) ? snapshot.audioClips : []) {
		const x = c as { clipId?: unknown; mediaId?: unknown; generator?: unknown } | null;
		if (!x || typeof x.clipId !== 'string' || typeof x.mediaId !== 'string' || x.generator) continue;
		if (x.mediaId.startsWith('syn:')) continue;
		out.push({ clipId: x.clipId, mediaId: x.mediaId });
	}
	return out;
}

/** File extension and MIME type of a credits sidecar format. */
export const SOUND_CREDITS_FILE: Readonly<Record<'txt' | 'md' | 'csv', { ext: string; mime: string }>> = {
	txt: { ext: 'txt', mime: 'text/plain; charset=utf-8' },
	md: { ext: 'md', mime: 'text/markdown; charset=utf-8' },
	csv: { ext: 'csv', mime: 'text/csv; charset=utf-8' },
};

/**
 * The credits sidecar an export of a sequence defaults to (spec 12 §2.11, WP5.2 note): the sequence's sound design
 * setting (`soundDesign.settings.credits`) when set (null there = asked for none), else Markdown when a sound the
 * sequence (or a sequence nested in it) uses asks for a credit, else none. The export's own warning
 * (`W_SOUND_CREDITS`) counts only what its range plays. Never throws.
 */
export function defaultCreditsSidecar(doc: ProjectDocument, sequenceId: string): 'txt' | 'md' | 'csv' | null {
	const seq = Object.hasOwn(doc?.sequences ?? {}, sequenceId) ? doc.sequences[sequenceId] : undefined;
	if (!seq) return null;
	const sd = (seq as { soundDesign?: { settings?: { credits?: unknown } } }).soundDesign;
	const configured = sd?.settings && Object.hasOwn(sd.settings, 'credits');
	const set = soundDesignSettingsOf(seq).credits;
	if (configured && (set === null || set === 'txt' || set === 'md' || set === 'csv')) return set ?? null;
	return soundCredits(doc, sequenceId).rows.some((r) => r.requiresAttribution) ? 'md' : null;
}

/** The credits in one file format (`text`, `markdown` or `csv`), ending in a newline; '' when nothing is listed. */
export function soundCreditsFileText(c: SoundCredits, format: 'txt' | 'md' | 'csv'): string {
	if (!c.rows.length) return '';
	const body = format === 'md' ? c.markdown : format === 'csv' ? c.csv : c.text;
	return body.endsWith('\n') ? body : `${body}\n`;
}

/** The media holding library provenance for `mediaId`: itself, or the original of a processed version. */
function provenanceOf(
	doc: Pick<ProjectDocument, 'media'>,
	mediaId: string,
): { mediaId: string; library: LibraryProvenance } | null {
	const seen = new Set<string>();
	let id: string | undefined = mediaId;
	for (let depth = 0; id && depth <= MAX_NEST_DEPTH && !seen.has(id); depth++) {
		seen.add(id);
		const m: MediaAsset | undefined = Object.hasOwn(doc.media, id) ? doc.media[id] : undefined;
		if (!m) return null;
		if ((m as { library?: unknown }).library !== undefined) {
			const library = readLibraryProvenance((m as { library?: unknown }).library);
			if (library) return { mediaId: id, library };
		}
		id = m.derivation?.fromMediaId;
	}
	return null;
}

const cmp = (a: string, b: string) => {
	const x = a.toLowerCase();
	const y = b.toLowerCase();
	return x < y ? -1 : x > y ? 1 : a < b ? -1 : a > b ? 1 : 0;
};
const oneLine = (s: string) => s.replace(/[\r\n\t]+/g, ' ').trim();

/** One plain-text credit for a row (the verbatim attribution when the licence gives one). */
export function creditLine(row: SoundCreditRow): string {
	if (row.attribution?.trim()) return oneLine(row.attribution);
	const parts = [`"${oneLine(row.title) || row.soundId}"`];
	if (row.author.trim()) parts.push(`by ${oneLine(row.author)}`);
	let line = parts.join(' ');
	line += `, ${oneLine(row.license)}`;
	if (row.licenseUrl) line += ` (${oneLine(row.licenseUrl)})`;
	if (row.sourceUrl) line += `. Source: ${oneLine(row.sourceUrl)}`;
	return line;
}

const mdCell = (s: string | null) =>
	s
		? oneLine(s)
				.replace(/\\/g, '\\\\')
				.replace(/[|[\]]/g, (c) => `\\${c}`)
		: '';
/** Only web links become Markdown links (an agent-set `javascript:` URL stays text). */
const isWebUrl = (s: string) => /^https?:\/\/[^\s]+$/i.test(s.trim());
const mdUrl = (s: string) =>
	oneLine(s).replace(/[ ()<>|\\]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
const csvCell = (v: string | boolean | null) => {
	let s = v === null ? '' : String(v);
	if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
	return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * Credits of the library sounds used by `sequenceId` and every sequence nested in it, or by the whole project when
 * no sequence is given (spec 12 §2.1). Every clip with a media reference counts (enabled or not, muted or not: a
 * credit too many is harmless, one missing is not). Processed versions credit their library original. Never throws.
 */
export function soundCredits(
	doc: ProjectDocument,
	sequenceId?: string,
	opts: SoundCreditsOptions = {},
): SoundCredits {
	const warnings: SoundCreditWarning[] = [];
	let seqIds: string[];
	if (sequenceId !== undefined) {
		if (!Object.hasOwn(doc.sequences, sequenceId)) {
			warnings.push({
				code: 'W_SEQUENCE_NOT_FOUND',
				mediaId: null,
				message: `Sequence not found: ${sequenceId}`,
			});
			return { rows: [], text: '', markdown: '', csv: csvOf([]), warnings };
		}
		seqIds = [sequenceId, ...nestedClosure(doc, sequenceId)].filter((s) => Object.hasOwn(doc.sequences, s));
	} else seqIds = Object.keys(doc.sequences);

	const byMedia = new Map<string, { library: LibraryProvenance; clips: Set<string>; seqs: Set<string> }>();
	const count = (mediaId: string, clipId: string, sid: string) => {
		const p = provenanceOf(doc, mediaId);
		if (!p) return;
		let row = byMedia.get(p.mediaId);
		if (!row) {
			row = { library: p.library, clips: new Set(), seqs: new Set() };
			byMedia.set(p.mediaId, row);
		}
		row.clips.add(clipId);
		row.seqs.add(sid);
	};
	if (opts.played && sequenceId !== undefined) {
		for (const c of opts.played.slice(0, 1_000_000))
			if (typeof c?.mediaId === 'string' && typeof c.clipId === 'string')
				count(c.mediaId, c.clipId, sequenceId);
		seqIds = [];
	}
	for (const sid of [...new Set(seqIds)]) {
		const seq = doc.sequences[sid]!;
		for (const c of Object.values(seq.clips ?? {})) {
			const mediaId = (c as { mediaId?: unknown }).mediaId;
			if (typeof mediaId !== 'string') continue;
			count(mediaId, c.id, sid);
		}
	}
	if (sequenceId === undefined && opts.includeUnused)
		for (const m of Object.values(doc.media)) {
			if (byMedia.has(m.id)) continue;
			const library = readLibraryProvenance((m as { library?: unknown }).library);
			if (library) byMedia.set(m.id, { library, clips: new Set(), seqs: new Set() });
		}

	const rows: SoundCreditRow[] = [...byMedia.entries()].map(([mediaId, { library: l, clips, seqs }]) => ({
		mediaId,
		soundId: l.soundId,
		title: l.title,
		author: l.author,
		license: l.license,
		licenseUrl: l.licenseUrl ?? licenseUrlOf(l.license),
		sourceUrl: l.sourceUrl ?? null,
		attribution: l.attribution,
		requiresAttribution: requiresAttribution(l.license),
		usedIn: [...clips].sort(),
		sequenceIds: [...seqs].sort(),
	}));
	rows.sort((a, b) => cmp(a.title, b.title) || cmp(a.mediaId, b.mediaId));
	const listed = opts.attributionOnly ? rows.filter((r) => r.requiresAttribution) : rows;

	for (const r of rows) {
		const name = `"${oneLine(r.title) || r.soundId}" (${r.mediaId})`;
		switch (licenseClass(r.license)) {
			case 'nc':
				warnings.push({
					code: 'W_LICENSE_NC',
					mediaId: r.mediaId,
					message: `${name} is licensed for non-commercial use only (${r.license})`,
				});
				break;
			case 'nd':
				warnings.push({
					code: 'W_LICENSE_ND',
					mediaId: r.mediaId,
					message: `${name} may not be modified (${r.license}): edits, effects and trims may break its licence`,
				});
				break;
			case 'user-provided':
				warnings.push({
					code: 'W_USER_PROVIDED',
					mediaId: r.mediaId,
					message: `${name} comes from your own folder without a licence declaration: make sure you may use it`,
				});
				break;
			case 'unknown':
				warnings.push({
					code: 'W_LICENSE_UNKNOWN',
					mediaId: r.mediaId,
					message: `${name} has an unknown licence (${r.license})`,
				});
				break;
			default:
				break;
		}
		if (r.requiresAttribution && !r.attribution?.trim() && !r.author.trim())
			warnings.push({
				code: 'W_CREDIT_INCOMPLETE',
				mediaId: r.mediaId,
				message: `${name} needs a credit (${r.license}) but names no author or attribution`,
			});
	}

	const text = listed.length ? ['Sound credits', '', ...listed.map(creditLine)].join('\n') : '';
	const markdown = listed.length
		? [
				'## Sound credits',
				'',
				'| Sound | Author | Licence | Source | Credit |',
				'|---|---|---|---|---|',
				...listed.map(
					(r) =>
						`| ${mdCell(r.title || r.soundId)} | ${mdCell(r.author)} | ${
							r.licenseUrl && isWebUrl(r.licenseUrl)
								? `[${mdCell(r.license)}](${mdUrl(r.licenseUrl)})`
								: mdCell(r.license)
						} | ${mdCell(r.sourceUrl)} | ${mdCell(creditLine(r))} |`,
				),
			].join('\n')
		: '';
	return { rows: listed, text, markdown, csv: csvOf(listed), warnings };
}

function csvOf(rows: SoundCreditRow[]): string {
	const header = [
		'mediaId',
		'soundId',
		'title',
		'author',
		'license',
		'licenseUrl',
		'sourceUrl',
		'attribution',
		'requiresAttribution',
		'usedIn',
	];
	const lines = [header.join(',')];
	for (const r of rows)
		lines.push(
			[
				r.mediaId,
				r.soundId,
				r.title,
				r.author,
				r.license,
				r.licenseUrl,
				r.sourceUrl,
				r.attribution,
				r.requiresAttribution,
				r.usedIn.join(' '),
			]
				.map(csvCell)
				.join(','),
		);
	return `${lines.join('\r\n')}\r\n`;
}
