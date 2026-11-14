// Cut edges outside speech (docs/wp-notes/transcript-cleanup.md "Cut edges outside speech"), from a user's by-ear
// review of a real cut of their 57-minute Spanish source: joins that ended inside a word's fading decay, and a stutter
// removal that took the kept word's onset ("Y | Y lo peor" kept "-Y"). The fixture holds the source's own voice
// analysis planes and transcript words around two such cuts (5 s each; `fixtures/cleanup-cut-edges-source.json`).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { CleanupVoice } from '../src/cleanup/detector.ts';
import { edgeBounds, edgeLevelsOf, edgeScore, snapCut } from '../src/cleanup/edge-snap.ts';
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
		// removed "mos" to 0.25 (its timestamp runs to 0.32), a 20 ms dip, the kept word's attack from 0.27
		const db = [...word(25, -14), -38, -38, ...word(30, -12)];
		const L = env(db);
		const words = [
			{ s: 0, e: 0.32 },
			{ s: 0.32, e: 0.56 },
		];
		const b = edgeBounds(words, 0.32, 'in');
		const s = snapCut(L, { t: 0.32, side: 'in', ...b });
		expect(s.t).toBeCloseTo(0.26, 5);
		// without the dip (a level wobble of 2 dB) the edge stays at the word boundary
		const wobble = env([...word(25, -14), -16, -16, ...word(30, -14)]);
		expect(snapCut(wobble, { t: 0.32, side: 'in', ...b }).t).toBeCloseTo(0.32, 5);
	});
});
