// Avid Log Exchange (`.ale`): a tab-delimited clip log (Avid Media Composer File ▸ Export ▸ ALE; DaVinci Resolve and
// Premiere Pro read and write it too).
//
// Written from Avid's published description of the format: three sections introduced by a line holding only
// `Heading`, `Column` or `Data`, separated by blank lines; heading fields `FIELD_DELIM TABS`, `VIDEO_FORMAT`,
// `AUDIO_FORMAT`, `FPS`; data rows of tab-separated values. `Tracks` lists the clip's tracks (`V`, `A1`…`A16`);
// `Start` and `End` are SMPTE timecode at the heading's `FPS`, `End` exclusive. Values never contain tabs or line
// breaks (replaced by spaces). Lines end with CR LF; the reader accepts LF and CR too.
//
// Import creates one media item per row (offline until linked; `Source File` / `Source Path` when present).
// Export logs the media the sequence uses (or every media item of the project), with their start timecode,
// tracks, tape and the other columns the import kept.
//
// Port of FilmCraft `crates/interchange/src/ale.rs` (MIT OR Apache-2.0), extended (import, extra columns kept).
import { Builder } from './build.ts';
import type { IMedia, IProject, Rate } from './model.ts';
import type { ExportOptions, ImportOptions } from './options.ts';
import { resolvePath } from './paths.ts';
import { InterchangeError, parseError, type Report } from './report.ts';
import { flicksToFrames, formatTc, fps, framesToFlicks, parseTc, RATE_24, rateFromFloat } from './time.ts';

const FORMAT = 'Avid ALE';

export function sniffAle(head: string): boolean {
	const lines = head.split(/\r\n|\r|\n/).map((l) => l.trim());
	return lines[0] === 'Heading' || (lines.includes('Heading') && lines.includes('Column'));
}

export type AleDoc = { heading: [string, string][]; columns: string[]; rows: string[][] };

const clean = (s: string) => s.replace(/[\t\r\n]/g, ' ');

export function parseAle(text: string): AleDoc {
	const doc: AleDoc = { heading: [], columns: [], rows: [] };
	let section: 'none' | 'heading' | 'column' | 'data' = 'none';
	let seenHeading = false;
	for (const raw of text.split(/\r\n|\r|\n/)) {
		const t = raw.trim();
		if (t === 'Heading') {
			section = 'heading';
			seenHeading = true;
			continue;
		}
		if (t === 'Column') {
			section = 'column';
			continue;
		}
		if (t === 'Data') {
			section = 'data';
			continue;
		}
		if (!t) continue;
		if (section === 'heading') {
			const i = raw.indexOf('\t');
			const [k, v] =
				i >= 0 ? [raw.slice(0, i), raw.slice(i + 1)] : (raw.trim().split(/\s+(.*)/) as [string, string]);
			doc.heading.push([(k ?? '').trim(), (v ?? '').trim()]);
		} else if (section === 'column') {
			if (!doc.columns.length)
				doc.columns = raw
					.split('\t')
					.map((c) => c.trim())
					.filter((c, i, a) => c || i < a.length - 1);
		} else if (section === 'data') doc.rows.push(raw.split('\t').map((c) => c.trim()));
	}
	if (!seenHeading) throw parseError(FORMAT, 'no Heading section');
	if (!doc.columns.length) throw parseError(FORMAT, 'no Column section');
	return doc;
}

const col = (doc: AleDoc, row: string[], name: string): string | null => {
	const i = doc.columns.findIndex((c) => c.toLowerCase() === name.toLowerCase());
	return i >= 0 ? (row[i] ?? null) : null;
};

export function importAle(text: string, opts: ImportOptions, report: Report): IProject {
	const doc = parseAle(text);
	const fpsText = doc.heading.find(([k]) => k.toUpperCase() === 'FPS')?.[1];
	const rate =
		opts.rate ?? (fpsText && Number(fpsText) > 0 ? rateFromFloat(Number(fpsText)) : null) ?? RATE_24;
	if (!fpsText && !opts.rate) report.info('the ALE heading has no FPS; 24 fps was assumed');
	const vf = (doc.heading.find(([k]) => k.toUpperCase() === 'VIDEO_FORMAT')?.[1] ?? '').toUpperCase();
	const height = vf === '720' ? 720 : vf === 'NTSC' ? 486 : vf === 'PAL' ? 576 : vf === '2160' ? 2160 : 1080;
	const width = height === 486 ? 720 : height === 576 ? 720 : Math.round((height * 16) / 9);
	const af = (doc.heading.find(([k]) => k.toUpperCase() === 'AUDIO_FORMAT')?.[1] ?? '').toLowerCase();
	const sampleRate = af.startsWith('44') ? 44100 : af.startsWith('96') ? 96000 : 48000;
	const b = new Builder(opts.name ?? 'Avid Log');
	const bin = b.bin(opts.name ?? 'Avid Log');
	const df = (s: string | null) => !!s && s.includes(';');
	doc.rows.forEach((row, i) => {
		const name = col(doc, row, 'Name') || `Clip ${i + 1}`;
		const start = col(doc, row, 'Start');
		const end = col(doc, row, 'End');
		const dur = col(doc, row, 'Duration');
		const s0 = start ? parseTc(start, rate, df(start)) : null;
		let len: number | null = null;
		if (s0 !== null && end) {
			const e = parseTc(end, rate, df(end));
			if (e !== null && e > s0) len = e - s0;
		}
		if (len === null && dur) {
			const d = parseTc(dur, rate, df(dur));
			if (d !== null && d > 0) len = d;
		}
		const tracks = (col(doc, row, 'Tracks') ?? 'VA1A2').toUpperCase();
		const hasV = tracks.includes('V');
		const ch = (tracks.match(/A\d+/g) ?? []).length;
		const file = col(doc, row, 'Source File') || col(doc, row, 'Source Path') || col(doc, row, 'Filepath');
		const pathCol = col(doc, row, 'Source Path');
		const fullFile =
			file && pathCol && file !== pathCol && !/[\\/]/.test(file)
				? `${pathCol.replace(/[\\/]$/, '')}/${file}`
				: file;
		const path = fullFile ? resolvePath(fullFile, opts.baseDir) : null;
		const extra: Record<string, string> = {};
		doc.columns.forEach((c, k) => {
			if (
				!['name', 'tracks', 'start', 'end', 'duration', 'tape', 'source file'].includes(c.toLowerCase()) &&
				row[k]
			)
				extra[c] = row[k]!;
		});
		const media: Partial<IMedia> & { name: string } = {
			name,
			kind: hasV ? 'video' : 'audio',
			path,
			duration: len !== null ? framesToFlicks(len, rate) : null,
			...(hasV ? { video: { width, height, rate } } : {}),
			...(ch ? { audio: { sampleRate, channels: ch } } : {}),
			...(s0 !== null ? { timecode: { frames: s0, rate, dropFrame: df(start) } } : {}),
			reel: col(doc, row, 'Tape') || null,
			offline: !path,
			...(Object.keys(extra).length ? { jasper: { ale: extra } } : {}),
		};
		b.media(`ale:${i}:${path ?? name}`, media as never, bin);
	});
	if (!doc.rows.length) throw new InterchangeError('EMPTY', 'the ALE has no data rows');
	return b.finish();
}

/** `FPS` heading text for a rate. */
function fpsText(r: Rate): string {
	const f = fps(r);
	return Math.abs(f - Math.round(f)) < 1e-6 ? String(Math.round(f)) : f.toFixed(3).replace(/0+$/, '');
}

function videoFormat(h: number): string {
	switch (h) {
		case 1080:
			return '1080';
		case 720:
			return '720';
		case 2160:
			return '2160';
		case 480:
		case 486:
			return 'NTSC';
		case 576:
			return 'PAL';
		default:
			return 'CUSTOM';
	}
}

const BASE_COLUMNS = ['Name', 'Tracks', 'Start', 'End', 'Duration', 'Tape', 'Source File'];

export function exportAle(p: IProject, sequenceId: string, opts: ExportOptions, report: Report): string {
	const s = p.sequences[sequenceId];
	if (!s) throw new InterchangeError('NO_SEQUENCE', `no sequence ${sequenceId}`);
	const scope = opts.ale?.scope ?? 'sequence';
	const ids: string[] = [];
	if (scope === 'project') ids.push(...Object.keys(p.media));
	else {
		const seen = new Set<string>();
		const visit = (sid: string, depth: number) => {
			if (seen.has(sid) || depth > 64) return;
			seen.add(sid);
			const q = p.sequences[sid];
			for (const t of [...(q?.video ?? []), ...(q?.audio ?? [])])
				for (const c of t.clips) {
					if (c.source.type === 'media' && !ids.includes(c.source.mediaId)) ids.push(c.source.mediaId);
					else if (c.source.type === 'sequence') visit(c.source.sequenceId, depth + 1);
				}
		};
		visit(sequenceId, 0);
	}
	const media = ids.map((id) => p.media[id]!).filter((m) => m && !m.generator);
	for (const id of ids) {
		const m = p.media[id];
		if (m?.generator)
			report.info(`generator "${m.name}" has no media file and is not logged in the ALE`, {
				subject: { kind: 'media', id, name: m.name },
			});
	}
	const rate = media.find((m) => m.video)?.video?.rate ?? s.rate;
	const height = media.find((m) => m.video)?.video?.height ?? s.height;
	const sr = media.find((m) => m.audio)?.audio?.sampleRate ?? s.sampleRate;
	const extraCols: string[] = [];
	for (const m of media)
		for (const k of Object.keys((m.jasper?.ale as Record<string, string> | undefined) ?? {}))
			if (!extraCols.includes(k)) extraCols.push(k);
	const columns = [...BASE_COLUMNS, ...extraCols];
	const dfOut = media.some((m) => m.timecode?.dropFrame);
	const lines: string[] = [
		'Heading',
		'FIELD_DELIM\tTABS',
		`VIDEO_FORMAT\t${videoFormat(height)}`,
		`AUDIO_FORMAT\t${sr === 44100 ? '44khz' : sr === 96000 ? '96khz' : '48khz'}`,
		`FPS\t${fpsText(rate)}`,
		'',
		'Column',
		columns.join('\t'),
		'',
		'Data',
	];
	for (const m of media) {
		let tracks = m.video ? 'V' : '';
		const ch = Math.min(16, m.audio?.channels ?? 0);
		for (let c = 1; c <= ch; c++) tracks += `A${c}`;
		if ((m.audio?.channels ?? 0) > 16)
			report.warn(`"${m.name}" has more than 16 audio channels; the ALE lists 16`, {
				subject: { kind: 'media', id: m.id, name: m.name },
			});
		const tc0 = m.timecode ? flicksToFrames(framesToFlicks(m.timecode.frames, m.timecode.rate), rate) : 0;
		const len = m.duration !== null ? flicksToFrames(m.duration, rate) : 0;
		const df = dfOut && !!m.timecode?.dropFrame;
		const extra = (m.jasper?.ale as Record<string, string> | undefined) ?? {};
		const row = [
			clean(m.name),
			tracks,
			formatTc(tc0, rate, df),
			formatTc(tc0 + len, rate, df),
			formatTc(len, rate, df),
			clean(m.reel ?? ''),
			clean(m.path ?? ''),
			...extraCols.map((k) => clean(extra[k] ?? '')),
		];
		lines.push(row.join('\t'));
	}
	return `${lines.join('\r\n')}\r\n`;
}
