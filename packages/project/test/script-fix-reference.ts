// Dense reference of the spike's aligner (`sfalign.py` `align`, a line-by-line port with full T × S matrices and no
// pruning) for checking the banded aligner of src/script-fix/align.ts on small inputs. Test-only: O(T · S · K).
import type { AlignOptions, AlignStep } from '../src/script-fix/align.ts';
import { cachedKey, psim } from '../src/script-fix/phonetic.ts';
import {
	exactMatch,
	functionWords,
	isContentWord,
	numberEqual,
	type ScriptFixLanguage,
	spokenForm,
} from '../src/script-fix/text.ts';

const NEG = Number.NEGATIVE_INFINITY;

function bigrams(s: string): string[] {
	if (s.length < 2) return [s];
	return [...new Set(Array.from({ length: s.length - 1 }, (_, i) => s.slice(i, i + 2)))];
}

export function referenceAlign(
	tn: readonly string[],
	sn: readonly string[],
	direction: readonly boolean[],
	lang: ScriptFixLanguage,
	p: AlignOptions,
): { steps: AlignStep[]; score: number } {
	const T = tn.length;
	const S = sn.length;
	const stop = functionWords(lang);
	const K = p.maxSkip;
	const sp = (x: string) => spokenForm(x, lang);
	// 1:1 cells
	const V: number[][] = [];
	const PS: number[][] = [];
	for (let i = 0; i < T; i++) {
		V.push([]);
		PS.push([]);
		const gt = bigrams(cachedKey(tn[i]!, lang));
		for (let j = 0; j < S; j++) {
			const a = tn[i]!;
			const b = sn[j]!;
			let v = p.subFloor;
			let ps = 0;
			const gs = bigrams(cachedKey(b, lang));
			const shared = gt.filter((x) => gs.includes(x)).length;
			const dice = (2 * shared) / (gt.length + gs.length + 1e-9);
			if (a === b) {
				v = isContentWord(b, stop) ? p.exactContent : p.exactFunction;
				ps = 1;
			} else if (numberEqual(a, b)) {
				v = p.exactContent;
				ps = 1;
			} else if (dice >= p.prefilterDice) {
				ps = psim(sp(a), sp(b), lang);
				v = Math.max(p.subFloor, p.subScale * ps - p.subOffset);
			}
			V[i]!.push(v);
			PS[i]!.push(ps);
		}
	}
	// merge cells
	type M = { a: number; b: number; j: number; sc: number; ps: number };
	const merges: M[][] = Array.from({ length: T }, () => []);
	const cell = (s: string, other: string): number | null => {
		const g = bigrams(cachedKey(s, lang));
		const go = bigrams(cachedKey(other, lang));
		const c = g.filter((x) => go.includes(x)).length;
		if (c === 0 || c < Math.max(1, Math.floor(0.5 * g.length))) return null;
		const ps = psim(s, other, lang);
		return ps >= p.mergeMinPsim ? ps : null;
	};
	const sc = (ps: number, n: number) => ((ps >= 1 ? p.exactContent : p.subScale * ps - p.subOffset) * (n + 1)) / 2;
	for (const a of [2, 3])
		for (let i = a - 1; i < T; i++) {
			const s = tn.slice(i - a + 1, i + 1).map(sp).join('');
			if (s.length < 4) continue;
			for (let j = 0; j < S; j++) {
				const ps = cell(s, sp(sn[j]!));
				if (ps !== null) merges[i]!.push({ a, b: 1, j, sc: sc(ps, a), ps });
			}
		}
	for (const b of [2, 3])
		for (let j = b - 1; j < S; j++) {
			const s = sn.slice(j - b + 1, j + 1).map(sp).join('');
			if (s.length < 4) continue;
			for (let i = 0; i < T; i++) {
				const ps = cell(s, sp(tn[i]!));
				if (ps !== null) merges[i]!.push({ a: 1, b, j, sc: sc(ps, b), ps });
			}
		}
	const cum = [0];
	for (let j = 0; j < S; j++) cum.push(cum[j]! + (direction[j] ? 0 : 1));
	const skipcost = (a: number, b: number) => {
		const n = cum[b + 1]! - cum[a]!;
		return n > 0 ? p.skipOpen + p.skipPerToken * n : 0;
	};
	const H = Array.from({ length: T }, () => new Array<number>(S).fill(NEG));
	const I = Array.from({ length: T }, () => new Array<number>(S).fill(NEG));
	const BH = Array.from({ length: T }, () => new Array<number>(S).fill(0));
	const BHs = Array.from({ length: T }, () => new Array<number>(S).fill(0));
	const BI = Array.from({ length: T }, () => new Array<number>(S).fill(0));
	const mbp = new Map<string, { a: number; b: number; how: string; k: number; st: number; ps: number }>();
	const OFF = new Array<number>(T).fill(NEG);
	const BO = new Array<number>(T).fill(0);
	const rowbest = new Array<number>(T).fill(0);
	const rowstate = new Array<number>(T).fill(0);
	const rowarg = new Array<number>(T).fill(0);
	const C = (i: number, j: number): [number, number] => {
		const h = H[i]![j]!;
		const x = I[i]![j]!;
		return [Math.max(h, x), x > h ? 1 : 0];
	};
	const argmax = (r: number[]) => {
		let b = 0;
		for (let j = 1; j < r.length; j++) if (r[j]! > r[b]!) b = j;
		return b;
	};
	for (let i = 0; i < T; i++) {
		for (let j = 0; j < S; j++) {
			let best = NEG;
			let code = 0;
			let pst = 0;
			if (i === 0) {
				best = -p.offEnter;
				code = K + 3;
			} else {
				if (j >= 1) {
					const [c, s] = C(i - 1, j - 1);
					if (c > best) [best, code, pst] = [c, 0, s];
				}
				for (let k = 1; k <= K; k++) {
					const jj = j - k - 1;
					if (jj < 0) break;
					const [c, s] = C(i - 1, jj);
					const v = c - skipcost(jj + 1, j - 1);
					if (v > best) [best, code, pst] = [v, k, s];
				}
				const jv = rowbest[i - 1]! - p.jump;
				if (jv > best) [best, code] = [jv, K + 1];
				const ov = OFF[i - 1]! - p.offEnter;
				if (ov > best) [best, code] = [ov, K + 2];
			}
			H[i]![j] = best + V[i]![j]!;
			BH[i]![j] = code;
			BHs[i]![j] = pst;
		}
		for (const m of merges[i]!) {
			const i0 = i - m.a;
			const j0 = m.j - m.b;
			let base = NEG;
			let how = 'start';
			let hk = 0;
			let hs = 0;
			if (i0 < 0) base = -p.offEnter;
			else {
				const cands: Array<[number, string, number, number]> = [];
				if (j0 >= 0) {
					const [c, s] = C(i0, j0);
					cands.push([c, 'cont', 0, s]);
				}
				for (let k = 1; k <= K; k++) {
					const jj = j0 - k;
					if (jj >= 0) {
						const [c, s] = C(i0, jj);
						cands.push([c - skipcost(jj + 1, j0), 'skip', k, s]);
					}
				}
				cands.push([rowbest[i0]! - p.jump, 'jump', 0, 0]);
				cands.push([OFF[i0]! - p.offEnter, 'off', 0, 0]);
				for (const c of cands) if (c[0] > base) [base, how, hk, hs] = c;
			}
			const v = base + m.sc;
			if (v > H[i]![m.j]!) {
				H[i]![m.j] = v;
				BH[i]![m.j] = K + 4;
				mbp.set(`${i},${m.j}`, { a: m.a, b: m.b, how, k: hk, st: hs, ps: m.ps });
			}
		}
		if (i > 0)
			for (let j = 0; j < S; j++) {
				const [c, s] = C(i - 1, j);
				I[i]![j] = c - p.insertion;
				BI[i]![j] = s;
			}
		if (i === 0) OFF[i] = -p.offWord;
		else {
			const o1 = OFF[i - 1]!;
			const o2 = rowbest[i - 1]! - p.offLeave;
			OFF[i] = Math.max(o1, o2) - p.offWord;
			BO[i] = o1 >= o2 ? 0 : 1;
		}
		const ah = argmax(H[i]!);
		const ai = argmax(I[i]!);
		const hb = H[i]![ah]!;
		const ib = I[i]![ai]!;
		rowbest[i] = Math.max(hb, ib);
		rowstate[i] = hb >= ib ? 0 : 1;
		rowarg[i] = hb >= ib ? ah : ai;
	}
	let i = T - 1;
	const ah = argmax(H[i]!);
	const ai = argmax(I[i]!);
	const fin: Array<[number, number, number]> = [
		[H[i]![ah]!, 0, ah],
		[I[i]![ai]!, 1, ai],
		[OFF[i]!, 2, -1],
	];
	let f = fin[0]!;
	for (const x of fin) if (x[0] > f[0]) f = x;
	let [score, state, j] = f;
	const steps: AlignStep[] = [];
	while (i >= 0) {
		if (state === 2) {
			steps.push({ kind: 'off', t: [i, i] });
			if (BO[i] === 1 && i > 0) {
				i--;
				state = rowstate[i]!;
				j = rowarg[i]!;
			} else i--;
			continue;
		}
		if (state === 1) {
			steps.push({ kind: 'ins', t: [i, i], after: j });
			state = BI[i]![j]!;
			i--;
			continue;
		}
		const code = BH[i]![j]!;
		if (code === K + 4) {
			const m = mbp.get(`${i},${j}`)!;
			steps.push({ kind: 'cell', t: [i - m.a + 1, i], s: [j - m.b + 1, j], psim: m.ps, exact: m.ps >= 1 });
			const i0 = i - m.a;
			const j0 = j - m.b;
			if (m.how === 'start') break;
			if (m.how === 'cont') [i, j, state] = [i0, j0, m.st];
			else if (m.how === 'skip') {
				steps.push({ kind: 'skip', s: [j0 - m.k + 1, j0] });
				[i, j, state] = [i0, j0 - m.k, m.st];
			} else if (m.how === 'jump') {
				steps.push({ kind: 'jump' });
				i = i0;
				state = rowstate[i]!;
				j = rowarg[i]!;
			} else {
				steps.push({ kind: 'jumpOff' });
				i = i0;
				state = 2;
			}
			continue;
		}
		const ex = exactMatch(tn[i]!, sn[j]!);
		steps.push({ kind: 'cell', t: [i, i], s: [j, j], psim: ex ? 1 : PS[i]![j]!, exact: ex });
		if (code === 0) {
			state = BHs[i]![j]!;
			i--;
			j--;
		} else if (code >= 1 && code <= K) {
			steps.push({ kind: 'skip', s: [j - code, j - 1] });
			state = BHs[i]![j]!;
			i--;
			j = j - 1 - code;
		} else if (code === K + 1) {
			steps.push({ kind: 'jump' });
			i--;
			if (i >= 0) {
				state = rowstate[i]!;
				j = rowarg[i]!;
			}
		} else if (code === K + 2) {
			steps.push({ kind: 'jumpOff' });
			i--;
			state = 2;
		} else break;
	}
	steps.reverse();
	return { steps, score };
}
