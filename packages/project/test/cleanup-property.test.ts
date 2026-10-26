// Properties of transcript cleanup (spec 14 TC-033, fast-check):
// - planning: kept pieces are sorted and disjoint, never hold the sound of a removed word, never cut a kept word's
//   loud core in two (unless the timestamps give part of it to a removed word), and stay inside the analysed media;
// - applying: one `cleanup.apply` (extract) gives the same timeline as one `range.extract` per range, right to left,
//   on the same tracks (clips, sources, links, groups, markers; ids aside), and the invariants hold.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { detectCleanup } from '../src/cleanup/detector.ts';
import { planMediaCuts, removedSpans } from '../src/cleanup/plan.ts';
import { FAST_SETTINGS, mergeCleanupSettings, NATURAL_SETTINGS } from '../src/cleanup/schema.ts';
import { checkInvariants, type ProjectDocument, type Sequence } from '../src/index.ts';
import { FLICKS_PER_SECOND } from '../src/time.ts';
import { Harness } from './helpers.ts';

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

/** Random words over random sound: each word is speech (loud core + quieter edges), gaps are silence or breath. */
const recording = fc
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
		for (const x of lay) {
			for (let k = x.a; k < x.b; k++) {
				const edge = k < x.a + 2 || k >= x.b - 2;
				level[k] = (-65 + (edge ? 15 : x.loud) + 120) * 2;
				classes[k] = 2;
			}
			for (let k = x.b; k < Math.min(n, x.b + 6); k++) level[k] = (-65 + 18 - (k - x.b) * 3 + 120) * 2;
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
