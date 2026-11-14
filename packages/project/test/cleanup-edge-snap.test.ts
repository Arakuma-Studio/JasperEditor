// Cut edges outside speech (docs/wp-notes/transcript-cleanup.md "Cut edges outside speech"), from a user's by-ear
// review of a real cut of their 57-minute Spanish source: joins that ended inside a word's fading decay, and a stutter
// removal that took the kept word's onset ("Y | Y lo peor" kept "-Y"). The fixture holds the source's own voice
// analysis planes and transcript words around two such cuts (5 s each; `fixtures/cleanup-cut-edges-source.json`).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { CleanupVoice } from '../src/cleanup/detector.ts';
import {
	edgeBounds,
	edgeInsideWord,
	edgeLevelsOf,
	edgeScore,
	onsetBound,
	snapCut,
} from '../src/cleanup/edge-snap.ts';
import { FAST_SETTINGS } from '../src/cleanup/schema.ts';
import { analyzeSequenceCleanup } from '../src/cleanup/sequence.ts';
import { FLICKS_PER_SECOND } from '../src/time.ts';
import { Harness, videoAsset } from './helpers.ts';

type Window = {
	from: number;
	level: string;
	voicing: string;
	flatness: string;
	classes: string;
	words: Array<[string, number, number, number | null]>;
};
const FIX = JSON.parse(
	readFileSync(new URL('./fixtures/cleanup-cut-edges-source.json', import.meta.url), 'utf8'),
) as {
	decay: Window;
	stutter: Window;
	breathNo: Window;
	breathY: Window;
	closureMostrar: Window;
	closurePixel: Window;
	skins: Window;
	unity: Window;
	appstore: Window;
	pue: Window;
	levels: CleanupVoice['levels'];
};
const bytes = (b64: string) => new Uint8Array(Buffer.from(b64, 'base64'));
const S = (x: number) => Math.round(x * FLICKS_PER_SECOND);
const FPS = 60;

function voiceOf(w: Window): CleanupVoice {
	const level = bytes(w.level);
	return {
		level,
		voicing: bytes(w.voicing),
		flatness: bytes(w.flatness),
		classes: bytes(w.classes),
		frameCount: level.length,
		levels: FIX.levels,
	};
}

/** Clean Up (Fast) of one 60 fps clip holding the window: the voice, the cut edges (media seconds). */
function planOf(w: Window) {
	const voice = voiceOf(w);
	const H = new Harness({ preset: 'hd-1080p-60' });
	const r0 = H.ok([
		{ type: 'media.register', asset: videoAsset({ seconds: voice.frameCount / 100, kind: 'audio' }) },
	]);
	const mediaId = (r0.results[0] as { mediaId: string }).mediaId;
	H.ok([{ type: 'clip.place', source: { mediaId }, at: 0, tracks: { audio: ['A1'] }, mode: 'overwrite' }]);
	const words = w.words
		.filter(([, s]) => s >= 0)
		.map(([text, s, e, c]) => ({ text, start: S(s), end: S(e), confidence: c ?? 0.95 }));
	H.ok([{ type: 'transcript.create', mediaId, language: 'es', origin: 'manual', words }]);
	const a = analyzeSequenceCleanup({ doc: H.doc, seq: H.seq, voice: () => voice, settings: FAST_SETTINGS });
	if (!a.ok) throw new Error(a.message);
	const end = H.seq.clips[Object.keys(H.seq.clips)[0]!]!.duration;
	const edges: Array<{ side: 'in' | 'out'; t: number }> = [];
	for (const k of a.plan.kept) {
		if (k.start > 0) edges.push({ side: 'in', t: k.start / FPS });
		if (k.end < end) edges.push({ side: 'out', t: k.end / FPS });
	}
	return { a, voice, edges, words };
}

describe('Clean Up cut edges outside speech (real envelopes)', () => {
	it('a join keeps the fading decay of the word before the pause ("complejo de hacer,")', () => {
		const { voice, edges } = planOf(FIX.decay);
		const L = edgeLevelsOf(voice);
		// the pause after "hacer," (2.21 s): the out edge sits where the decay has gone quiet, not 30 dB into it
		const out = edges.find((e) => e.side === 'out' && e.t > 2.1 && e.t < 2.8);
		expect(out).toBeDefined();
		expect(edgeScore(L, out!.t, 'out')).toBeLessThanOrEqual(0);
	});

	it('a stutter removal keeps the onset of the kept word ("Y | Y lo peor")', () => {
		const { a, voice, edges, words } = planOf(FIX.stutter);
		const L = edgeLevelsOf(voice);
		// the first "Y" of "Y Y lo peor" goes (stutter); the second stays
		const y2 = words.find((w) => w.text === 'Y' && w.start > S(2.2))!;
		const stutter = a.findings.find((f) => f.kind === 'stutter' && f.suggested === 'remove');
		expect(stutter).toBeDefined();
		const inn = edges.find((e) => e.side === 'in' && Math.abs(e.t - y2.start / FLICKS_PER_SECOND) < 0.12);
		expect(inn).toBeDefined();
		// no speech in the 50 ms cut away before it: the kept "Y" starts after the cut
		expect(edgeScore(L, inn!.t, 'in')).toBeLessThanOrEqual(0);
	});
});

describe('snapCut', () => {
	/** An envelope from dB values per 10 ms frame. */
	const env = (db: number[]) => ({
		frameCount: db.length,
		db: (k: number) => (k >= 0 && k < db.length ? db[k]! : -120),
		floorDb: -50,
		speechDb: -9,
	});
	const word = (n: number, d: number) => Array.from({ length: n }, () => d);

	it('follows a decay to quiet at an out edge, and never shortens the kept span onto speech', () => {
		// a word to 0.3 s, a decay from −12 to −48 over 0.2 s, silence
		const L = env([
			...word(30, -12),
			...Array.from({ length: 20 }, (_, i) => -12 - i * 1.8),
			...word(30, -50),
		]);
		const s = snapCut(L, { t: 0.3, side: 'out', keepMore: 1, cutMore: 0 });
		expect(s.clean).toBe(true);
		expect(s.t).toBeGreaterThan(0.4);
		expect(s.t).toBeLessThanOrEqual(0.5);
		// back-to-back loud speech: nothing clean, the edge stays (it may only keep more)
		const flat = env(word(80, -12));
		expect(snapCut(flat, { t: 0.4, side: 'out', keepMore: 0.5, cutMore: 0.3 })).toMatchObject({
			t: 0.4,
			clean: false,
		});
	});

	it('finds the attack before an in edge, inside the removed word only at a real dip', () => {
		// removed "mos" to 0.25 (its timestamp runs to 0.32), a 30 ms dip, the kept word's attack from 0.28
		const db = [...word(25, -14), -42, -42, -42, ...word(30, -12)];
		const L = env(db);
		const words = [
			{ s: 0, e: 0.32 },
			{ s: 0.32, e: 0.56 },
		];
		const b = edgeBounds(words, 0.32, 'in');
		const s = snapCut(L, { t: 0.32, side: 'in', ...b });
		expect(s.t).toBeCloseTo(0.28, 5); // the end of the dip: the attack
		// without the dip (a level wobble of 2 dB) the edge stays at the word boundary
		const wobble = env([...word(25, -14), -16, -16, -16, ...word(30, -14)]);
		expect(snapCut(wobble, { t: 0.32, side: 'in', ...b }).t).toBeCloseTo(0.32, 5);
	});
});

describe('snapCut on the source: breaths stay out, closures stay in the word (review of v7)', () => {
	/** The window's envelope and words in source seconds. */
	const source = (w: Window) => {
		const v = voiceOf(w);
		const L = edgeLevelsOf(v);
		const shifted = { ...L, db: (k: number) => L.db(k - Math.round(w.from * 100)) };
		const breath = (k: number) => L.breath!(k - Math.round(w.from * 100));
		const words = w.words.map(([, s, e]) => ({ s: s + w.from, e: e + w.from }));
		return { L: { ...shifted, frameCount: v.frameCount + Math.round(w.from * 100), breath }, words };
	};

	it('an in edge stops at the attack of "No había botones", not before the breath (1155.38–1155.65)', () => {
		const { L, words } = source(FIX.breathNo);
		// the edge at the word's (early) timestamp, inside the breath
		const s = snapCut(L, { t: 1155.4, side: 'in', ...edgeBounds(words, 1155.4, 'in'), words });
		expect(s.t).toBeGreaterThanOrEqual(1155.63);
		expect(s.t).toBeLessThanOrEqual(1155.67);
		expect(s.clean).toBe(true);
	});

	it('an in edge before "Y en el juego" leaves the breath (1873.20–1873.34) out', () => {
		const { L, words } = source(FIX.breathY);
		const s = snapCut(L, { t: 1873.12, side: 'in', ...edgeBounds(words, 1873.12, 'in'), words });
		expect(s.t).toBeGreaterThanOrEqual(1873.35);
		expect(s.t).toBeLessThanOrEqual(1873.41);
	});

	it('a closure inside a word is never a clean cut ("mos|trar" 1646.30–1646.36, "pi|xel" 741.44)', () => {
		const m = source(FIX.closureMostrar);
		expect(edgeInsideWord(m.L, m.words, 1646.36)).toBe(true);
		const s = snapCut(m.L, { t: 1646.36, side: 'in', ...edgeBounds(m.words, 1646.36, 'in'), words: m.words });
		expect(s.clean).toBe(false);
		const p = source(FIX.closurePixel);
		expect(edgeInsideWord(p.L, p.words, 741.44)).toBe(true);
		// between words a short gap is still a place to cut
		expect(edgeInsideWord(m.L, m.words, 1646.17)).toBe(false);
	});
});

describe('the review of v8 (source envelopes)', () => {
	const shift = (w: Window) => {
		const v = voiceOf(w);
		const L = edgeLevelsOf(v);
		const o = Math.round(w.from * 100);
		return {
			L: {
				...L,
				frameCount: v.frameCount + o,
				db: (k: number) => L.db(k - o),
				breath: (k: number) => L.breath!(k - o),
			},
			words: w.words.map(([, s, e]) => ({ s: s + w.from, e: e + w.from })),
		};
	};

	it('a removal never ends inside the next word\'s onset: "más | skins" keeps the unvoiced /s/', () => {
		const { voice, edges } = planOf(FIX.skins);
		const L = edgeLevelsOf(voice);
		// the second "skins" (its /s/ from 3227.58 s) is kept after the first one is removed
		const inn = edges.find((e) => e.side === 'in' && e.t > 0.85 && e.t < 1.1);
		expect(inn).toBeDefined();
		expect(inn!.t).toBeLessThanOrEqual(3227.585 - FIX.skins.from);
		const k = Math.round(inn!.t * 100);
		for (const q of [k - 3, k - 2, k - 1]) expect(L.db(q)).toBeLessThanOrEqual(-38);
	});

	it('an out edge waits for the decay of "Uni-ty" (1351.083 had −22 dBFS before and −30…−37 after)', () => {
		const { L, words } = shift(FIX.unity);
		const s = snapCut(L, { t: 1351.083, side: 'out', ...edgeBounds(words, 1351.083, 'out'), words });
		expect(s.t).toBeGreaterThanOrEqual(1351.28);
		const k = Math.round(s.t * 100);
		const after = Math.max(L.db(k), L.db(k + 1), L.db(k + 2), L.db(k + 3));
		expect(after).toBeLessThanOrEqual(-36);
	});

	it('an extension stops at the next syllable onset after a dip ("que | pue-"), not inside its own word', () => {
		const p = shift(FIX.pue);
		// from the end of "que" (2714.04): "pue-" rises again from −31 dBFS at 2714.13
		expect(onsetBound(p.L, 2714.04, 'out', p.words)).toBeLessThanOrEqual(2714.14);
		// the last syllable of a kept word after a shallow dip is no foreign onset
		const u = shift(FIX.unity);
		expect(onsetBound(u.L, 1351.04, 'out', [])).toBe(Number.POSITIVE_INFINITY);
	});

	it('a breath-like burst at the end of a kept piece is a fragment ("Appstore! | Y si", 171.71–171.91)', () => {
		// the words as the v8 transcript wrote them: "Appstore!" ends before the burst, "Y" sits on it
		const words = FIX.appstore.words.map((w): Window['words'][number] =>
			w[0] === 'Appstore!' ? [w[0], w[1], 171.7 - FIX.appstore.from, w[3]] : w,
		);
		words.push(['Y', 171.72 - FIX.appstore.from, 171.88 - FIX.appstore.from, null]);
		words.sort((x, y) => x[1] - y[1]);
		const { a } = planOf({ ...FIX.appstore, words });
		const f = a.findings.find((x) => x.kind === 'fragment');
		expect(f).toMatchObject({ suggested: 'review', reason: { params: { why: 'voice' } } });
		const [s, e] = [
			f!.range.start / FLICKS_PER_SECOND + FIX.appstore.from,
			f!.range.end / FLICKS_PER_SECOND + FIX.appstore.from,
		];
		expect(s).toBeGreaterThanOrEqual(171.68);
		expect(s).toBeLessThanOrEqual(171.73);
		expect(e).toBeGreaterThanOrEqual(171.88);
	});
});
