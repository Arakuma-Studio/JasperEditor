// Sound credits (spec 12 §2.1 "Credits", P1-R8): the library sounds a sequence (with everything nested in it) or the
// whole project uses, with their licences and credit lines, as rows and as plain text, Markdown and CSV, plus
// warnings for licences that need a look (non-commercial, no-derivatives, unknown, undeclared user files). Pure.
import type { ProjectDocument } from '../schema/document.ts';
import type { MediaAsset } from '../schema/media.ts';
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

const mdCell = (s: string | null) => (s ? oneLine(s).replace(/\\/g, '\\\\').replace(/\|/g, '\\|') : '');
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
	for (const sid of [...new Set(seqIds)]) {
		const seq = doc.sequences[sid]!;
		for (const c of Object.values(seq.clips ?? {})) {
			const mediaId = (c as { mediaId?: unknown }).mediaId;
			if (typeof mediaId !== 'string') continue;
			const p = provenanceOf(doc, mediaId);
			if (!p) continue;
			let row = byMedia.get(p.mediaId);
			if (!row) {
				row = { library: p.library, clips: new Set(), seqs: new Set() };
				byMedia.set(p.mediaId, row);
			}
			row.clips.add(c.id);
			row.seqs.add(sid);
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

	const text = rows.length ? ['Sound credits', '', ...rows.map(creditLine)].join('\n') : '';
	const markdown = rows.length
		? [
				'## Sound credits',
				'',
				'| Sound | Author | Licence | Source | Credit |',
				'|---|---|---|---|---|',
				...rows.map(
					(r) =>
						`| ${mdCell(r.title || r.soundId)} | ${mdCell(r.author)} | ${
							r.licenseUrl ? `[${mdCell(r.license)}](${mdUrl(r.licenseUrl)})` : mdCell(r.license)
						} | ${mdCell(r.sourceUrl)} | ${mdCell(creditLine(r))} |`,
				),
			].join('\n')
		: '';
	return { rows, text, markdown, csv: csvOf(rows), warnings };
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
