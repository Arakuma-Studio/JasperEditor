// Spec 18 AF-DIG-001: the packed footage digest (docs/wp-notes/agent-footage-digest.md).
import { describe, expect, it } from 'vitest';
import {
	DIGEST_DEFAULT_MAX_CHARS,
	footagePhrases,
	type ProjectDocument,
	packFootageDigest,
	type Transcript,
} from '../src/index.ts';
import { Harness } from './helpers.ts';

const S = 705_600_000;

type W = [
	text: string,
	start: number,
	end: number,
	opts?: { conf?: number | null; speaker?: string | null; br?: 'line' | 'segment' },
];

function transcript(id: string, mediaId: string, words: W[], language = 'en'): Transcript {
	return {
		id,
		mediaId,
		language,
		origin: 'whisper-local',
		words: words.map(([text, a, b, o]) => ({
			text,
			start: Math.round(a * S),
			end: Math.round(b * S),
			confidence: o?.conf === undefined ? 0.9 : o.conf,
			speaker: o?.speaker === undefined ? null : o.speaker,
			breakBefore: o?.br ?? 'none',
		})),
		speakers: {},
	};
}

function withTranscripts(doc: ProjectDocument, ts: Transcript[]): ProjectDocument {
	return { ...doc, transcripts: Object.fromEntries(ts.map((t) => [t.id, t])) };
}

/** A project with an interview (video, 43 s, 29.97 fps), a voice-over (audio, 12 s) and a still. */
function project() {
	const h = new Harness();
	const video = h.registerVideo({ seconds: 43, fps: { num: 30000, den: 1001 } });
	const audio = h.registerVideo({ seconds: 12, kind: 'audio' });
	const still = h.registerVideo({ kind: 'image' });
	return { h, video, audio, still };
}

describe('footagePhrases', () => {
	it('splits on a ≥ 0.5 s gap, a speaker change, a caption break and 12 s of length', () => {
		const words: W[] = [
			['Hello', 0, 0.4, { speaker: 'A' }],
			['there.', 0.5, 0.9, { speaker: 'A' }],
			// gap 0.5 s → new phrase
			['Next', 1.4, 1.8, { speaker: 'A' }],
			// speaker change → new phrase
			['Other', 1.9, 2.2, { speaker: 'B' }],
			// caption break → new phrase
			['Break', 2.3, 2.5, { speaker: 'B', br: 'line' }],
		];
		// 13 one-second words without gaps: split before the word that would make the phrase longer than 12 s
		for (let k = 0; k < 13; k++) words.push([`w${k}`, 3 + k, 4 + k, { speaker: 'B' }]);
		const t = transcript('t1', 'm1', words);
		const ph = footagePhrases(t.words, { end: 100 * S });
		expect(ph.map((p) => p.words.map((w) => w.text).join(' '))).toEqual([
			'Hello there.',
			'Next',
			'Other',
			'Break',
			'w0 w1 w2 w3 w4 w5 w6 w7 w8 w9 w10 w11',
			'w12',
		]);
		// a gap of just under 0.5 s does not split
		const near = footagePhrases(
			transcript('t2', 'm1', [
				['a', 0, 1],
				['b', 1.49, 2],
			]).words,
			{ end: 10 * S },
		);
		expect(near).toHaveLength(1);
	});

	it('skips nonfinite, reversed and empty words and clamps to the media bounds', () => {
		const t = transcript('t1', 'm1', [
			['ok', 1, 2],
			['', 2, 2.1],
			['late', 9.5, 11],
			['after', 12, 13],
		]);
		const words = [
			...t.words,
			{ text: 'nan', start: Number.NaN, end: 5, confidence: 1, speaker: null, breakBefore: 'none' as const },
			{ text: 'rev', start: 5 * S, end: 4 * S, confidence: 1, speaker: null, breakBefore: 'none' as const },
			{
				text: 'inf',
				start: 3 * S,
				end: Number.POSITIVE_INFINITY,
				confidence: 1,
				speaker: null,
				breakBefore: 'none' as const,
			},
		];
		const ph = footagePhrases(words, { end: 10 * S });
		expect(ph.map((p) => p.words.map((w) => w.text))).toEqual([['ok'], ['late']]);
		expect(ph[1]!.end).toBe(10 * S);
	});
});

describe('packFootageDigest', () => {
	it('renders every media with sound: phrases, speakers, low-confidence marks, untranscribed media', () => {
		const { h, video, audio } = project();
		const doc = withTranscripts(h.doc, [
			transcript('t1', video, [
				['Ninety', 2.52, 2.9, { speaker: 'spk_a' }],
				['percent', 3, 3.4, { speaker: 'spk_a' }],
				['is', 3.5, 3.7, { speaker: 'spk_a', conf: 0.4 }],
				['wasted.', 3.8, 5.36, { speaker: 'spk_a' }],
				['Right.', 5.9, 9.12, { speaker: 'spk_b' }],
			]),
		]);
		const r = packFootageDigest(doc, {});
		if (!r.ok) throw new Error(r.message);
		const name = (id: string) =>
			Object.values(doc.items).find((i) => i.kind === 'media' && i.mediaId === id)!.name;
		expect(r.text).toBe(
			[
				'# Footage digest: Test',
				`## ${video} "${name(video)}" (43.0 s, 1920×1080 29.97 fps, 2 phrases, speakers S0 S1)`,
				'  [002.52-005.36] S0 Ninety percent ~is wasted.',
				'  [005.90-009.12] S1 Right.',
				`## ${audio} "${name(audio)}" (12.0 s, audio only) — no transcript: transcribe it with \`transcribe\``,
				'',
			].join('\n'),
		);
		expect(r.shown).toEqual([video, audio]);
		expect(r.notShown).toEqual([]);
	});

	it('pads times to the widest time in the digest (at least three digits)', () => {
		const h = new Harness();
		const long = h.registerVideo({ seconds: 4000 });
		const doc = withTranscripts(h.doc, [transcript('t1', long, [['Late', 3601.5, 3602]])]);
		const r = packFootageDigest(doc, {});
		if (!r.ok) throw new Error(r.message);
		expect(r.text).toContain('  [3601.50-3602.00] Late');
	});

	it('orders media by project bin order, then name', () => {
		const h = new Harness();
		const a = h.registerVideo({ seconds: 5 });
		const b = h.registerVideo({ seconds: 5 });
		const c = h.registerVideo({ seconds: 5 });
		const itemOf = (id: string) =>
			Object.values(h.doc.items).find((i) => i.kind === 'media' && i.mediaId === id)!.id;
		// put b's item first in a bin at the top; a and c stay in the root
		h.ok([{ type: 'bin.create', name: 'Bin', index: 0 }]);
		const bin = Object.values(h.doc.items).find((i) => i.kind === 'bin')!.id;
		h.ok([{ type: 'item.move', itemIds: [itemOf(b)], toBinId: bin }]);
		const doc = h.doc;
		expect(doc.rootItems[0]).toBe(bin);
		const r = packFootageDigest(doc, {});
		if (!r.ok) throw new Error(r.message);
		expect(r.shown).toEqual([b, a, c]);
		// media without a Project item come last, by name
		const orphan = {
			...doc,
			items: Object.fromEntries(Object.entries(doc.items).filter(([id]) => id !== itemOf(a))),
		};
		const r2 = packFootageDigest(orphan, {});
		if (!r2.ok) throw new Error(r2.message);
		expect(r2.shown).toEqual([b, c, a]);
	});

	it('restricts to mediaIds and refuses unknown ids', () => {
		const { h, video, audio, still } = project();
		const r = packFootageDigest(h.doc, { mediaIds: [audio] });
		if (!r.ok) throw new Error(r.message);
		expect(r.shown).toEqual([audio]);
		// a still named explicitly is listed (no sound)
		const s = packFootageDigest(h.doc, { mediaIds: [still, video] });
		if (!s.ok) throw new Error(s.message);
		expect(s.shown).toEqual([video, still]);
		expect(s.text).toContain(`## ${still} "`);
		expect(s.text).toMatch(/still, no audio\)/);
		const bad = packFootageDigest(h.doc, { mediaIds: ['med_nope'] });
		expect(bad).toMatchObject({ ok: false, code: 'E_NOT_FOUND' });
	});

	it('truncates only at whole-media boundaries and says what is missing', () => {
		const h = new Harness();
		const ids = [0, 1, 2, 3].map(() => h.registerVideo({ seconds: 60 }));
		const words = (n: number): W[] => Array.from({ length: n }, (_, k) => [`word${k}`, k, k + 0.4] as W);
		const doc = withTranscripts(
			h.doc,
			ids.map((id, k) => transcript(`t${k}`, id, words(40))),
		);
		const full = packFootageDigest(doc, {});
		if (!full.ok) throw new Error(full.message);
		const perMedia = Math.ceil(full.text.length / 4);
		const r = packFootageDigest(doc, { maxChars: Math.max(1000, perMedia * 2 + 10) });
		if (!r.ok) throw new Error(r.message);
		expect(r.text.length).toBeLessThanOrEqual(Math.max(1000, perMedia * 2 + 10));
		expect(r.notShown.length).toBeGreaterThan(0);
		expect(r.shown.length + r.notShown.length).toBe(4);
		expect(r.text.trimEnd().endsWith(`… ${r.notShown.length} more media not shown: pass mediaIds`)).toBe(
			true,
		);
		// every shown media has all its phrases
		for (const id of r.shown) expect(r.text.split(`## ${id}`)[1]!.split('\n## ')[0]).toContain('word39');
	});

	it('cuts a single media larger than maxChars at a phrase boundary with a notice', () => {
		const h = new Harness();
		const id = h.registerVideo({ seconds: 4000 });
		const words: W[] = Array.from({ length: 2000 }, (_, k) => [`phrase${k}`, k * 1.5, k * 1.5 + 0.5] as W);
		const doc = withTranscripts(h.doc, [transcript('t', id, words)]);
		const r = packFootageDigest(doc, { maxChars: 1000 });
		if (!r.ok) throw new Error(r.message);
		expect(r.text.length).toBeLessThanOrEqual(1000);
		expect(r.shown).toEqual([id]);
		expect(r.cutPhrases).toBeGreaterThan(0);
		const lines = r.text.trimEnd().split('\n');
		expect(lines.at(-1)).toMatch(/^ {2}… \d+ more phrases not shown: pass a larger maxChars \(≤ 200000\)$/);
		// whole phrase lines only
		for (const l of lines.slice(2, -1)) expect(l).toMatch(/^ {2}\[\d{3,}\.\d\d-\d{3,}\.\d\d\] phrase\d+$/);
	});

	it('renders one sequence in sequence time', () => {
		const h = new Harness();
		const id = h.registerVideo({ seconds: 20 });
		h.ok([
			{
				type: 'clip.place',
				source: { mediaId: id },
				sourceRange: { in: { seconds: 5 }, out: { seconds: 15 } },
				at: 30,
			},
		]);
		const doc = withTranscripts(h.doc, [
			transcript('t', id, [
				['before', 1, 2],
				['Inside', 6, 6.5, { speaker: 'x' }],
				['clip.', 6.6, 7, { speaker: 'x' }],
			]),
		]);
		const r = packFootageDigest(doc, { sequenceId: h.seqId });
		if (!r.ok) throw new Error(r.message);
		// clip at frame 30 (1 s at 30 fps) plays media 5 s → 6 s media is 2 s sequence time
		const seqName = Object.values(doc.items).find(
			(i) => i.kind === 'sequence' && i.sequenceId === h.seqId,
		)!.name;
		expect(r.text).toContain(
			`## ${h.seqId} "${seqName}" (sequence, 11.0 s, 1920×1080 30 fps, 1 phrase, speakers S0)`,
		);
		expect(r.text).toContain('  [002.00-003.00] S0 Inside clip.');
		expect(r.text).not.toContain('before');
		expect(packFootageDigest(doc, { sequenceId: 'seq_nope' })).toMatchObject({
			ok: false,
			code: 'E_NOT_FOUND',
		});
		expect(packFootageDigest(doc, { sequenceId: h.seqId, mediaIds: [id] })).toMatchObject({
			ok: false,
			code: 'E_INVALID_PARAM',
		});
	});

	it('keeps names and words on one line', () => {
		const h = new Harness();
		const id = h.registerVideo({ seconds: 5 });
		const item = Object.values(h.doc.items).find((i) => i.kind === 'media')!;
		const doc = withTranscripts(
			{ ...h.doc, items: { ...h.doc.items, [item.id]: { ...item, name: 'evil\n## med_x "fake"' } } },
			[transcript('t', id, [['multi\nline', 1, 2]])],
		);
		const r = packFootageDigest(doc, {});
		if (!r.ok) throw new Error(r.message);
		expect(r.text.split('\n').filter((l) => l.startsWith('## '))).toHaveLength(1);
		expect(r.text).toContain('] multi line');
		expect(DIGEST_DEFAULT_MAX_CHARS).toBe(40_000);
	});
});
