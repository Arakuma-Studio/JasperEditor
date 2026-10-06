// SubRip (`.srt`). Ported from FilmCraft `crates/captions/src/srt.rs`; see licenses/ported/captions.md.
//
// Reading accepts what real files contain: missing or wrong indexes, `.` instead of `,`, 1–9 digit fractions,
// missing hours, extra spaces, trailing SSA position coordinates (`X1:… Y2:…`), and cues not separated by a
// blank line (a new cue starts at a timing line, or at an integer line directly followed by one). Writing
// renumbers from 1 and rounds to milliseconds.
import {
	type CaptionDocument,
	CaptionFormatError,
	emptyCaptionDocument,
	formatClock,
	parseClock,
} from './core.ts';

/** Parse `start --> end[ settings]` (SRT or VTT timing line). */
export function parseTimingLine(line: string): { start: number; end: number; settings: string } | null {
	const at = line.indexOf('-->');
	if (at < 0) return null;
	const start = parseClock(line.slice(0, at).trim());
	if (start === null) return null;
	const rest = line.slice(at + 3).trimStart();
	const ws = rest.search(/\s/);
	const endLen = ws < 0 ? rest.length : ws;
	const end = parseClock(rest.slice(0, endLen));
	if (end === null) return null;
	return { start, end, settings: rest.slice(endLen).trim() };
}

function isIndex(line: string): boolean {
	const l = line.trim();
	return l.length > 0 && l.length <= 10 && /^[0-9]+$/.test(l);
}

export function parseSrt(text: string): CaptionDocument {
	const lines = text.split('\n');
	const doc = emptyCaptionDocument();
	let i = 0;
	let foundAny = false;
	while (i < lines.length) {
		const timing = parseTimingLine(lines[i]!);
		if (!timing) {
			const l = lines[i]!.trim();
			if (l && !isIndex(l) && foundAny) doc.warnings.push(`line ${i + 1}: ignored stray text "${l}"`);
			i++;
			continue;
		}
		foundAny = true;
		i++;
		const textLines: string[] = [];
		while (i < lines.length) {
			const l = lines[i]!;
			if (!l.trim()) break;
			if (parseTimingLine(l)) break;
			if (isIndex(l) && i + 1 < lines.length && parseTimingLine(lines[i + 1]!)) break;
			textLines.push(l.trimEnd());
			i++;
		}
		if (timing.end <= timing.start) {
			doc.warnings.push(`cue at ${formatClock(timing.start, ',')} has end before start; skipped`);
			continue;
		}
		doc.cues.push({ start: timing.start, end: timing.end, text: textLines.join('\n') });
	}
	if (!foundAny && text.trim()) throw new CaptionFormatError('not a SubRip file');
	return doc;
}

export function writeSrt(doc: CaptionDocument): string {
	let out = '';
	doc.cues.forEach((c, n) => {
		out += `${n + 1}\n${formatClock(c.start, ',')} --> ${formatClock(c.end, ',')}\n`;
		// blank lines inside text would end the cue: drop them
		for (const l of c.text.split('\n')) if (l.trim()) out += `${l}\n`;
		out += '\n';
	});
	return out;
}
