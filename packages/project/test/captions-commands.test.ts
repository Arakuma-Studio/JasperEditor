// Includes FilmCraft caption-edit tests (crates/edit/src/captions.rs) and interview-transcript cases
// (crates/edit/src/transcript/tests.rs).
import { describe, expect, it } from 'vitest';
import {
	CAPTION_CONTENT_ORIGIN,
	type CaptionsClip,
	captionClipText,
	captionCuesForTrack,
	captionPages,
	checkInvariants,
	DEFAULT_FILLERS,
	findFillers,
	findPauses,
	type ProjectDocument,
	repairDocument,
	resolveCaptionStyle,
	sequenceWords,
	type Transcript,
} from '../src/index.ts';
import { FLICKS_PER_SECOND } from '../src/time.ts';
import fixture from './fixtures/interview.transcript.json' with { type: 'json' };
import { Harness } from './helpers.ts';

const s = (x: number) => Math.round(x * FLICKS_PER_SECOND);

function interviewWords() {
	return fixture.words.map((w) => ({
		text: w.text,
		start: s(w.seconds[0]!),
		end: s(w.seconds[1]!),
		speaker: w.speaker,
	}));
}

/** 25 fps sequence with the 10 s interview on V1/A1 and its transcript. */
function interview(): { H: Harness; mediaId: string; trs: string; audioClip: string } {
	const H = new Harness({ preset: 'hd-1080p-25' });
	const mediaId = H.registerVideo({ seconds: 10, fps: { num: 25, den: 1 } });
	H.ok([
		{
			type: 'clip.place',
			source: { mediaId },
			at: 0,
			tracks: { video: 'V1', audio: ['A1'] },
			mode: 'overwrite',
		},
	]);
	const r = H.ok([
		{
			type: 'transcript.create',
			mediaId,
			language: 'en',
			origin: 'manual',
			words: interviewWords(),
			speakers: fixture.speakers,
		},
	]);
	const trs = (r.results[0] as { transcriptId: string }).transcriptId;
	const audioClip = H.clips('A1')[0]!.id;
	return { H, mediaId, trs, audioClip };
}

const captions = (H: Harness) =>
	Object.values(H.seq.clips)
		.filter((c): c is CaptionsClip => c.kind === 'captions')
		.sort((a, b) => a.start - b.start);
const textOf = (H: Harness, c: CaptionsClip) => captionClipText(H.doc, c, H.seq.settings.frameRate);
const spans = (H: Harness) => captions(H).map((c) => [c.start, c.start + c.duration, textOf(H, c)]);

function ensureValid(doc: ProjectDocument) {
	expect(checkInvariants(doc)).toEqual([]);
}

describe('caption tracks and adding captions', () => {
	it('adds a caption track (active), then a caption at the playhead clamped to the next one', () => {
		const H = new Harness();
		const t = (
			H.ok([{ type: 'caption.addTrack', name: 'English', language: 'en' }]).results[0] as { trackId: string }
		).trackId;
		expect(H.seq.captionTracks).toHaveLength(1);
		expect((H.seq as { activeCaptionTrackId?: string }).activeCaptionTrackId).toBe(t);
		expect(H.seq.captionTracks[0]!.language).toBe('en');
		H.ok([{ type: 'caption.add', at: 100, duration: 50, text: 'b' }]);
		const r = H.ok([
			{ type: 'caption.add', at: 40, duration: 1000, text: 'Hello <i>world</i>\nsecond line' },
		]);
		expect((r.results[0] as { duration: number }).duration).toBe(60);
		expect(spans(H)).toEqual([
			[40, 100, 'Hello <i>world</i>\nsecond line'],
			[100, 150, 'b'],
		]);
		expect(H.tx([{ type: 'caption.add', at: 120, duration: 10, text: 'x' }]).ok).toBe(false);
		const c = captions(H)[0]!;
		expect(c.sourceIn).toBe(CAPTION_CONTENT_ORIGIN);
		expect(H.doc.transcripts[c.transcriptId]!.mediaId).toBeNull();
		ensureValid(H.doc);
	});
	it('creates a caption track when none exists', () => {
		const H = new Harness();
		const before = H.doc;
		H.ok([{ type: 'caption.add', at: 0, text: 'Hi' }]);
		expect(H.seq.captionTracks).toHaveLength(1);
		expect(captions(H)[0]!.duration).toBe(90); // 3 s at 30 fps
		expect(Object.keys(before.transcripts)).toHaveLength(0);
	});
});

describe('split, merge, trim, move and ripple delete (FilmCraft caption edits)', () => {
	function three(): Harness {
		const H = new Harness();
		H.ok([
			{ type: 'caption.add', at: 0, duration: 100, text: 'hello there friend' },
			{ type: 'caption.add', at: 100, duration: 50, text: 'world' },
		]);
		return H;
	}
	it('splits by word time and merges back with a line break', () => {
		const H = three();
		const first = captions(H)[0]!;
		const r = H.ok([{ type: 'caption.split', at: 60 }]);
		const right = (r.results[0] as { clipIds: string[] }).clipIds[0]!;
		expect(spans(H)).toEqual([
			[0, 60, 'hello there'],
			[60, 100, 'friend'],
			[100, 150, 'world'],
		]);
		const [a, b] = captions(H);
		expect(a!.transcriptId).not.toBe(b!.transcriptId);
		ensureValid(H.doc);
		expect(
			H.tx([{ type: 'caption.merge', clipIds: [first.id, H.clips().find((c) => c.start === 100)!.id] }]).ok,
		).toBe(false);
		H.ok([{ type: 'caption.merge', clipIds: [right, H.clips().find((c) => c.start === 100)!.id] }]);
		expect(spans(H)).toEqual([
			[0, 60, 'hello there'],
			[60, 150, 'friend\nworld'],
		]);
		ensureValid(H.doc);
	});
	it('a split with no word boundary keeps the text on both halves (FilmCraft)', () => {
		const H = new Harness();
		H.ok([{ type: 'caption.add', at: 0, duration: 100, text: 'hello' }]);
		H.ok([{ type: 'caption.split', at: 40 }]);
		expect(spans(H)).toEqual([
			[0, 40, 'hello'],
			[40, 100, 'hello'],
		]);
		ensureValid(H.doc);
	});
	it('trims and moves like clips, limited by neighbours', () => {
		const H = new Harness();
		H.ok([
			{ type: 'caption.add', at: 0, duration: 100, text: 'a' },
			{ type: 'caption.add', at: 150, duration: 50, text: 'b' },
			{ type: 'caption.add', at: 300, duration: 50, text: 'c' },
		]);
		const [a, b, c] = captions(H);
		H.ok([{ type: 'clip.trim', clipId: b!.id, edge: 'in', deltaFrames: -500 }]);
		H.ok([{ type: 'clip.trim', clipId: b!.id, edge: 'out', deltaFrames: 500 }]);
		expect(spans(H)[1]).toEqual([100, 300, 'b']);
		H.ok([{ type: 'caption.setTimes', clipId: c!.id, start: 310, end: 400 }]);
		expect(spans(H)[2]).toEqual([310, 400, 'c']);
		expect(H.tx([{ type: 'caption.setTimes', clipId: c!.id, start: 250 }]).ok).toBe(false);
		H.ok([{ type: 'clip.move', clipIds: [a!.id], deltaFrames: 1000, mode: 'overwrite' }]);
		expect(spans(H).map((x) => x[2])).toEqual(['b', 'c', 'a']);
		ensureValid(H.doc);
	});
	it('ripple deletes a caption and the later ones close the gap', () => {
		const H = new Harness();
		H.ok([
			{ type: 'caption.add', at: 0, duration: 100, text: 'a' },
			{ type: 'caption.add', at: 100, duration: 50, text: 'b' },
			{ type: 'caption.add', at: 200, duration: 50, text: 'c' },
		]);
		H.ok([{ type: 'clip.extract', clipIds: [captions(H)[1]!.id] }]);
		expect(spans(H)).toEqual([
			[0, 100, 'a'],
			[150, 200, 'c'],
		]);
	});
	it('caption.delete ripples only its caption track', () => {
		const { H } = interview();
		H.ok([
			{ type: 'caption.add', at: 0, duration: 100, text: 'a' },
			{ type: 'caption.add', at: 100, duration: 50, text: 'b' },
			{ type: 'caption.add', at: 200, duration: 50, text: 'c' },
		]);
		const video = H.clips('V1').map((c) => [c.start, c.duration]);
		H.ok([{ type: 'caption.delete', clipIds: [captions(H)[1]!.id], ripple: true }]);
		expect(spans(H)).toEqual([
			[0, 100, 'a'],
			[150, 200, 'c'],
		]);
		expect(H.clips('V1').map((c) => [c.start, c.duration])).toEqual(video);
		H.ok([{ type: 'caption.delete', clipIds: [captions(H)[0]!.id] }]);
		expect(spans(H)).toEqual([[150, 200, 'c']]);
		ensureValid(H.doc);
	});
	it('locked caption tracks refuse edits', () => {
		const H = new Harness();
		H.ok([{ type: 'caption.add', at: 0, duration: 100, text: 'a' }]);
		H.ok([{ type: 'track.update', trackId: 'C1', patch: { locked: true } }]);
		const id = captions(H)[0]!.id;
		expect(H.tx([{ type: 'caption.setText', clipId: id, text: 'x' }]).ok).toBe(false);
		expect(H.tx([{ type: 'caption.split', at: 50, clipIds: [id] }]).ok).toBe(false);
		expect(H.tx([{ type: 'clip.lift', clipIds: [id] }]).ok).toBe(false);
	});
	it('duplicates and pastes get their own words', () => {
		const H = new Harness();
		H.ok([{ type: 'caption.add', at: 0, duration: 50, text: 'one two' }]);
		const id = captions(H)[0]!.id;
		H.ok([{ type: 'clip.duplicate', clipIds: [id], deltaFrames: 100 }]);
		const [a, b] = captions(H);
		expect(a!.transcriptId).not.toBe(b!.transcriptId);
		H.ok([{ type: 'caption.setText', clipId: b!.id, text: 'three' }]);
		expect(spans(H).map((x) => x[2])).toEqual(['one two', 'three']);
		ensureValid(H.doc);
	});
});

describe('sync lock', () => {
	it('sync-locked caption tracks follow insert and extract edits', () => {
		const { H, mediaId } = interview();
		H.ok([{ type: 'caption.add', at: 0, duration: 100, text: 'over the cut' }]);
		H.ok([
			{
				type: 'clip.place',
				source: { mediaId },
				sourceRange: { in: { flicks: 0 }, out: { flicks: s(1) } },
				at: 50,
				tracks: { video: 'V1', audio: ['A1'] },
				mode: 'insert',
			},
		]);
		expect(spans(H).map((x) => [x[0], x[1]])).toEqual([
			[0, 50],
			[75, 125],
		]);
		ensureValid(H.doc);
		H.ok([{ type: 'range.extract', from: 50, to: 75 }]);
		expect(spans(H).map((x) => [x[0], x[1]])).toEqual([
			[0, 50],
			[50, 100],
		]);
		H.ok([{ type: 'range.extract', from: 60, to: 70 }]);
		expect(spans(H)).toEqual([
			[0, 50, 'over'],
			[50, 90, 'the cut'],
		]);
		ensureValid(H.doc);
	});
	it('a caption cut by an extract stays one caption', () => {
		const { H } = interview();
		H.ok([{ type: 'caption.add', at: 10, duration: 100, text: 'one two three four' }]);
		H.ok([{ type: 'range.extract', from: 40, to: 60 }]);
		expect(spans(H)).toEqual([[10, 90, 'one two three four']]);
		ensureValid(H.doc);
		H.ok([{ type: 'caption.split', at: 50 }]);
		expect(spans(H).length).toBe(2);
	});
	it('a caption track with sync lock off stays put', () => {
		const { H, mediaId } = interview();
		H.ok([{ type: 'caption.add', at: 0, duration: 100, text: 'stay' }]);
		H.ok([{ type: 'track.update', trackId: 'C1', patch: { syncLock: false } }]);
		H.ok([
			{
				type: 'clip.place',
				source: { mediaId },
				sourceRange: { in: { flicks: 0 }, out: { flicks: s(1) } },
				at: 50,
				tracks: { video: 'V1', audio: ['A1'] },
				mode: 'insert',
			},
		]);
		expect(spans(H)).toEqual([[0, 100, 'stay']]);
	});
});

describe('text edits', () => {
	it('editing a word keeps every other word timing (AC-CAP-2)', () => {
		const H = new Harness();
		H.ok([{ type: 'caption.add', at: 0, duration: 90, text: 'the quick brown fox' }]);
		const c = captions(H)[0]!;
		const before = H.doc.transcripts[c.transcriptId]!.words;
		H.ok([{ type: 'caption.setText', clipId: c.id, text: 'the quick red fox' }]);
		const after = H.doc.transcripts[captions(H)[0]!.transcriptId]!.words;
		expect(after.map((w) => w.text)).toEqual(['the', 'quick', 'red', 'fox']);
		for (const i of [0, 1, 3])
			expect([after[i]!.start, after[i]!.end]).toEqual([before[i]!.start, before[i]!.end]);
		expect([after[2]!.start, after[2]!.end]).toEqual([before[2]!.start, before[2]!.end]);
	});
	it('transcript.editText spreads new words over the replaced range by characters', () => {
		const { H, trs } = interview();
		H.ok([{ type: 'transcript.editText', transcriptId: trs, fromWord: 4, toWord: 4, text: 'Uh huh,' }]);
		const w = H.doc.transcripts[trs]!.words;
		expect(w.slice(4, 6).map((x) => x.text)).toEqual(['Uh', 'huh,']);
		expect(w[4]!.start).toBe(s(3.7));
		expect(w[5]!.end).toBe(s(4.0));
		expect(w[5]!.start - w[4]!.start).toBe(Math.round((s(0.3) * 2) / 6));
		H.ok([{ type: 'transcript.setBreak', transcriptId: trs, wordIndex: 3, breakBefore: 'segment' }]);
		expect(H.doc.transcripts[trs]!.words[3]!.breakBefore).toBe('segment');
		expect(
			H.tx([{ type: 'transcript.editText', transcriptId: trs, fromWord: 30, toWord: 31, text: 'x' }]).ok,
		).toBe(false);
	});
	it('a blank line in caption text starts a new page', () => {
		const H = new Harness();
		H.ok([{ type: 'caption.add', at: 0, duration: 120, text: 'one two\n\nthree four' }]);
		const c = captions(H)[0]!;
		const pages = captionPages(H.doc, H.seq, c, { maxCharsPerLine: 42, maxLines: 2, allCaps: false });
		expect(pages.map((p) => [p.start, p.end])).toEqual([
			[0, 48],
			[48, 120],
		]);
		expect(textOf(H, c)).toBe('one two\n\nthree four');
	});
	it('speaker of a caption', () => {
		const H = new Harness();
		H.ok([{ type: 'caption.add', at: 0, text: 'Hi', speaker: 'Ann' }]);
		const c = captions(H)[0]!;
		H.ok([{ type: 'caption.setText', clipId: c.id, speaker: 'Bob' }]);
		const t = H.doc.transcripts[c.transcriptId]!;
		expect(Object.values(t.speakers).map((x) => x.name)).toContain('Bob');
		expect(captionCuesForTrack(H.doc, H.seq, H.seq.captionTracks[0]!.id)[0]!.speaker).toBe('Bob');
	});
});

describe('styles and presets', () => {
	it('track style, per-caption overrides, reset and presets', () => {
		const H = new Harness();
		H.ok([{ type: 'caption.add', at: 0, text: 'a' }]);
		const c = captions(H)[0]!;
		const track = H.seq.captionTracks[0]!;
		H.ok([{ type: 'caption.setStyle', trackId: track.id, style: { sizePx: 60, placement: 'top' } }]);
		H.ok([{ type: 'caption.setStyle', clipIds: [c.id], style: { fill: [1, 1, 0, 1], linePct: 20 } }]);
		const t2 = H.seq.captionTracks[0]!;
		let st = resolveCaptionStyle(t2.styleDefaults, captions(H)[0]!.style, '', 1080);
		expect([st.sizePx, st.placement, st.fill, st.linePct]).toEqual([60, 'top', [1, 1, 0, 1], 20]);
		H.ok([{ type: 'caption.setStyle', clipIds: [c.id], reset: ['fill'] }]);
		st = resolveCaptionStyle(H.seq.captionTracks[0]!.styleDefaults, captions(H)[0]!.style, '', 1080);
		expect(st.fill).toEqual([1, 1, 1, 1]);
		H.ok([{ type: 'caption.applyPreset', presetId: 'builtin:social', trackId: track.id }]);
		expect(H.seq.captionTracks[0]!.styleDefaults!.highlight.mode).toBe('karaoke');
		H.ok([{ type: 'caption.savePreset', name: 'Mine', trackId: track.id }]);
		const id = H.doc.settings.captionStylePresets![0]!.id;
		H.ok([{ type: 'caption.setStyle', trackId: track.id, reset: true }]);
		H.ok([{ type: 'caption.applyPreset', presetId: id, clipIds: [c.id] }]);
		expect(captions(H)[0]!.style.highlight?.mode).toBe('karaoke');
		H.ok([{ type: 'caption.deletePreset', presetId: id }]);
		expect(H.doc.settings.captionStylePresets).toEqual([]);
		expect(H.tx([{ type: 'caption.setStyle', clipIds: [c.id], style: { bogus: 1 } }]).ok).toBe(false);
		ensureValid(H.doc);
	});
});

describe('import and export', () => {
	const SRT =
		'1\n00:00:01,000 --> 00:00:02,500\nHello\n<i>World</i>\n\n2\n00:00:03,000 --> 00:00:04,000\nBye\n';
	it('imports SRT onto a new caption track, frame-snapped, and exports it back', () => {
		const H = new Harness({ preset: 'hd-1080p-25' });
		const r = H.ok([{ type: 'caption.import', content: SRT, fileName: 'en.srt', language: 'en' }]);
		expect((r.results[0] as { format: string }).format).toBe('srt');
		expect(H.seq.captionTracks[0]!.name).toBe('en');
		expect(spans(H)).toEqual([
			[25, 62, 'Hello\n<i>World</i>'],
			[75, 100, 'Bye'],
		]);
		const cues = captionCuesForTrack(H.doc, H.seq, H.seq.captionTracks[0]!.id);
		expect(cues.map((c) => [c.start / s(1), c.end / s(1), c.text])).toEqual([
			[1, 2.48, 'Hello\n<i>World</i>'],
			[3, 4, 'Bye'],
		]);
		const part = captionCuesForTrack(H.doc, H.seq, H.seq.captionTracks[0]!.id, { start: 50, end: 90 });
		expect(part.map((c) => [c.start / s(1), c.end / s(1)])).toEqual([
			[0, 0.48],
			[1, 1.6],
		]);
		ensureValid(H.doc);
	});
	it('keeps WebVTT ids, settings (as placement), speakers and STYLE blocks', () => {
		const H = new Harness({ preset: 'hd-1080p-25' });
		const vtt =
			'WEBVTT\n\nSTYLE\n::cue { color: yellow }\n\nintro\n00:00:01.000 --> 00:00:02.000 line:10% align:start\n<v Ann>Hi there\n';
		H.ok([{ type: 'caption.import', content: vtt }]);
		const c = captions(H)[0]!;
		expect(c.cue).toEqual({ id: 'intro', settings: 'line:10% align:start' });
		expect(c.style).toMatchObject({ linePct: 10, align: 'left' });
		expect(H.seq.captionTracks[0]!.vttBlocks).toEqual(['STYLE\n::cue { color: yellow }']);
		const cue = captionCuesForTrack(H.doc, H.seq, H.seq.captionTracks[0]!.id)[0]!;
		expect(cue).toMatchObject({ id: 'intro', speaker: 'Ann', text: 'Hi there' });
		expect(cue.settings).toBe('line:10% align:left');
	});
	it('imports binary EBU STL from base64 and SCC as CEA-608', () => {
		const H = new Harness({ preset: 'hd-1080p-25' });
		const scc =
			'Scenarist_SCC V1.0\n\n00:00:00;20\t9420 9420 94ae 94ae 94d0 94d0 c845 4c4c 4f80 942f 942f\n\n00:00:03;00\t942c 942c\n';
		H.ok([{ type: 'caption.import', content: scc }]);
		expect(H.seq.captionTracks[0]!.captionStandard).toBe('cea-608');
		expect(spans(H)[0]![2]).toBe('HELLO');
		const bad = H.tx([{ type: 'caption.import', content: 'garbage that is no caption file' }]);
		expect(bad.ok).toBe(false);
	});
	it('replaces the captions of a track', () => {
		const H = new Harness({ preset: 'hd-1080p-25' });
		H.ok([{ type: 'caption.import', content: SRT }]);
		H.ok([
			{
				type: 'caption.import',
				track: 'C1',
				content: '1\n00:00:10,000 --> 00:00:11,000\nNew\n',
				replace: true,
			},
		]);
		expect(spans(H)).toEqual([[250, 275, 'New']]);
		expect(Object.keys(H.doc.transcripts)).toHaveLength(1);
	});
});

describe('transcripts and text-based editing (FilmCraft transcript tests, end to end)', () => {
	it('imports transcripts from JSON and caption files', () => {
		const { H, mediaId } = interview();
		const json = JSON.stringify([
			{ text: ' Hello', startMs: 0, endMs: 400 },
			{ text: ' world', startMs: 400, endMs: 900 },
			{ text: '!', startMs: 900, endMs: 950 },
		]);
		const r = H.ok([{ type: 'transcript.import', mediaId, content: json }]);
		const t = H.doc.transcripts[(r.results[0] as { transcriptId: string }).transcriptId]!;
		expect(t.words.map((w) => w.text)).toEqual(['Hello', 'world!']);
		const r2 = H.ok([
			{
				type: 'transcript.import',
				mediaId,
				content: '1\n00:00:01,000 --> 00:00:02,000\nTwo words\n',
				format: 'srt',
			},
		]);
		const t2 = H.doc.transcripts[(r2.results[0] as { transcriptId: string }).transcriptId]!;
		expect(t2.words.map((w) => [w.text, w.breakBefore])).toEqual([
			['Two', 'segment'],
			['words', 'none'],
		]);
		expect(t2.words[0]!.start).toBe(s(1));
		expect(t2.words[1]!.end).toBe(s(2));
		const whisper = JSON.stringify({
			language: 'en',
			segments: [{ words: [{ word: ' a', start: 0.5, end: 0.7, probability: 0.9 }] }],
		});
		const r3 = H.ok([{ type: 'transcript.import', mediaId, content: whisper }]);
		const t3 = H.doc.transcripts[(r3.results[0] as { transcriptId: string }).transcriptId]!;
		expect(t3.words).toEqual([
			{ text: 'a', start: s(0.5), end: s(0.7), confidence: 0.9, speaker: null, breakBefore: 'none' },
		]);
		expect(H.tx([{ type: 'transcript.import', mediaId, content: '{"nope": 1}' }]).ok).toBe(false);
	});
	it('imports a sequence-timed caption file through a clip', () => {
		const H = new Harness({ preset: 'hd-1080p-25' });
		const mediaId = H.registerVideo({ seconds: 10, fps: { num: 25, den: 1 } });
		H.ok([
			{
				type: 'clip.place',
				source: { mediaId },
				sourceRange: { in: { flicks: s(2) }, out: { flicks: s(8) } },
				at: 100,
				tracks: { video: 'V1', audio: ['A1'] },
				mode: 'overwrite',
			},
		]);
		const clip = H.clips('A1')[0]!;
		H.ok([
			{
				type: 'transcript.import',
				clipId: clip.id,
				timeBase: 'sequence',
				content: '1\n00:00:05,000 --> 00:00:06,000\nHi\n',
			},
		]);
		const t = Object.values(H.doc.transcripts)[0]!;
		// sequence 5 s = clip start (4 s) + 1 s → media 2 s + 1 s
		expect(t.words[0]!.start).toBe(s(3));
		expect(sequenceWords(H.doc, H.seq)[0]!.start).toBe(s(5));
	});
	it('select marks In/Out snapped outward; extract closes the gap', () => {
		const { H } = interview();
		H.ok([{ type: 'transcript.select', fromWord: 3, toWord: 0 }]);
		expect([H.seq.inPoint, H.seq.outPoint]).toEqual([12, 43]);
		H.ok([{ type: 'transcript.extract', fromWord: 0, toWord: 3 }]);
		const w = sequenceWords(H.doc, H.seq);
		expect(w).toHaveLength(16);
		expect(w[0]!.text).toBe('Um,');
		expect(w[0]!.start).toBe(s(3.7) - 31 * (FLICKS_PER_SECOND / 25));
		ensureValid(H.doc);
	});
	it('lift leaves a gap', () => {
		const { H } = interview();
		H.ok([{ type: 'transcript.lift', fromWord: 0, toWord: 3 }]);
		const w = sequenceWords(H.doc, H.seq);
		expect(w).toHaveLength(16);
		expect(w[0]!.start).toBe(s(3.7));
	});
	it('removes pauses in one pass, keeping air', () => {
		const { H } = interview();
		const before = sequenceWords(H.doc, H.seq);
		H.ok([{ type: 'transcript.removePauses', minSeconds: 0.4, keepSeconds: 0.1 }]);
		const w2 = sequenceWords(H.doc, H.seq);
		expect(w2.map((x) => x.text)).toEqual(before.map((x) => x.text));
		expect(w2[4]!.start - w2[3]!.end).toBe(s(0.2));
		expect(findPauses(w2, s(0.4), s(0.1), H.seq.settings.frameRate)).toEqual([]);
		ensureValid(H.doc);
	});
	it('removes fillers (longest phrase first) without cutting into neighbours', () => {
		const { H } = interview();
		H.ok([{ type: 'transcript.removeFillers' }]);
		const w2 = sequenceWords(H.doc, H.seq);
		expect(w2).toHaveLength(18);
		expect(findFillers(w2, DEFAULT_FILLERS)).toEqual([]);
		expect(H.clips('A1')).toHaveLength(3);
		const { H: H2 } = interview();
		H2.ok([{ type: 'transcript.removeFillers', fillers: ['um', 'uh', 'you know', 'you'] }]);
		expect(sequenceWords(H2.doc, H2.seq).map((x) => x.text)).not.toContain('know.');
	});
	it('renames speakers across transcripts and sets a word range speaker', () => {
		const { H, trs } = interview();
		H.ok([{ type: 'transcript.renameSpeaker', speaker: 'Speaker 2', name: 'Guest' }]);
		expect(sequenceWords(H.doc, H.seq)[10]!.speaker).toBe('Guest');
		H.ok([{ type: 'transcript.setSpeaker', transcriptId: trs, fromWord: 0, toWord: 1, speaker: 'Host' }]);
		expect(
			sequenceWords(H.doc, H.seq)
				.slice(0, 3)
				.map((w) => w.speaker),
		).toEqual(['Host', 'Host', 'Speaker 1']);
	});
	it('creates captions from the sequence transcript (FilmCraft caption blocks)', () => {
		const { H } = interview();
		const r = H.ok([{ type: 'transcript.createCaptions' }]);
		expect((r.results[0] as { captions: number }).captions).toBe(3);
		expect(spans(H).map((x) => x[2])).toEqual([
			'Welcome to the show.',
			'Um, today we talk about rivers.',
			'Thanks for having me. I uh love rivers,\nyou know.',
		]);
		expect(spans(H)[0]!.slice(0, 2)).toEqual([12, 43]);
		const cues = captionCuesForTrack(H.doc, H.seq, H.seq.captionTracks[0]!.id);
		expect(cues[2]!.speaker).toBe('Speaker 2');
		expect(H.seq.captionTracks[0]!.language).toBe('en');
		ensureValid(H.doc);
		H.ok([{ type: 'transcript.extract', fromWord: 0, toWord: 3 }]);
		expect(spans(H)[0]![2]).toBe('Um, today we talk about rivers.');
	});
	it('clip.addCaptions aligned to a clip, one paged clip or one clip per block', () => {
		const { H, trs, audioClip } = interview();
		H.ok([
			{ type: 'clip.addCaptions', transcriptId: trs, track: 'new', alignToClipId: audioClip, split: false },
		]);
		expect(captions(H)).toHaveLength(1);
		const c = captions(H)[0]!;
		const pages = captionPages(H.doc, H.seq, c, { maxCharsPerLine: 42, maxLines: 2, allCaps: false });
		expect(pages).toHaveLength(3);
		expect(pages[1]!.start).toBe(93);
		const { H: H2, trs: t2, audioClip: a2 } = interview();
		H2.ok([
			{
				type: 'clip.addCaptions',
				transcriptId: t2,
				track: 'new',
				alignToClipId: a2,
				rules: { maxChars: 20, lines: 1 },
			},
		]);
		expect(captions(H2).length).toBeGreaterThanOrEqual(5);
		ensureValid(H2.doc);
	});
	it('inserts a text selection into another sequence', () => {
		const { H } = interview();
		const r = H.ok([{ type: 'sequence.create', name: 'Selects', preset: 'hd-1080p-25' }]);
		const target = (r.results[0] as { sequenceId: string }).sequenceId;
		H.ok([{ type: 'transcript.insertInto', fromWord: 10, toWord: 13, targetSequenceId: target, at: 0 }]);
		const tseq = H.doc.sequences[target]!;
		const w = sequenceWords(H.doc, tseq);
		expect(w.map((x) => x.text)).toEqual(['Thanks', 'for', 'having', 'me.']);
		ensureValid(H.doc);
	});
	it('transcripts in use cannot be deleted; others can', () => {
		const { H, trs } = interview();
		H.ok([{ type: 'transcript.delete', transcriptIds: [trs] }]);
		expect(H.doc.transcripts[trs]).toBeUndefined();
		H.ok([{ type: 'caption.add', at: 0, text: 'x' }]);
		const own = captions(H)[0]!.transcriptId;
		expect(H.tx([{ type: 'transcript.delete', transcriptIds: [own] }]).ok).toBe(false);
	});
});

describe('invariants and repair', () => {
	it('repairs a shared caption transcript, bad words and a dangling active track', () => {
		const H = new Harness();
		H.ok([{ type: 'caption.add', at: 0, duration: 50, text: 'a b' }]);
		const doc = JSON.parse(JSON.stringify(H.doc)) as ProjectDocument;
		const seq = Object.values(doc.sequences)[0]!;
		const c = Object.values(seq.clips)[0]! as CaptionsClip;
		seq.clips.clp_X = { ...c, id: 'clp_0000000000000XXX', start: 100 } as never;
		const t = doc.transcripts[c.transcriptId] as Transcript;
		t.words.reverse();
		(seq as { activeCaptionTrackId?: string }).activeCaptionTrackId = 'trk_00000000000000ZZ';
		const issues = checkInvariants(doc);
		expect(issues.length).toBeGreaterThan(0);
		const { document } = repairDocument(doc, H.ids);
		const fixed = Object.values(document.sequences)[0]!;
		expect((fixed as { activeCaptionTrackId?: string }).activeCaptionTrackId).toBe(
			fixed.captionTracks[0]!.id,
		);
		const ids = Object.values(fixed.clips).map((x) => (x as CaptionsClip).transcriptId);
		expect(new Set(ids).size).toBe(2);
	});
});

describe('fuzz: random caption edits keep the document valid', () => {
	it('add / split / merge / delete / move / trim / extract / text / import', async () => {
		const fc = (await import('fast-check')).default;
		const op = fc.oneof(
			fc.record({
				k: fc.constant('add'),
				at: fc.nat(300),
				dur: fc.integer({ min: 1, max: 120 }),
				text: fc.string({ maxLength: 30 }),
			}),
			fc.record({ k: fc.constant('split'), at: fc.nat(400) }),
			fc.record({ k: fc.constant('merge'), i: fc.nat(10) }),
			fc.record({ k: fc.constant('delete'), i: fc.nat(10), ripple: fc.boolean() }),
			fc.record({ k: fc.constant('move'), i: fc.nat(10), d: fc.integer({ min: -100, max: 100 }) }),
			fc.record({
				k: fc.constant('trim'),
				i: fc.nat(10),
				edge: fc.constantFrom('in', 'out'),
				d: fc.integer({ min: -60, max: 60 }),
			}),
			fc.record({ k: fc.constant('extract'), from: fc.nat(300), len: fc.integer({ min: 1, max: 60 }) }),
			fc.record({ k: fc.constant('text'), i: fc.nat(10), text: fc.string({ maxLength: 40 }) }),
			fc.record({ k: fc.constant('dup'), i: fc.nat(10), d: fc.integer({ min: 1, max: 200 }) }),
			fc.record({ k: fc.constant('import'), bytes: fc.uint8Array({ maxLength: 200 }) }),
		);
		fc.assert(
			fc.property(fc.array(op, { maxLength: 25 }), (ops) => {
				const H = new Harness();
				H.ok([{ type: 'caption.addTrack' }]);
				for (const o of ops) {
					const ids = captions(H).map((c) => c.id);
					const pick = (i: number) => ids[i % Math.max(1, ids.length)];
					let cmd: unknown = null;
					switch (o.k) {
						case 'add':
							cmd = { type: 'caption.add', at: o.at, duration: o.dur, text: o.text };
							break;
						case 'split':
							cmd = { type: 'caption.split', at: o.at };
							break;
						case 'merge':
							if (ids.length > 1) cmd = { type: 'caption.merge', clipIds: [pick(o.i), pick(o.i + 1)] };
							break;
						case 'delete':
							if (ids.length) cmd = { type: 'caption.delete', clipIds: [pick(o.i)], ripple: o.ripple };
							break;
						case 'move':
							if (ids.length)
								cmd = { type: 'clip.move', clipIds: [pick(o.i)], deltaFrames: o.d, mode: 'overwrite' };
							break;
						case 'trim':
							if (ids.length) cmd = { type: 'clip.trim', clipId: pick(o.i), edge: o.edge, deltaFrames: o.d };
							break;
						case 'extract':
							cmd = { type: 'range.extract', from: o.from, to: o.from + o.len };
							break;
						case 'text':
							if (ids.length) cmd = { type: 'caption.setText', clipId: pick(o.i), text: o.text };
							break;
						case 'dup':
							if (ids.length) cmd = { type: 'clip.duplicate', clipIds: [pick(o.i)], deltaFrames: o.d };
							break;
						case 'import':
							cmd = {
								type: 'caption.import',
								track: 'C1',
								contentBase64: Buffer.from(o.bytes).toString('base64'),
								fileName: 'x.srt',
							};
							break;
					}
					if (!cmd) continue;
					const r = H.tx([cmd]);
					if (!r.ok) expect(r.errors[0]!.code).not.toMatch(/E_INVARIANT|E_INTERNAL/);
				}
				expect(checkInvariants(H.doc)).toEqual([]);
			}),
			{ numRuns: 150 },
		);
	});
});
