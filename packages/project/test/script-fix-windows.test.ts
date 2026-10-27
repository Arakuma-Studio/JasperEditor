// Score windows always form a valid SC-092 request (spec 17 SC-030, SC-092): at most 224 words per reading, at most
// 64 readings per window, reading ids of at most 128 characters and words of 1–128 characters. Regression for the
// SC-105 accuracy harness, where a 23 s hallucination loop ("cab cab cab …", 238 words) made one packed window the
// worker refused, which failed the whole scoring job of that recording.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { FixCandidate, FixWord } from '../src/script-fix/candidates.ts';
import {
	ASR_READING_ID,
	buildScoreWindows,
	SCORE_REQUEST_LIMITS,
	SCORE_WINDOW_DEFAULTS,
	type ScoreWindow,
	scoreRequestWindows,
} from '../src/script-fix/windows.ts';
import { FLICKS_PER_SECOND } from '../src/time.ts';

const F = FLICKS_PER_SECOND;

/** Words `dur` s long with `gap` s between them, from 0.5 s. */
function timedWords(texts: string[], dur = 0.08, gap = 0.01): FixWord[] {
	return texts.map((text, k) => {
		const start = Math.round((0.5 + k * (dur + gap)) * F);
		return { text, start, end: start + Math.round(dur * F), confidence: 0.9 };
	});
}

/** The fields of a candidate that the windows read (the rest is irrelevant here). */
function cand(id: string, fromWord: number, toWord: number, script: string[]): FixCandidate {
	return { id, fromWord, toWord, script, needsAudio: true } as unknown as FixCandidate;
}

/** Every window is a valid SC-092 request window. */
function expectValidRequest(windows: readonly ScoreWindow[]) {
	const L = SCORE_REQUEST_LIMITS;
	for (const w of scoreRequestWindows(windows)) {
		expect(w.id.length).toBeLessThanOrEqual(L.idChars);
		expect(w.end - w.start).toBeLessThanOrEqual(30 * F);
		expect(w.end).toBeGreaterThan(w.start);
		expect(w.readings.length).toBeGreaterThanOrEqual(1);
		expect(w.readings.length).toBeLessThanOrEqual(L.readingsPerWindow);
		expect(new Set(w.readings.map((r) => r.id)).size).toBe(w.readings.length);
		for (const r of w.readings) {
			expect(r.id.length).toBeGreaterThanOrEqual(1);
			expect(r.id.length).toBeLessThanOrEqual(L.idChars);
			expect(r.words.length).toBeGreaterThanOrEqual(1);
			expect(r.words.length).toBeLessThanOrEqual(L.wordsPerReading);
			for (const x of r.words) {
				expect(x.trim().length).toBeGreaterThanOrEqual(1);
				expect(x.trim().length).toBeLessThanOrEqual(L.wordChars);
			}
		}
	}
	expect(new Set(windows.map((w) => w.id)).size).toBe(windows.length);
	// SC-030 muted gaps: sorted, disjoint, inside the window, never over a word of the window
	for (const w of windows) {
		expect(w.mute.length).toBeLessThanOrEqual(L.muteRanges);
		let at = w.start;
		for (const m of w.mute) {
			expect(m.start).toBeGreaterThanOrEqual(at);
			expect(m.end).toBeGreaterThan(m.start);
			expect(m.end).toBeLessThanOrEqual(w.end);
			at = m.end;
		}
	}
}

/** No word of a window lies in one of its muted ranges. */
function expectWordsAudible(words: readonly FixWord[], windows: readonly ScoreWindow[]) {
	for (const w of windows)
		for (let k = w.fromWord; k < w.toWord; k++)
			for (const m of w.mute) {
				const x = words[k]!;
				expect(x.end <= m.start || x.start >= m.end).toBe(true);
			}
}

describe('score windows respect the SC-092 request limits', () => {
	it('a hallucination loop longer than the word limit is split into several windows', () => {
		const texts = [
			...'Lo que nadie sabe es que modelé el cuarto en Pixelforge basado en el'.split(' '),
			...Array.from({ length: 230 }, () => 'cab'),
			...'y nada más'.split(' '),
		];
		const words = timedWords(texts); // ≈ 22.5 s without a 1 s gap: one stretch under 28 s
		const cs = [cand('c-name', 9, 10, ['Glimmerbox']), cand('c-loop', 200, 201, ['casa'])];
		const { windows, unplaced } = buildScoreWindows(words, cs);
		expect(unplaced).toEqual([]);
		expect(windows.length).toBeGreaterThanOrEqual(2);
		for (const w of windows)
			expect(w.toWord - w.fromWord).toBeLessThanOrEqual(SCORE_WINDOW_DEFAULTS.maxWords);
		expect(windows.flatMap((w) => w.regions.map((g) => g.candidateId)).sort()).toEqual(['c-loop', 'c-name']);
		expectValidRequest(windows);
	});

	it('a window with more candidates than the readings limit is repeated over the same audio', () => {
		const words = timedWords(Array.from({ length: 90 }, (_, k) => `palabra${k}`));
		const cs = Array.from({ length: 80 }, (_, k) => cand(`c${k}`, k, k + 1, [`nueva${k}`]));
		const { windows, unplaced } = buildScoreWindows(words, cs);
		expect(unplaced).toEqual([]);
		expect(windows).toHaveLength(2);
		expect(windows[1]!.start).toBe(windows[0]!.start);
		expect(windows[1]!.end).toBe(windows[0]!.end);
		for (const w of windows) expect(w.readings[0]!.id).toBe(ASR_READING_ID);
		const placed = windows.flatMap((w) => w.regions.map((g) => g.candidateId));
		expect(placed).toHaveLength(80);
		expect(new Set(placed).size).toBe(80);
		expectValidRequest(windows);
	});

	it('a packed window mutes the gaps between its stretches (SC-030); unpacked and unmuted stay options', () => {
		const F2 = (x: number) => Math.round(x * F);
		// three stretches 0.5–2.0 s, 6.0–7.5 s (4 s gap), 9.0–10.0 s (1.5 s gap)
		const at = (t0: number, n: number, d = 0.3, g = 0.0) =>
			Array.from({ length: n }, (_, k) => ({ text: `p${t0}_${k}`, start: F2(t0 + k * (d + g)), end: F2(t0 + k * (d + g) + d) }));
		const words: FixWord[] = [...at(0.5, 5), ...at(6, 5), ...at(9, 3, 0.3, 0.05)];
		const cs = [cand('a', 1, 2, ['x']), cand('b', 7, 8, ['y']), cand('c', 11, 12, ['z'])];
		const packed = buildScoreWindows(words, cs);
		expect(packed.windows).toHaveLength(1);
		const w = packed.windows[0]!;
		const parts = buildScoreWindows(words, cs, { pack: false }).windows;
		expect(parts).toHaveLength(3);
		expect(w.start).toBe(parts[0]!.start);
		expect(w.end).toBe(parts[2]!.end);
		expect(w.mute).toEqual([
			{ start: parts[0]!.end, end: parts[1]!.start },
			{ start: parts[1]!.end, end: parts[2]!.start },
		]);
		// pads: 0.35 s after a stretch, 0.25 s before the next (gaps ≥ 1 s are wider than both)
		expect(w.mute[0]).toEqual({ start: words[4]!.end + F2(0.35), end: words[5]!.start - F2(0.25) });
		expect(buildScoreWindows(words, cs, { muteGaps: false }).windows[0]!.mute).toEqual([]);
		expectValidRequest(packed.windows);
		expectWordsAudible(words, packed.windows);
	});

	it('reading ids stay short whatever the candidate ids (long media ids)', () => {
		const words = timedWords('hoy probamos el motor de pixelforch con un nivel nuevo'.split(' '));
		const long = `sf1~${'m'.repeat(120)}~0123456789abcdef#12`;
		const { windows } = buildScoreWindows(words, [cand(long, 5, 6, ['Pixelforge'])]);
		expect(windows).toHaveLength(1);
		expect(windows[0]!.regions[0]).toMatchObject({ candidateId: long });
		expectValidRequest(windows);
	});

	it('words the worker cannot read (empty, over 128 characters) are never sent; their candidates are unplaced', () => {
		const texts = 'uno dos tres cuatro cinco seis siete ocho nueve diez once doce'.split(' ');
		texts[3] = '  ';
		texts[8] = 'x'.repeat(129);
		const words = timedWords(texts);
		const cs = [
			cand('ok-before', 1, 2, ['doz']),
			cand('on-empty', 3, 4, ['cuatro']),
			cand('ok-middle', 5, 6, ['seiz']),
			cand('on-long', 8, 9, ['nueve']),
			cand('long-script', 10, 11, ['y'.repeat(200)]),
			cand('ok-after', 11, 12, ['doze']),
		];
		const { windows, unplaced } = buildScoreWindows(words, cs);
		expect(unplaced.map((u) => u.candidateId).sort()).toEqual(['long-script', 'on-empty', 'on-long']);
		expect(windows.flatMap((w) => w.regions.map((g) => g.candidateId)).sort()).toEqual([
			'ok-after',
			'ok-before',
			'ok-middle',
		]);
		expectValidRequest(windows);
	});

	it('property: any words and candidates give a valid request; every audio candidate is placed or unplaced once', () => {
		const word = fc.oneof(
			fc.constantFrom('hola', 'cab', 'el', 'Glimmerbox', '¿Qué', 'pasa?', ''),
			fc.string({ maxLength: 140 }),
		);
		fc.assert(
			fc.property(
				fc.array(
					fc.tuple(
						word,
						// word lengths up to 2.8 s, now and then a word longer than a window (35 s)
						fc.oneof(
							{ weight: 20, arbitrary: fc.integer({ min: 0, max: 2_000_000_000 }) },
							{ weight: 1, arbitrary: fc.integer({ min: 20_000_000_000, max: 25_000_000_000 }) },
						),
						fc.integer({ min: 0, max: 1_500_000_000 }),
					),
					{
						minLength: 1,
						maxLength: 400,
					},
				),
				fc.array(
					fc.tuple(
						fc.nat(),
						fc.integer({ min: 0, max: 4 }),
						fc.array(fc.oneof(fc.constantFrom('casa', 'Pixelforge'), fc.string({ maxLength: 140 })), {
							maxLength: 8,
						}),
					),
					{ maxLength: 120 },
				),
				(spec, cspec) => {
					let t = 0;
					const words: FixWord[] = spec.map(([text, dur, gap]) => {
						const start = t + gap;
						t = start + dur;
						return { text, start, end: start + dur };
					});
					const cs = cspec.map(([at, n, script], k) => {
						const from = at % words.length;
						const to = Math.min(words.length, from + n);
						return cand(`c${k}`, from, to, script.length ? script : ['x']);
					});
					const { windows, unplaced } = buildScoreWindows(words, cs);
					expectValidRequest(windows);
					expectWordsAudible(words, windows);
					const seen = [
						...windows.flatMap((w) => w.regions.map((g) => g.candidateId)),
						...unplaced.map((u) => u.candidateId),
					];
					expect(seen.sort()).toEqual(cs.map((c) => c.id).sort());
				},
			),
			{ numRuns: 150 },
		);
	});
});
