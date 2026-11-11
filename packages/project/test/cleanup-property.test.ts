// Properties of transcript cleanup (spec 14 TC-033, fast-check):
// - planning: kept pieces are sorted and disjoint, never hold the sound of a removed word, never cut a kept word's
//   loud core in two (unless the timestamps give part of it to a removed word), and stay inside the analysed media;
// - applying: one `cleanup.apply` (extract) gives the same timeline as one `range.extract` per range, right to left,
//   on the same tracks (clips, sources, links, groups, markers; ids aside), and the invariants hold.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { detectCleanup } from '../src/cleanup/detector.ts';
import { planMediaCuts, removedSpans } from '../src/cleanup/plan.ts';
import {
	type CleanupSettings,
	FAST_SETTINGS,
	FINDING_KINDS,
	mergeCleanupSettings,
	NATURAL_SETTINGS,
} from '../src/cleanup/schema.ts';
import { analyzeSequenceCleanup, type CleanupDecisions } from '../src/cleanup/sequence.ts';
import { checkInvariants, type ProjectDocument, type Sequence } from '../src/index.ts';
import { FLICKS_PER_SECOND } from '../src/time.ts';
import { Harness, videoAsset } from './helpers.ts';

/** Level edges trim a word's quiet onset and decay: removed voice this close (seconds) to a cut edge is the edge. */
const EDGE_S = 0.1;

const VOCAB = [
	'hola',
	'eh',
	'vamos',
	'a',
	'hacer',
	'un',
	'juego',
	'de',
	'carreras',
	'bueno',
	'la',
	'carretera',
	'mmm',
	'coches',
	'y',
];

/**
 * Random words over random sound: each word is speech (loud core + quieter edges), gaps are silence or breath — and,
 * with `murmurs`, voice without words in some gaps (the direct planner properties leave it out: their planner alone
 * places a word's sound by its speech frames ± 50 ms, not by the detector's partition).
 */
const recordingOf = (murmurs: boolean) =>
	fc
		.record({
			words: fc.array(
				fc.record({
					w: fc.constantFrom(...VOCAB),
					dur: fc.integer({ min: 8, max: 50 }),
					gap: fc.integer({ min: 0, max: 120 }),
					breath: fc.boolean(),
					jitterA: fc.integer({ min: -5, max: 5 }),
					jitterB: fc.integer({ min: -5, max: 8 }),
					loud: fc.integer({ min: 30, max: 45 }),
					// voice without words in the gap before the word: frames after the previous word, length, dB over the floor
					murmur: fc.record({
						off: fc.integer({ min: 0, max: 10 }),
						len: fc.integer({ min: 0, max: 40 }),
						db: fc.integer({ min: 3, max: 30 }),
					}),
				}),
				{ minLength: 1, maxLength: 60 },
			),
			natural: fc.boolean(),
		})
		.map(({ words, natural }) => {
			let f = 20;
			const lay = words.map((x) => {
				const a = f + x.gap;
				const b = a + x.dur;
				f = b;
				return { ...x, a, b };
			});
			const n = f + 40;
			const level = new Uint8Array(n).fill((-65 + 120) * 2);
			const classes = new Uint8Array(n);
			let prevB = -1;
			for (const x of lay) {
				// untranscribed voice inside the pause before the word (round 7: an accepted pause took 0.227 s of it)
				const m = x.murmur;
				if (murmurs && prevB >= 0 && m.len > 0 && x.a - prevB >= m.off + m.len + 30)
					for (let k = prevB + m.off; k < prevB + m.off + m.len; k++) {
						level[k] = (-65 + m.db + 120) * 2;
						classes[k] = 2;
					}
				prevB = x.b;
				for (let k = x.a; k < x.b; k++) {
					const edge = k < x.a + 2 || k >= x.b - 2;
					level[k] = (-65 + (edge ? 15 : x.loud) + 120) * 2;
					classes[k] = 2;
				}
				for (let k = x.b; k < Math.min(n, x.b + 6); k++) level[k] = (-65 + 18 - (k - x.b) * 3 + 120) * 2;
				// a rising onset before the word (non-speech, above the floor) where the gap leaves room
				if (x.gap >= 12) for (let q = 1; q <= 3; q++) level[x.a - q] = (-65 + 13 - 4 * q + 120) * 2;
				if (x.breath && x.gap > 30) for (let k = x.a - 25; k < x.a - 5; k++) classes[k] = 1;
			}
			const words2 = lay.map((x) => ({
				text: x.w,
				start: Math.round(((x.a + x.jitterA) / 100) * FLICKS_PER_SECOND),
				end: Math.round(((x.b + x.jitterB) / 100) * FLICKS_PER_SECOND),
				confidence: 0.9,
				loud: [x.a + 2, x.b - 2] as [number, number],
			}));
			for (let i = 1; i < words2.length; i++)
				if (words2[i]!.start < words2[i - 1]!.end) words2[i]!.start = words2[i - 1]!.end;
			for (const w of words2) if (w.end <= w.start) w.end = w.start + 1;
			return {
				words: words2,
				voice: {
					classes,
					level,
					frameCount: n,
					levels: { floorDb: -65, speechDb: -25, speechThresholdDb: -53, breathFloorDb: -60 },
				},
				settings: natural ? NATURAL_SETTINGS : FAST_SETTINGS,
			};
		});
const recording = recordingOf(false);

describe('planning properties', () => {
	it('kept pieces are sorted, disjoint, inside the media, without removed sound, without split words', () => {
		fc.assert(
			fc.property(recording, (r) => {
				const d = detectCleanup({
					mediaId: 'med_p',
					words: r.words,
					voice: r.voice,
					language: 'es',
					settings: r.settings,
				});
				const removedIdx = new Set<number>();
				for (const f of d.findings)
					if (f.words && f.suggested === 'remove')
						for (let i = f.words[0]; i <= f.words[1]; i++) removedIdx.add(i);
				const removed = d.words.map((w, k) => d.guarded[k] || removedIdx.has(w.i));
				const plan = planMediaCuts({ words: d.words, removed, voice: r.voice, settings: r.settings });
				const kept = plan.kept;
				for (let i = 0; i < kept.length; i++) {
					expect(kept[i]![1]).toBeGreaterThan(kept[i]![0]);
					if (i > 0) expect(kept[i]![0]).toBeGreaterThan(kept[i - 1]![1]);
					expect(kept[i]![0]).toBeGreaterThanOrEqual(0);
				}
				// no removed sound kept
				const keepIdx = d.words.map((_, k) => k).filter((k) => !removed[k]);
				for (const [x, y] of removedSpans({ words: d.words, removed }, keepIdx, r.voice, true))
					for (const [a, b] of kept) expect(Math.min(b, y) - Math.max(a, x)).toBeLessThanOrEqual(1e-9);
				// a kept word's loud core is all in one piece, or (a too-short piece) not kept at all
				d.words.forEach((w, k) => {
					if (removed[k]) return;
					const [la, lb] = r.words[w.i]!.loud;
					if (lb <= la) return;
					const a = la / 100;
					const b = lb / 100;
					// unless the transcript gives part of that sound to a removed word (no right answer then)
					if (d.words.some((x, j) => removed[j] && x.s < b && x.e > a)) return;
					const overlap = kept.filter(([x, y]) => x < b && y > a);
					if (overlap.length === 0) return;
					expect(overlap).toHaveLength(1);
					expect(overlap[0]![0]).toBeLessThanOrEqual(a + 1e-9);
					expect(overlap[0]![1]).toBeGreaterThanOrEqual(b - 1e-9);
				});
			}),
			{ numRuns: 300 },
		);
	});

	it('every removed second is explained by a finding, and rejecting every finding removes nothing', () => {
		fc.assert(
			fc.property(recording, (r) => {
				const d = detectCleanup({
					mediaId: 'med_p',
					words: r.words,
					voice: r.voice,
					language: 'es',
					settings: r.settings,
				});
				const sec = (f: number) => f / FLICKS_PER_SECOND;
				const span = (f: (typeof d.findings)[number]) =>
					[sec(f.range.start), sec(f.range.end)] as [number, number];
				const removing = d.findings.filter((f) => f.suggested === 'remove');
				const removedIdx = new Set<number>();
				for (const f of removing)
					if (f.words) for (let i = f.words[0]; i <= f.words[1]; i++) removedIdx.add(i);
				const removed = d.words.map((w, k) => d.guarded[k] || removedIdx.has(w.i));
				const of = (kind: string, pred: (f: (typeof d.findings)[number]) => boolean) =>
					d.findings.filter((f) => f.kind === kind && pred(f)).map(span);
				const plan = planMediaCuts({
					words: d.words,
					removed,
					voice: r.voice,
					settings: r.settings,
					keepSpeech: of('untranscribed', (f) => f.suggested !== 'remove'),
					covered: removing.map(span),
				});
				if (!d.words.length) return;
				const lo = Math.ceil(Math.min(...d.words.map((w) => w.s)) * 100);
				const hi = Math.floor(Math.max(...d.words.map((w) => w.e)) * 100);
				const inKept = (f: number, kept: ReadonlyArray<readonly [number, number]>) =>
					kept.some(([a, b]) => (f + 0.5) / 100 >= a && (f + 0.5) / 100 < b);
				// voice the plan removes lies within a removing finding (or the edge tolerance of one or of a kept piece)
				const tol = EDGE_S + 0.01;
				const edges = plan.kept.map(([a, b]) => [a - tol, b + tol] as const);
				for (let f = lo; f < hi; f++)
					if (r.voice.classes[f] === 2 && !inKept(f, edges))
						expect(
							removing.some((x) => (f + 0.5) / 100 >= span(x)[0] - tol && (f + 0.5) / 100 < span(x)[1] + tol),
							`voice at ${f / 100} removed without a finding`,
						).toBe(true);
				// everything rejected: one piece from the first word to the last (their outer edges aside)
				const all = planMediaCuts({
					words: d.words,
					removed: d.words.map(() => false),
					voice: r.voice,
					settings: r.settings,
					keepSpeech: of('untranscribed', () => true),
					keepPauses: of('pause', () => true),
					keepBreaths: of('breath', () => true),
					covered: [],
				});
				const t = Math.round(tol * 100);
				for (let f = lo + t; f < hi - t; f++)
					expect(inKept(f, all.kept), `${f / 100} removed with every finding off`).toBe(true);
			}),
			{ numRuns: 200 },
		);
	});

	it('a sequence plan removes nothing outside accepted findings; rejecting them all or reviewing every rule removes nothing', () => {
		const RULES = Object.keys(FAST_SETTINGS.rules) as Array<keyof CleanupSettings['rules']>;
		const REVIEW_ONLY = new Set(['fillerLexical', 'untranscribed', 'asrSuspect']);
		const action = (k: string) =>
			REVIEW_ONLY.has(k) ? fc.constantFrom('review', 'off') : fc.constantFrom('remove', 'review', 'off');
		const kinds = fc.subarray([...FINDING_KINDS]);
		fc.assert(
			fc.property(
				recordingOf(true),
				fc.record(Object.fromEntries(RULES.map((k) => [k, action(k)]))),
				fc.record({ acceptKinds: kinds, rejectKinds: kinds }),
				(r, rules, decisions) => {
					const settings: CleanupSettings = { ...r.settings, rules: { ...r.settings.rules, ...rules } };
					const seconds = r.voice.frameCount / 100;
					const H = new Harness({ preset: 'hd-1080p-30' });
					const r0 = H.ok([{ type: 'media.register', asset: videoAsset({ seconds, kind: 'audio' }) }]);
					const mediaId = (r0.results[0] as { mediaId: string }).mediaId;
					H.ok([
						{ type: 'clip.place', source: { mediaId }, at: 0, tracks: { audio: ['A1'] }, mode: 'overwrite' },
					]);
					H.ok([
						{
							type: 'transcript.create',
							mediaId,
							language: 'es',
							origin: 'manual',
							words: r.words.map((w) => ({
								text: w.text,
								start: w.start,
								end: w.end,
								confidence: w.confidence,
							})),
						},
					]);
					const run = (s: CleanupSettings, d: CleanupDecisions) => {
						const a = analyzeSequenceCleanup({
							doc: H.doc,
							seq: H.seq,
							voice: () => r.voice,
							settings: s,
							decisions: d,
						});
						if (!a.ok) throw new Error(a.message);
						return a;
					};
					const a = run(settings, decisions);
					const sec = (f: number) => f / FLICKS_PER_SECOND;
					// what the user accepted: item decisions aside, a kind decision or the rule's suggestion
					const covered = a.findings
						.filter((f) =>
							decisions.rejectKinds.includes(f.kind)
								? false
								: decisions.acceptKinds.includes(f.kind) || f.suggested === 'remove',
						)
						.map((f) => [sec(f.range.start), sec(f.range.end)] as const);
					const frame = 1 / 30;
					const inCovered = (t: number) => covered.some(([x, y]) => t >= x - 1e-9 && t <= y + 1e-9);
					const nearCovered = (t: number) =>
						covered.some(([x, y]) => t >= x - frame - 1e-6 && t <= y + frame + 1e-6);
					const silent = (k: number) => r.voice.classes[k] !== 2 && r.voice.level[k]! < (-65 + 6 + 120) * 2;
					const accepted = (f: (typeof a.findings)[number]) =>
						!decisions.rejectKinds.includes(f.kind) &&
						(decisions.acceptKinds.includes(f.kind) || f.suggested === 'remove');
					const spanOf = (f: (typeof a.findings)[number]) => [sec(f.range.start), sec(f.range.end)] as const;
					const untranscribed = a.findings
						.filter((f) => f.kind === 'untranscribed' && !accepted(f))
						.map(spanOf);
					const wordRemovals = a.findings
						.filter((f) => f.words && f.kind !== 'pause' && f.kind !== 'breath' && accepted(f))
						.map(spanOf);
					const overlaps = (t0: number, t1: number, s: ReadonlyArray<readonly [number, number]>) =>
						s.some(([x, y]) => x < t1 - 1e-9 && y > t0 + 1e-9);
					const inSpans = (t0: number, t1: number, s: ReadonlyArray<readonly [number, number]>) =>
						s.some(([x, y]) => x <= t0 + 1e-9 && y >= t1 - 1e-9);
					for (const range of a.plan.ranges) {
						// every removed 10 ms of media lies in an accepted finding, or within a frame of one over silence
						for (
							let k = Math.floor((range.start * frame) / 0.01);
							k < Math.ceil((range.end * frame) / 0.01);
							k++
						) {
							const t0 = Math.max(k * 0.01, range.start * frame);
							const t1 = Math.min((k + 1) * 0.01, range.end * frame);
							if (t1 - t0 < 1e-9) continue;
							// (or in the frame at or before the start of a removal of words: the grid cannot split two words)
							const ok =
								(inCovered(t0) && inCovered(t1)) ||
								(silent(k) && nearCovered(t0) && nearCovered(t1)) ||
								wordRemovals.some(([x, y]) => t0 >= x - frame - 1e-6 && t1 <= y + 1e-9);
							expect(ok, `${t0.toFixed(3)}–${t1.toFixed(3)} removed without an accepted finding`).toBe(true);
							// voice without words stays unless its own finding (or a removal of words around it) is accepted: an
							// accepted pause next to it never takes it (round 7: 0.227 s of an unaccepted untranscribed finding)
							if (r.voice.classes[k] === 2 && overlaps(t0, t1, untranscribed))
								expect(
									inSpans(t0, t1, wordRemovals),
									`voice ${t0.toFixed(3)}–${t1.toFixed(3)} of an unaccepted untranscribed finding removed`,
								).toBe(true);
						}
					}
					// no cut takes a kept word's rising onset after silence, nor the fading decay after the last kept word: the
					// edges sit in measured silence (frames inside a removed word's time aside — the timestamps decide there)
					const removedWords = new Set<number>();
					for (const f of a.findings)
						if (f.words && covered.some(([x, y]) => x === sec(f.range.start) && y === sec(f.range.end)))
							for (let i = f.words[0]; i <= f.words[1]; i++) removedWords.add(i);
					const inRemovedWord = (k: number) =>
						r.words.some(
							(w, i) =>
								removedWords.has(i) && sec(w.end) > k * 0.01 + 1e-9 && sec(w.start) < (k + 1) * 0.01 - 1e-9,
						);
					const removedFrame = (k: number) =>
						a.plan.ranges.some(
							(g) => g.start * frame < (k + 1) * 0.01 - 1e-6 && g.end * frame > k * 0.01 + 1e-6,
						);
					const speechAt = (k: number) => r.voice.classes[k] === 2;
					const keptSpeech = r.words
						.map((w, i) => ({ w, i }))
						.filter(({ i }) => !removedWords.has(i))
						.map(({ w }) => w.loud);
					const n = r.voice.frameCount;
					for (const [la] of keptSpeech) {
						let k = la - 1;
						let mixed = false;
						for (; k >= 0 && speechAt(k); k--) if (inRemovedWord(k)) mixed = true;
						if (mixed) continue;
						const onset: number[] = [];
						while (k >= 0 && !speechAt(k) && !silent(k)) onset.push(k--);
						if (k < 0 || speechAt(k)) continue;
						for (const q of onset)
							if (!inRemovedWord(q)) expect(removedFrame(q), `onset frame ${q / 100} removed`).toBe(false);
					}
					const last = keptSpeech.reduce((m, [, lb]) => Math.max(m, lb), -1);
					if (last >= 0) {
						let k = last;
						let mixed = false;
						for (; k < n && speechAt(k); k++) if (inRemovedWord(k)) mixed = true;
						const decay: number[] = [];
						while (k < n && !speechAt(k) && !silent(k)) decay.push(k++);
						if (!mixed && k < n && !speechAt(k))
							for (const q of decay)
								if (!inRemovedWord(q)) expect(removedFrame(q), `tail frame ${q / 100} removed`).toBe(false);
					}
					expect(run(settings, { rejectKinds: [...FINDING_KINDS] }).plan.ranges).toEqual([]);
					const review = Object.fromEntries(RULES.map((k) => [k, 'review'])) as CleanupSettings['rules'];
					expect(run({ ...settings, rules: review }, {}).plan.ranges).toEqual([]);
				},
			),
			{ numRuns: 80 },
		);
	});

	it('Fast never leaves non-speech longer than maxGap inside a piece; every piece is long enough', () => {
		fc.assert(
			fc.property(recording, (r) => {
				const settings = mergeCleanupSettings(FAST_SETTINGS, {});
				const d = detectCleanup({
					mediaId: 'med_p',
					words: r.words,
					voice: r.voice,
					language: 'es',
					settings,
				});
				const plan = planMediaCuts({ words: d.words, removed: d.guarded, voice: r.voice, settings });
				for (const [a, b] of plan.kept) {
					// a shorter piece holds a kept word (never cut without a finding)
					if (!d.words.some((w, k) => !d.guarded[k] && w.s < b && w.e > a))
						expect(b - a).toBeGreaterThanOrEqual(settings.guards.minPieceS - 1e-9);
					let run = 0;
					for (let f = Math.round(a * 100); f < Math.round(b * 100); f++) {
						run = r.voice.classes[f] === 2 ? 0 : run + 1;
						expect(run).toBeLessThanOrEqual(Math.round(settings.gaps.maxGapS * 100) + 8 + 6);
					}
				}
			}),
			{ numRuns: 200 },
		);
	});
});

/** The timeline without ids: clips per track, links / groups as sets of (track, start) members, markers. */
function shape(seq: Sequence) {
	const key = (id: string) => {
		const c = seq.clips[id]!;
		return `${c.trackId}@${c.start}`;
	};
	const tracks: Record<string, Array<[number, number, number, string]>> = {};
	for (const c of Object.values(seq.clips)) {
		(tracks[c.trackId] ??= []).push([
			c.start,
			c.duration,
			c.sourceIn,
			(c as { mediaId?: string }).mediaId ?? '',
		]);
	}
	for (const l of Object.values(tracks)) l.sort((a, b) => a[0] - b[0]);
	const sets = (rec: Record<string, { members: string[] }>) =>
		Object.values(rec)
			.map((g) => g.members.map(key).sort().join('|'))
			.sort();
	return {
		tracks,
		links: sets(seq.links),
		groups: sets(seq.groups),
		markers: seq.markers.map((m) => m.frame),
	};
}

describe('one-pass extract = successive range.extract', () => {
	const scenario = fc.record({
		pieces: fc.array(
			fc.record({
				gap: fc.integer({ min: 0, max: 40 }),
				len: fc.integer({ min: 5, max: 120 }),
				jl: fc.integer({ min: -6, max: 6 }),
			}),
			{ minLength: 1, maxLength: 6 },
		),
		music: fc.boolean(),
		musicSync: fc.boolean(),
		lockV2: fc.boolean(),
		group: fc.boolean(),
		markers: fc.array(fc.integer({ min: 0, max: 900 }), { maxLength: 5 }),
		ranges: fc.array(
			fc.record({ a: fc.integer({ min: 0, max: 900 }), len: fc.integer({ min: 1, max: 60 }) }),
			{
				minLength: 1,
				maxLength: 12,
			},
		),
	});
	it('matches on random timelines with links, J / L edges, groups, sync lock, locked tracks and markers', () => {
		fc.assert(
			fc.property(scenario, (sc) => {
				const H = new Harness({ preset: 'hd-1080p-30' });
				const m = H.registerVideo({ seconds: 60 });
				let at = 0;
				const cmds: unknown[] = [];
				for (const p of sc.pieces) {
					at += p.gap;
					cmds.push({
						type: 'clip.place',
						source: { mediaId: m },
						sourceRange: { in: { seconds: 1 }, out: { seconds: 1 + p.len / 30 } },
						at,
						tracks: { video: 'V1', audio: ['A1'] },
						mode: 'overwrite',
					});
					at += p.len;
				}
				if (sc.music)
					cmds.push({
						type: 'clip.place',
						source: { mediaId: m },
						at: 0,
						tracks: { video: 'V2', audio: ['A2'] },
						mode: 'overwrite',
					});
				H.ok(cmds);
				// J / L edges: roll the sound of each piece a little (when there is room)
				for (const c of H.clips('A1')) {
					const p = sc.pieces[H.clips('A1').indexOf(c)];
					if (!p || p.jl === 0) continue;
					H.tx([
						{
							type: 'clip.trim',
							clipId: c.id,
							edge: p.jl > 0 ? 'out' : 'in',
							deltaFrames: -p.jl,
							linked: false,
						},
					]);
				}
				if (sc.music) {
					H.ok([
						{ type: 'track.update', trackId: 'A2', patch: { syncLock: sc.musicSync } },
						{ type: 'track.update', trackId: 'V2', patch: { locked: sc.lockV2 } },
					]);
					if (sc.group && !sc.lockV2)
						H.tx([{ type: 'clip.group', clipIds: [H.clips('A1')[0]!.id, H.clips('A2')[0]!.id] }]);
				}
				for (const f of sc.markers) H.ok([{ type: 'marker.add', frame: f }]);
				const speech = H.clips('A1')[0]!.id;
				const ranges = sc.ranges.map((r) => ({ start: r.a, end: r.a + r.len }));
				const base = H.doc;
				const one = H.tx([{ type: 'cleanup.apply', clipIds: [speech], ranges }]);
				const docOne = H.doc;
				// the same tracks, one range.extract per merged range, right to left
				H.doc = base;
				const tracks = (one.ok ? ((one.results[0] as { tracks: string[] }).tracks ?? []) : []).filter(
					Boolean,
				);
				const merged = [...ranges].sort((x, y) => x.start - y.start);
				const mr: Array<[number, number]> = [];
				for (const r of merged) {
					const l = mr[mr.length - 1];
					if (l && r.start <= l[1]) l[1] = Math.max(l[1], r.end);
					else mr.push([r.start, r.end]);
				}
				if (!one.ok) return;
				const many = H.tx(
					[...mr].reverse().map(([a, b]) => ({ type: 'range.extract', from: a, to: b, tracks })),
				);
				expect(many.ok).toBe(true);
				expect(shape(docOne.sequences[H.seqId]!)).toEqual(shape(H.seq));
				expect(checkInvariants(docOne as ProjectDocument)).toEqual([]);
			}),
			{ numRuns: 150 },
		);
	});
});
