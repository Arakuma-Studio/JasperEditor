// Parity with the scriptfix spike prototype (spec 17; docs/wp-notes/script-correction.md "Model"): the expected
// values in fixtures/script-fix-parity.json are the prototype's own outputs (`sfcore.psim` / `pkey`,
// `sfcore.script_tokens`, `sfalign.align` / `candidates`, `sfjobs.windows` / `bounds`) on invented Spanish text.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ALIGN_DEFAULTS, alignCore, alignTranscript, transcriptTokens } from '../src/script-fix/align.ts';
import { findFixCandidates } from '../src/script-fix/candidates.ts';
import { phoneticKey, psim } from '../src/script-fix/phonetic.ts';
import { parseScript } from '../src/script-fix/script.ts';
import { windowBounds, windowRanges } from '../src/script-fix/windows.ts';
import { FLICKS_PER_SECOND } from '../src/time.ts';

type Fixture = {
	cases: Record<
		string,
		{
			script: string;
			transcript: string;
			gaps: Record<string, number>;
			steps: unknown[];
			regions: Array<{
				type: string;
				t: number[];
				s: number[];
				/** Transcript tokens of the nearest left / right anchor cells. */
				tL: number;
				tR: number;
				psim: number;
				anchorsOk: boolean;
				sizeOk: boolean;
				direction: boolean;
			}>;
			windows: Array<[number, number]>;
			bounds: Array<[number, number]>;
			scriptTokens: Array<{ norm: string; paren: boolean; heading: boolean; section: number }>;
		}
	>;
	psim: Array<{ a: string; b: string; psim: number; keyA: string; keyB: string }>;
};
const fx = JSON.parse(readFileSync(new URL('./fixtures/script-fix-parity.json', import.meta.url), 'utf8')) as Fixture;

/** The prototype driver's word times: each word 0.3 s after a 0.05 s gap (or the case's gap), rounded to 1 ms. */
function words(c: Fixture['cases'][string]) {
	const out: Array<{ text: string; start: number; end: number; s: number; e: number }> = [];
	let t = 0;
	c.transcript.split(' ').forEach((w, k) => {
		t += c.gaps[String(k)] ?? 0.05;
		const s = Math.round(t * 1000) / 1000;
		const e = Math.round((t + 0.3) * 1000) / 1000;
		out.push({ text: w, start: Math.round(s * FLICKS_PER_SECOND), end: Math.round(e * FLICKS_PER_SECOND), s, e });
		t += 0.3;
	});
	return out;
}

const round3 = (x: unknown) => JSON.parse(JSON.stringify(x, (_k, v) => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : v)));

describe('script-fix parity with the prototype', () => {
	it('phonetic keys and psim match sfcore', () => {
		for (const p of fx.psim) {
			expect(phoneticKey(p.a, 'es')).toBe(p.keyA);
			expect(phoneticKey(p.b, 'es')).toBe(p.keyB);
			expect(psim(p.a, p.b, 'es')).toBeCloseTo(p.psim, 12);
		}
	});

	for (const [name, c] of Object.entries(fx.cases)) {
		describe(name, () => {
			const script = parseScript(c.script, { language: 'es' });
			const ws = words(c);

			it('script tokens match script_tokens', () => {
				expect(
					script.tokens.map((t) => ({
						norm: t.norm,
						paren: t.kind === 'paren',
						heading: t.kind === 'heading',
						section: t.section,
					})),
				).toEqual(c.scriptTokens);
			});

			it('the alignment path matches sfalign.align step for step', () => {
				const tn = transcriptTokens(ws).map((t) => t.norm);
				const core = alignCore(
					tn,
					script.tokens.map((t) => t.norm),
					script.tokens.map((t) => t.kind !== 'word'),
					'es',
					{ ...ALIGN_DEFAULTS },
				);
				expect(core.ok).toBe(true);
				if (core.ok) expect(round3(core.steps)).toEqual(c.steps);
			});

			it('offered candidates are the anchored, small, offerable regions of sfalign.candidates', () => {
				const alignment = alignTranscript({ words: ws, script, language: 'es' });
				if (!alignment.ok) throw new Error('alignment refused');
				const res = findFixCandidates({ mediaId: 'm', transcriptId: 't', words: ws, script, alignment });
				const regions = c.regions.filter(
					(r) =>
						r.anchorsOk &&
						r.sizeOk &&
						r.type !== 'ins' &&
						!r.direction &&
						!r.s.some((j) => /\d/.test(c.scriptTokens[j]!.norm)),
				);
				const fromScript = res.candidates.filter((x) => x.kind !== 'join' && x.kind !== 'glossary');
				// (every word of these cases normalises to a token, so token and word indices coincide)
				const within = (x: (typeof fromScript)[number], r: (typeof regions)[number]) =>
					x.scriptFrom! >= r.s[0]! &&
					x.scriptTo! <= r.s[r.s.length - 1]! + 1 &&
					x.fromWord > r.tL &&
					x.toWord <= r.tR;
				// every prototype region is offered, whole or split into its mixed parts (SC-025)
				for (const r of regions) {
					const inside = fromScript.filter((x) => within(x, r));
					const covered = inside.flatMap((x) =>
						Array.from({ length: x.scriptTo! - x.scriptFrom! }, (_, k) => x.scriptFrom! + k),
					);
					expect(covered, `${r.type} ${r.t} ${r.s}`).toEqual(r.s);
					if (inside.length === 1 && !inside[0]!.mixed) {
						expect(inside[0]!.kind).toBe(r.type);
						if (r.t.length) {
							expect(inside[0]!.fromWord).toBe(r.t[0]);
							expect(inside[0]!.toWord).toBe(r.t[r.t.length - 1]! + 1);
							expect(inside[0]!.psim).toBeCloseTo(r.psim, 3);
						}
					} else for (const x of inside) expect(x.mixed).toBe(true);
				}
				// and nothing else
				expect(fromScript.every((x) => regions.some((r) => within(x, r)))).toBe(true);
			});

			// The random cases have the same 0.05 s gap everywhere, so where the prototype splits a long stretch is a
			// floating-point tie between equal gaps; window parity is checked on the hand-written cases only.
			it.skipIf(name.startsWith('random'))('window ranges and padded bounds match sfjobs.windows / bounds (unpacked)', () => {
				const ranges = windowRanges(ws, { pack: false });
				expect(ranges).toEqual(c.windows);
				ranges.forEach(([a, b], k) => {
					const bnd = windowBounds(ws, a, b);
					expect(Math.abs(bnd.start / FLICKS_PER_SECOND - c.bounds[k]![0])).toBeLessThan(6e-4);
					expect(Math.abs(bnd.end / FLICKS_PER_SECOND - c.bounds[k]![1])).toBeLessThan(6e-4);
				});
			});
		});
	}
});
