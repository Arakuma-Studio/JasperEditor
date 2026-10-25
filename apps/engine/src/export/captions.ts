// wp captions: caption output of exports (S04:TR-061/062). Burn-in is a snapshot option (caption tracks drawn as
// layers: hybrid layer-bake on the native path, the composition on the Remotion path); embedded streams are muxed
// into the finished file by a stream-copy remux (`mov_text` in MP4/MOV, WebVTT in WebM); sidecars are written next
// to the output. Every cue comes from `captionCuesForTrack`, the function the preview draws from, in output time.
import type { ExportCaptions, ExportSettings } from '@jasper/api';
import {
	activeCaptionTrack,
	CAPTION_FORMAT_INFO,
	type CaptionDocument,
	type CaptionFileFormat,
	captionCuesForGroup,
	captionCuesForTrack,
	captionGroupsOf,
	type ProjectDocument,
	resolveTrackRef,
	type Sequence,
	type SnapshotOptions,
	supportsDropFrame,
	type Track,
	writeCaptionFileBytes,
} from '@jasper/project';

/** Which caption tracks the snapshot burns in. */
export function captionBurnMode(
	settings: Pick<ExportSettings, 'captions'>,
): NonNullable<SnapshotOptions['captions']> {
	const b = settings.captions?.burnIn;
	if (b === undefined || b === true) return 'visible';
	if (b === false) return 'none';
	return b;
}

/**
 * spec 13 AS-005: a subtitle group of text clips exports like a caption track. Its stand-in track carries the
 * group's id, name and language (the cues come from `captionCuesForGroup`).
 */
function groupTrack(seq: Sequence, groupId: string): Track | null {
	const g = captionGroupsOf(seq)[groupId];
	if (!g) return null;
	return { id: g.id, kind: 'caption', name: g.name, language: g.language, locked: false, syncLock: false } as Track;
}

const isGroup = (seq: Sequence, t: Track) => !seq.captionTracks.includes(t) && !!captionGroupsOf(seq)[t.id];

function resolveTracks(seq: Sequence, refs: readonly string[]): Track[] {
	const out: Track[] = [];
	for (const r of refs) {
		const id = resolveTrackRef(seq, r);
		const t = seq.captionTracks.find((x) => x.id === id) ?? groupTrack(seq, r);
		if (!t) throw new CaptionExportError(`Caption track or subtitle group not found: ${r}`);
		if (!out.some((x) => x.id === t.id)) out.push(t);
	}
	return out;
}

/** Every caption track, then every subtitle group of text clips. */
function allSources(seq: Sequence): Track[] {
	return [
		...seq.captionTracks,
		...Object.keys(captionGroupsOf(seq))
			.map((id) => groupTrack(seq, id))
			.filter((t): t is Track => !!t),
	];
}

export class CaptionExportError extends Error {
	readonly code = 'CAPTIONS_INVALID';
}

/** Active track first, then C1…Cn, then subtitle groups (in their order). */
function ordered(seq: Sequence, tracks: Track[]): Track[] {
	const active = activeCaptionTrack(seq);
	const groups = Object.keys(captionGroupsOf(seq));
	const rank = (t: Track) => {
		const i = seq.captionTracks.indexOf(t);
		return i >= 0 ? i : seq.captionTracks.length + groups.indexOf(t.id);
	};
	return [...tracks].sort((a, b) =>
		a.id === active?.id ? -1 : b.id === active?.id ? 1 : rank(a) - rank(b),
	);
}

export type CaptionTrackOutput = {
	track: Track;
	label: string;
	name: string;
	language: string;
	doc: CaptionDocument;
};

function trackOutput(
	doc: ProjectDocument,
	seq: Sequence,
	t: Track,
	range: { start: number; end: number },
): CaptionTrackOutput {
	if (isGroup(seq, t)) {
		const label = `S${Object.keys(captionGroupsOf(seq)).indexOf(t.id) + 1}`;
		return {
			track: t,
			label,
			name: t.name ?? `Subtitles ${label}`,
			language: t.language ?? 'und',
			doc: { cues: captionCuesForGroup(seq, t.id, range), blocks: [], warnings: [] },
		};
	}
	const i = seq.captionTracks.indexOf(t);
	const label = `C${i + 1}`;
	return {
		track: t,
		label,
		name: t.name ?? `Subtitles ${label}`,
		language: t.language ?? 'und',
		doc: { cues: captionCuesForTrack(doc, seq, t.id, range), blocks: [...(t.vttBlocks ?? [])], warnings: [] },
	};
}

/** Tracks embedded as streams (empty tracks skipped). */
export function embeddedTracks(
	doc: ProjectDocument,
	seq: Sequence,
	c: ExportCaptions | undefined,
	range: { start: number; end: number },
): CaptionTrackOutput[] {
	if (!c?.embed) return [];
	const list = c.embed === true ? allSources(seq) : resolveTracks(seq, c.embed);
	return ordered(seq, list)
		.map((t) => trackOutput(doc, seq, t, range))
		.filter((o) => o.doc.cues.length > 0);
}

/** Tracks written as sidecars (with at least one cue in range). */
export function sidecarTracks(
	doc: ProjectDocument,
	seq: Sequence,
	c: ExportCaptions | undefined,
	range: { start: number; end: number },
): CaptionTrackOutput[] {
	if (!c?.sidecar?.length) return [];
	const sel = c.sidecarTracks ?? 'active';
	// "active": the active caption track; without caption tracks, the first subtitle group of text clips
	const firstGroup = () => allSources(seq).slice(seq.captionTracks.length, seq.captionTracks.length + 1);
	const list =
		sel === 'all'
			? allSources(seq)
			: sel === 'active'
				? seq.captionTracks.length
					? [activeCaptionTrack(seq)].filter((t): t is Track => !!t)
					: firstGroup()
				: resolveTracks(seq, sel);
	return ordered(seq, list)
		.map((t) => trackOutput(doc, seq, t, range))
		.filter((o) => o.doc.cues.length > 0);
}

/** Validates the caption settings against the document (unknown tracks → error); returns plan warnings. */
export function captionPlanWarnings(
	doc: ProjectDocument,
	seq: Sequence,
	settings: Pick<ExportSettings, 'captions'>,
	range: { start: number; end: number },
): Array<{ code: string; message: string; itemIds?: string[] }> {
	const c = settings.captions;
	const out: Array<{ code: string; message: string; itemIds?: string[] }> = [];
	if (Array.isArray(c?.burnIn)) resolveTracks(seq, c.burnIn);
	if (c?.embed && embeddedTracks(doc, seq, c, range).length === 0)
		out.push({ code: 'NO_CAPTIONS', message: 'No captions in the export range to embed' });
	if (c?.sidecar?.length && sidecarTracks(doc, seq, c, range).length === 0)
		out.push({ code: 'NO_CAPTIONS', message: 'No captions in the export range to write as sidecar files' });
	return out;
}

/** ISO 639-1 → ISO 639-2/B (MP4/MOV language atoms); 3-letter codes pass through; unknown → `und`. */
const ISO639: Record<string, string> = {
	ar: 'ara',
	bg: 'bul',
	ca: 'cat',
	cs: 'ces',
	da: 'dan',
	de: 'deu',
	el: 'ell',
	en: 'eng',
	es: 'spa',
	et: 'est',
	fa: 'fas',
	fi: 'fin',
	fr: 'fra',
	he: 'heb',
	hi: 'hin',
	hr: 'hrv',
	hu: 'hun',
	id: 'ind',
	is: 'isl',
	it: 'ita',
	ja: 'jpn',
	ko: 'kor',
	lt: 'lit',
	lv: 'lav',
	ms: 'msa',
	nb: 'nob',
	nl: 'nld',
	no: 'nor',
	pl: 'pol',
	pt: 'por',
	ro: 'ron',
	ru: 'rus',
	sk: 'slk',
	sl: 'slv',
	sr: 'srp',
	sv: 'swe',
	th: 'tha',
	tr: 'tur',
	uk: 'ukr',
	vi: 'vie',
	zh: 'zho',
	cy: 'cym',
	ga: 'gle',
	eu: 'eus',
	gl: 'glg',
	ta: 'tam',
	te: 'tel',
	bn: 'ben',
	ur: 'urd',
	sw: 'swa',
};

function iso639_2(lang: string): string {
	const base = lang.toLowerCase().split(/[-_]/)[0] ?? '';
	if (/^[a-z]{3}$/.test(base)) return base;
	return ISO639[base] ?? 'und';
}

/** Subtitle codec of an embedded stream in a container. */
export function subtitleCodecFor(container: string): 'mov_text' | 'webvtt' {
	return container === 'webm' ? 'webvtt' : 'mov_text';
}

/**
 * ffmpeg arguments that remux `input` with the caption files (WebVTT, one per track) as subtitle streams into
 * `output` (stream copy for picture and sound).
 */
export function embedArgs(
	input: string,
	files: ReadonlyArray<{ path: string; language: string; title: string }>,
	container: string,
	output: string,
): string[] {
	const codec = subtitleCodecFor(container);
	const args = ['-i', input];
	for (const f of files) args.push('-f', 'webvtt', '-i', f.path);
	args.push('-map', '0:v?', '-map', '0:a?');
	for (let i = 0; i < files.length; i++) args.push('-map', `${i + 1}:0`);
	args.push('-c:v', 'copy', '-c:a', 'copy', '-c:s', codec);
	files.forEach((f, i) => {
		args.push(`-metadata:s:s:${i}`, `language=${iso639_2(f.language)}`);
		args.push(`-metadata:s:s:${i}`, `title=${f.title}`);
		// MP4/MOV keep a track name in the handler (shown as the title by players)
		if (container !== 'webm') args.push(`-metadata:s:s:${i}`, `handler_name=${f.title}`);
		args.push(`-disposition:s:${i}`, i === 0 ? 'default' : '0');
	});
	if (container !== 'webm') args.push('-movflags', '+faststart');
	args.push('-f', container === 'mov' ? 'mov' : container, output);
	return args;
}

/** A sidecar file's bytes. */
export function sidecarBytes(
	o: CaptionTrackOutput,
	format: CaptionFileFormat,
	seq: Sequence,
	dropFrame: boolean | undefined,
): Uint8Array {
	return writeCaptionFileBytes(o.doc, format, {
		dropFrame: dropFrame ?? (supportsDropFrame(seq.settings.frameRate) ? seq.settings.dropFrame : true),
		rate: seq.settings.frameRate,
		language: o.language === 'und' ? 'en' : o.language,
	});
}

/** File name of a sidecar: `<stem>.<label-or-language>.<ext>` (`<stem>.<ext>` when there is one track). */
export function sidecarName(
	stem: string,
	o: CaptionTrackOutput,
	format: CaptionFileFormat,
	single: boolean,
): string {
	const ext = CAPTION_FORMAT_INFO[format].extension;
	if (single) return `${stem}.${ext}`;
	const tag = (o.track.language ?? o.label).replace(/[^A-Za-z0-9_-]/g, '_');
	return `${stem}.${o.label}${tag !== o.label ? `.${tag}` : ''}.${ext}`;
}
