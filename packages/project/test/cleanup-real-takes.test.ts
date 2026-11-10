// Clean Up on real transcripts (docs/wp-notes/transcript-cleanup.md "Real-take corpus"): whisper-large-v3-turbo
// transcripts of six ~80 s fragments of the reporter's 57-minute Spanish talking-head recording, as the hidden-retake
// test wrote them in its runs 2 and 3 (re-decode on, `chunking: "vad"`, re-decode off; `fixtures/cleanup-real-takes.json`,
// text and times only). The spec is what the speaker meant, written by hand per fragment: the edit keeps the last
// complete clean take of every sentence once, removes every earlier attempt, restart and aside, never plays a sentence
// twice, never loses what only one take says, and no cut starts or ends inside a kept word. The cut runs through the
// detector and the media planner with a voice analysis that has speech under every word (Fast preset).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type CleanupVoice, detectCleanup } from '../src/cleanup/detector.ts';
import { cleanupNorm, sameWord } from '../src/cleanup/lists.ts';
import { planMediaCuts } from '../src/cleanup/plan.ts';
import { FAST_SETTINGS } from '../src/cleanup/schema.ts';
import { FLICKS_PER_SECOND } from '../src/time.ts';

type Case = {
	id: string;
	fragment: string;
	from: string[];
	redecoded: Array<[number, number]>;
	words: Array<[string, number, number]>;
};

const corpus = JSON.parse(
	readFileSync(new URL('./fixtures/cleanup-real-takes.json', import.meta.url), 'utf8'),
) as { cases: Case[] };

/** Per fragment: phrases the edit says exactly once, phrases it never says (normalised words, ASR variants match). */
const SPEC: Record<string, { once: string[]; never: string[] }> = {
	A: {
		once: [
			'al final del mes debo portear',
			'deben funcionar perfectamente',
			'correr en todas las plataformas',
			// without the re-decode (c) "a" is stretched over the second "poder subirlos" (1.03 s) and goes as a drawn vowel
			'poder subirlos',
			'la play store',
			'si alguno de ellos no funciona',
			'antes de que me digan',
			'dejenme decirles',
			'tienen toda la razon',
		],
		never: [],
	},
	B: {
		once: [
			'otro 1',
			'personas que hicieron su propio motor',
			'nunca terminaron un juego en toda su vida',
			'nos queda un largo trabajo',
		],
		// the aside after an earlier take, and a take the ASR garbled
		never: ['decir puta', 'su puta', 'propio actor'],
	},
	C: {
		once: [
			'para eso me quedo con unity',
			'entonces le di a mi ejercito de',
			'una mision nueva',
			'siempre quise tener en unity',
			'que tenia que comprar',
			'aparte en la asset store',
		],
		never: [],
	},
	D: {
		once: [
			'jasper engine agarras las manos',
			'el motor hace todo el movimiento entre',
			'quieres que la animacion se sienta',
			'funcionan con casi cualquier personaje humanoide',
			'unity no tiene esto tan facil',
			'boton con brillito',
			'efecto de fuego',
			'en unity tiene los componentes',
		],
		never: ['las piensas', 'funcionan con cual', 'que se sienta si'],
	},
	E: {
		once: [
			'ok wow entonces esto significa',
			'del mundo',
			'un mes lo mismo',
			'millones de dolares',
			'me quedan nueve dias',
		],
		never: ['ser lo que'],
	},
	F: {
		once: [
			'cada sistema le habla',
			'windows habla directx',
			'algunos hablan vulkan',
			'una libreria que hizo un aleman',
			'traductor universal',
		],
		never: [],
	},
};

const S = (x: number) => Math.round(x * FLICKS_PER_SECOND);

function cut(c: Case) {
	const words = c.words.map(([text, s, e]) => ({ text, start: S(s), end: S(e), confidence: 0.9 }));
	const n = Math.ceil(Math.max(...c.words.map((w) => w[2])) * 100) + 200;
	const classes = new Uint8Array(n);
	const level = new Uint8Array(n).fill((120 - 64) * 2);
	for (const [, s, e] of c.words)
		for (let f = Math.floor(s * 100); f < Math.ceil(e * 100); f++) {
			classes[f] = 2;
			level[f] = (120 - 20) * 2;
		}
	const voice: CleanupVoice = {
		classes,
		level,
		frameCount: n,
		levels: { floorDb: -64, speechDb: null, speechThresholdDb: null, breathFloorDb: null },
	};
	const r = detectCleanup({
		mediaId: 'med_real',
		words,
		voice,
		language: 'es',
		settings: FAST_SETTINGS,
		redecoded: c.redecoded.map(([a, b]) => [S(a), S(b)] as const),
	});
	const removedIdx = new Set<number>();
	for (const f of r.findings)
		if (f.words && f.suggested === 'remove') for (let i = f.words[0]; i <= f.words[1]; i++) removedIdx.add(i);
	const removed = r.words.map((w, k) => r.guarded[k]! || removedIdx.has(w.i));
	const plan = planMediaCuts({ words: r.words, removed, voice, settings: FAST_SETTINGS });
	const inKept = (t: number) => plan.kept.some(([a, b]) => t >= a && t < b);
	const heard = r.words.filter((w) => inKept((w.s + w.e) / 2));
	return { r, plan, heard, removedIdx };
}

/** How many times `phrase` occurs in a row in `toks` (ASR variants match). */
function count(toks: readonly string[], phrase: string): number {
	const p = phrase.split(' ');
	let n = 0;
	for (let i = 0; i + p.length <= toks.length; i++) if (p.every((x, q) => sameWord(x, toks[i + q]!))) n++;
	return n;
}

describe('Clean Up on real transcripts (corpus)', () => {
	for (const c of corpus.cases)
		it(`${c.id}: the last clean take of each sentence, once`, () => {
			const { r, plan, heard, removedIdx } = cut(c);
			// a take marked kept is never removed by another rule
			for (const g of r.groups) {
				const [w0, w1] = g.takes[g.chosen]!.words;
				const lost = r.words.filter((w) => w.i >= w0 && w.i <= w1 && removedIdx.has(w.i));
				expect(
					lost.map((w) => w.text),
					`kept take ${g.id} removed in part`,
				).toEqual([]);
			}
			const toks = heard.map((w) => cleanupNorm(w.text)).filter(Boolean);
			const text = heard.map((w) => w.text).join(' ');
			const spec = SPEC[c.fragment]!;
			for (const p of spec.once) expect(count(toks, p), `"${p}" once in: ${text}`).toBe(1);
			for (const p of spec.never) expect(count(toks, p), `"${p}" never in: ${text}`).toBe(0);
			// no sentence twice: no run of five words said twice
			const grams = new Map<string, number>();
			for (let i = 0; i + 5 <= toks.length; i++) {
				const g = toks.slice(i, i + 5).join(' ');
				grams.set(g, (grams.get(g) ?? 0) + 1);
			}
			expect(
				[...grams].filter(([, k]) => k > 1).map(([g]) => g),
				`twice in: ${text}`,
			).toEqual([]);
			// no cut inside a kept word
			for (const w of heard)
				expect(
					plan.kept.some(([a, b]) => w.s >= a - 0.011 && w.e <= b + 0.011),
					`"${w.text}" ${w.s}–${w.e} whole`,
				).toBe(true);
		});
});
