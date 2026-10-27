// Synthetic script + transcript for the script-correction performance budget (spec 17 SC-015): a 6,000-token Spanish-
// like script (pseudo-words with a Zipf-like frequency, function words, proper names, headings, stage directions) and
// a ≈ 2 h transcript of ≈ 20,000 words that reads it with retakes, off-script chatter, misrecognitions, dropped and
// inserted words, reading the script again from the top when it ends. Deterministic (seeded). Invented data only.
import { FLICKS_PER_SECOND } from '../src/time.ts';

function rng(seed: number) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const FUNCTION =
	'de la el que en y a los las un una es se lo con por para del al me te no si mi tu su o le ya muy pero como esta este eso hay'.split(
		' ',
	);
const ONSETS = [
	'b',
	'c',
	'd',
	'f',
	'g',
	'l',
	'm',
	'n',
	'p',
	'r',
	's',
	't',
	'v',
	'ch',
	'br',
	'tr',
	'pl',
	'gr',
	'cr',
];
const VOWELS = ['a', 'e', 'i', 'o', 'u'];
const CODAS = ['', '', '', 'n', 's', 'r', 'l'];

export function synthScriptFix(
	opts: { scriptTokens?: number; transcriptWords?: number; seed?: number } = {},
) {
	const scriptTokens = opts.scriptTokens ?? 6000;
	const transcriptWords = opts.transcriptWords ?? 20_000;
	const r = rng(opts.seed ?? 17);
	const pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!;
	const word = () => {
		let w = '';
		const n = 2 + Math.floor(r() * 3);
		for (let k = 0; k < n; k++) w += pick(ONSETS) + pick(VOWELS) + (k === n - 1 ? pick(CODAS) : '');
		return w;
	};
	const content = Array.from({ length: 1500 }, word);
	const names = Array.from({ length: 30 }, () => {
		const w = word();
		return w[0]!.toUpperCase() + w.slice(1);
	});
	const zipf = () => content[Math.min(content.length - 1, Math.floor(content.length * r() ** 2.2))]!;
	// script: sentences, a heading every ~25 lines, an occasional stage direction
	const lines: string[] = [];
	const sentences: string[][] = [];
	let count = 0;
	while (count < scriptTokens) {
		if (lines.length % 25 === 0) {
			const h = `Escena ${lines.length / 25 + 1}:`;
			lines.push(h);
			count += 2;
			continue;
		}
		const n = 6 + Math.floor(r() * 11);
		const s: string[] = [];
		for (let k = 0; k < n; k++) {
			const x = r();
			s.push(x < 0.42 ? pick(FUNCTION) : x < 0.45 ? pick(names) : zipf());
		}
		let line = `${s[0]![0]!.toUpperCase()}${s[0]!.slice(1)} ${s.slice(1).join(' ')}.`;
		if (r() < 0.08) {
			line += ' (mostrar la pantalla)';
			count += 3;
		}
		lines.push(line);
		sentences.push(s);
		count += n;
	}
	const scriptText = lines.join('\n');
	// transcript
	const words: Array<{ text: string; start: number; end: number; confidence: number }> = [];
	let t = 1;
	const emit = (w: string) => {
		words.push({
			text: w,
			start: Math.round(t * FLICKS_PER_SECOND),
			end: Math.round((t + 0.28) * FLICKS_PER_SECOND),
			confidence: 0.9,
		});
		t += 0.33;
	};
	const mutate = (w: string) => {
		if (w.length < 3) return pick(FUNCTION);
		const k = 1 + Math.floor(r() * (w.length - 1));
		return w.slice(0, k) + pick(VOWELS) + w.slice(k + 1);
	};
	let si = 0;
	while (words.length < transcriptWords) {
		const s = sentences[si % sentences.length]!;
		si++;
		if (r() < 0.12) {
			// a take cut short, then the retake
			for (const w of s.slice(0, Math.max(2, Math.floor(s.length * (0.3 + 0.5 * r())))))
				emit(w.toLowerCase());
			t += 0.8;
		}
		if (r() < 0.1) {
			const n = 5 + Math.floor(r() * 20);
			for (let k = 0; k < n; k++) emit(r() < 0.5 ? pick(FUNCTION) : word());
			t += 1.2;
		}
		for (const w of s) {
			const x = r();
			if (x < 0.04) emit(mutate(w.toLowerCase()));
			else if (x < 0.06) continue;
			else if (x < 0.08) {
				emit(w.toLowerCase());
				emit(pick(FUNCTION));
			} else emit(w.toLowerCase());
		}
		t += r() < 0.3 ? 1.5 : 0.4;
	}
	return { scriptText, words: words.slice(0, transcriptWords) };
}
