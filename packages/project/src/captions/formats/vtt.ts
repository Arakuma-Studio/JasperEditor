// WebVTT (`.vtt`). Ported from FilmCraft `crates/captions/src/vtt.rs`; see licenses/ported/captions.md.
//
// Kept on read: cue identifiers, cue settings (verbatim), a leading `<v Speaker>` voice span (as the speaker),
// inline markup in the text, and STYLE / REGION / NOTE blocks. A missing `WEBVTT` signature is tolerated.
// Timestamps may omit hours.
import { type CaptionDocument, CaptionFormatError, emptyCaptionDocument, formatClock } from './core.ts';
import { parseTimingLine } from './srt.ts';

/** Split a leading `<v Name>` / `<v.class Name>` voice span off cue text. */
export function splitVoice(text: string): { speaker: string | null; text: string } {
	const t = text.trimStart();
	if (t.startsWith('<v')) {
		const rest = t.slice(2);
		const close = rest.indexOf('>');
		if ((rest.startsWith(' ') || rest.startsWith('.') || rest.startsWith('\t')) && close >= 0) {
			const inner = rest.slice(0, close);
			// skip classes: `.loud.x Name`
			const sp = inner.search(/[ \t]/);
			const name = sp >= 0 ? inner.slice(sp).trim() : '';
			let body = rest.slice(close + 1);
			// a closing </v> at the very end goes too; one in the middle means several voices: keep all
			const p = body.indexOf('</v>');
			if (p >= 0) {
				if (p + 4 === body.trimEnd().length) body = body.slice(0, p);
				else return { speaker: null, text };
			}
			if (body.includes('<v ') || body.includes('<v.')) return { speaker: null, text };
			return { speaker: name || null, text: body };
		}
	}
	return { speaker: null, text };
}

const isSig = (l: string) => {
	const x = l.replace(/^﻿/, '');
	return x === 'WEBVTT' || x.startsWith('WEBVTT ') || x.startsWith('WEBVTT\t');
};

export function parseVtt(text: string): CaptionDocument {
	const doc = emptyCaptionDocument();
	const lines = text.split('\n');
	let i = 0;
	const hasSig = lines.length > 0 && isSig(lines[0]!);
	if (hasSig) {
		while (i < lines.length && lines[i]!.trim()) i++;
	}
	const blocks: string[][] = [];
	let block: string[] = [];
	for (; i < lines.length; i++) {
		const l = lines[i]!;
		if (!l.trim()) {
			if (block.length) blocks.push(block);
			block = [];
		} else block.push(l);
	}
	if (block.length) blocks.push(block);
	let seenCue = false;
	for (const b of blocks) {
		const first = b[0]!.trim();
		if (
			!first.includes('-->') &&
			(first === 'NOTE' || first.startsWith('NOTE ') || first.startsWith('NOTE\t'))
		) {
			doc.blocks.push(b.join('\n'));
			continue;
		}
		if (!seenCue && !first.includes('-->') && (first === 'STYLE' || first === 'REGION')) {
			doc.blocks.push(b.join('\n'));
			continue;
		}
		const hasId = !b[0]!.includes('-->');
		const id = hasId ? b[0]!.trim() : null;
		const timingIdx = hasId ? 1 : 0;
		const timingLine = b[timingIdx];
		if (timingLine === undefined) {
			doc.warnings.push(`ignored block "${first}"`);
			continue;
		}
		const timing = parseTimingLine(timingLine);
		if (!timing) {
			doc.warnings.push(`bad timing line "${timingLine.trim()}"`);
			continue;
		}
		seenCue = true;
		if (timing.end <= timing.start) {
			doc.warnings.push(`cue at ${formatClock(timing.start, '.')} has end before start; skipped`);
			continue;
		}
		const raw = b
			.slice(timingIdx + 1)
			.map((l) => l.trimEnd())
			.join('\n');
		const v = splitVoice(raw);
		doc.cues.push({
			start: timing.start,
			end: timing.end,
			text: v.text,
			speaker: v.speaker,
			id,
			settings: timing.settings,
		});
	}
	if (!hasSig && doc.cues.length === 0 && text.trim()) throw new CaptionFormatError('not a WebVTT file');
	return doc;
}

export function writeVtt(doc: CaptionDocument): string {
	let out = 'WEBVTT\n\n';
	for (const b of doc.blocks) {
		const t = b.trimEnd();
		if (t) out += `${t}\n\n`;
	}
	for (const c of doc.cues) {
		const id = c.id?.trim();
		if (id && !id.includes('-->')) out += `${id}\n`;
		out += `${formatClock(c.start, '.')} --> ${formatClock(c.end, '.')}`;
		const settings = c.settings?.trim();
		if (settings) out += ` ${settings}`;
		out += '\n';
		let text = '';
		if (c.speaker) text += `<v ${c.speaker}>`;
		text += c.text;
		for (const l of text.split('\n')) if (l.trim()) out += `${l.replaceAll('-->', '--&gt;')}\n`;
		out += '\n';
	}
	return out;
}
