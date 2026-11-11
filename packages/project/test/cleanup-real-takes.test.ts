// Clean Up on real transcripts (docs/wp-notes/transcript-cleanup.md "Real-take corpus"): whisper-large-v3-turbo
// transcripts of ~80 s fragments of the reporter's 57-minute Spanish talking-head recording, as the hidden-retake
// test wrote them in its runs 2–5 (re-decode on, `chunking: "vad"`, re-decode off; run 5 adds the held-out G–L;
// `fixtures/cleanup-real-takes.json`, text and times only, plus the speech without words the reporter measured). The
// spec is what the speaker meant, written by hand per fragment: the edit keeps the last complete clean take of every
// sentence once, removes every earlier attempt, restart and aside, never plays a sentence twice, never loses what only
// one take says, and no cut starts or ends inside a word. And for every case: whatever is removed, head and tail
// included, lies inside a finding that removes, rejecting every finding or setting every rule to review removes
// nothing, and a take marked kept loses no word. The cut is the sequence's (`analyzeSequenceCleanup`, Fast preset)
// with a voice analysis that has speech under every word and where the reporter measured it.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { CleanupVoice } from '../src/cleanup/detector.ts';
import { cleanupNorm, sameWord } from '../src/cleanup/lists.ts';
import { type CleanupSettings, FAST_SETTINGS, FINDING_KINDS } from '../src/cleanup/schema.ts';
import { analyzeSequenceCleanup, type CleanupDecisions } from '../src/cleanup/sequence.ts';
import { transcriptAttachPlan } from '../src/speech/index.ts';
import { FLICKS_PER_SECOND } from '../src/time.ts';
import { Harness, videoAsset } from './helpers.ts';

type Case = {
	id: string;
	fragment: string;
	from: string[];
	redecoded: Array<[number, number]>;
	/** Speech without words / silence inside a word the reporter measured (seconds). */
	voiced?: Array<[number, number]>;
	unvoiced?: Array<[number, number]>;
	words: Array<[string, number, number]>;
};

const corpus = JSON.parse(
	readFileSync(new URL('./fixtures/cleanup-real-takes.json', import.meta.url), 'utf8'),
) as { cases: Case[] };

/** Per fragment: phrases the edit says exactly once, phrases it never says (normalised words, ASR variants match). */
const SPEC: Record<
	string,
	{ once: string[]; never: string[]; allKept?: boolean; gone?: Array<[number, number]> }
> = {
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
	// held out (run 5): written from the listening judgements before the code was changed for them
	G: {
		once: [
			'oh por dios',
			'es hermoso',
			'aunque el jaspercito todo bonito',
			'como una estatua',
			'por fin lo pudiera mover',
			'pero atravesaba las paredes',
			'terminaba en el espacio',
			'asi que le puse fisicas',
			'no tengo un titulo',
			'ni siquiera termine',
			'librerias ya existentes',
		],
		// the aside between the takes ("Pero. Me falta un…"), the end of the abandoned take
		never: ['me falta', 'paredes no'],
	},
	H: {
		once: [
			'el procesador tiene que ir saltando',
			'unity si tiene una forma mas rapida',
			'que se llama dots',
			'es tan distinta',
			'aprender otro unity desde cero',
			'en jasper engine todo usa',
			'guarda los objetos ordenados',
			'todas las posiciones juntas',
			'todas las velocidades juntas',
			'el procesador las lea de corrido',
			'sigue siendo igual',
			'unity 0 jasper engine 2',
		],
		never: [],
	},
	I: {
		once: [
			'el procesador ya no calcula absolutamente nada',
			// the restart "La tarjeta gráfica lee esa imagen y puede…" goes: its retry stays
			'la tarjeta grafica le',
			'cada punto de los 500 personajes',
			'le das al boton',
			'pones los 500 personajes',
			'aparecen todos caminando',
			'es como dibujar un solo personaje',
			'si uno llega a cambiar de animacion',
			'el procesador solo le manda 32 bytes',
			'mas o menos lo que ocupa escribir la frase',
			'suscribete al canal de jasperdev',
		],
		never: ['grafica lee', 'le lee', 'y puede'],
	},
	J: {
		once: [
			'tienes que ir probando',
			'resolucion por resolucion',
			'es un infierno',
			'los menus se hacen con html y css',
			'igual que en una pagina web',
			'porque le meti al motor la libreria',
			'es como un mini navegador',
			'un monton de cosas',
			'que entiende un navegador de verdad',
		],
		never: [],
		// the stray "igual" before the retry (default mode writes it as "En el" at 18.18–18.95)
		gone: [[18.2, 18.7]],
	},
	K: {
		once: [
			'de que me sirve el motor',
			'rehacer todos mis juegos',
			'en solo 4 dias',
			'es imposible',
			'se me ocurrio una idea',
			'son solo texto',
			'hice un traductor',
			'los modelos 3d',
			'al nuevo engine',
			'el codigo de los juegos',
			'estaba en c sharp',
			'las funciones de unity',
		],
		never: [],
	},
	// the control fragment: no take, every word stays
	L: { once: [], never: [], allKept: true },
};

const FPS = 30;

/** The case's cut: removed and kept ranges (seconds), the words heard, the analysis. */
function cut(c: Case, decisions?: CleanupDecisions, settings: CleanupSettings = FAST_SETTINGS) {
	const end = Math.max(...c.words.map((w) => w[2])) + 2;
	const n = Math.ceil(end * 100);
	const classes = new Uint8Array(n);
	const level = new Uint8Array(n).fill((120 - 64) * 2);
	const speech = (a: number, b: number, on: boolean) => {
		for (let f = Math.floor(a * 100); f < Math.min(n, Math.ceil(b * 100)); f++) {
			classes[f] = on ? 2 : 0;
			level[f] = (120 + (on ? -20 : -64)) * 2;
		}
	};
	for (const [, s, e] of c.words) speech(s, e, true);
	for (const [a, b] of c.voiced ?? []) speech(a, b, true);
	for (const [a, b] of c.unvoiced ?? []) speech(a, b, false);
	const voice: CleanupVoice = {
		classes,
		level,
		frameCount: n,
		levels: { floorDb: -64, speechDb: null, speechThresholdDb: null, breathFloorDb: null },
	};
	const H = new Harness({ preset: 'hd-1080p-30' });
	const r0 = H.ok([{ type: 'media.register', asset: videoAsset({ seconds: end, kind: 'audio' }) }]);
	const mediaId = (r0.results[0] as { mediaId: string }).mediaId;
	H.ok([{ type: 'clip.place', source: { mediaId }, at: 0, tracks: { audio: ['A1'] }, mode: 'overwrite' }]);
	const S = (x: number) => Math.round(x * FLICKS_PER_SECOND);
	const plan = transcriptAttachPlan(
		H.doc,
		{
			target: { type: 'media' },
			model: 'whisper-large-v3-turbo',
			language: 'es',
			task: 'transcribe',
			words: c.words.map(([text, s, e]) => ({ text, start: S(s), end: S(e), confidence: 0.9 })),
			speakers: {},
			guard: { redecoded: { ranges: c.redecoded.map(([start, end]) => ({ start, end, replaced: true })) } },
		},
		{ mediaId, replace: true },
	);
	if ('error' in plan) throw new Error(plan.error);
	H.ok(plan.commands);
	const a = analyzeSequenceCleanup({
		doc: H.doc,
		seq: H.seq,
		voice: () => voice,
		settings,
		...(decisions ? { decisions } : {}),
	});
	if (!a.ok) throw new Error(a.message);
	const kept = a.plan.kept.map((k) => [k.start / FPS, k.end / FPS] as const);
	const removed = a.plan.ranges.map((r) => [r.start / FPS, r.end / FPS] as const);
	const heard = c.words.filter(([, s, e]) => kept.some(([x, y]) => (s + e) / 2 >= x && (s + e) / 2 < y));
	return { a, kept, removed, heard };
}

/** How many times `phrase` occurs in a row in `toks` (ASR variants match). */
function count(toks: readonly string[], phrase: string): number {
	const p = phrase.split(' ');
	let n = 0;
	for (let i = 0; i + p.length <= toks.length; i++) if (p.every((x, q) => sameWord(x, toks[i + q]!))) n++;
	return n;
}

const sec = (f: number) => f / FLICKS_PER_SECOND;
/** Seconds of `[a, b)` outside `spans`. */
const outside = (a: number, b: number, spans: ReadonlyArray<readonly [number, number]>) => {
	let left = b - a;
	for (const [x, y] of spans) left -= Math.max(0, Math.min(b, y) - Math.max(a, x));
	return left;
};

describe('Clean Up on real transcripts (corpus)', () => {
	for (const c of corpus.cases)
		it(`${c.id}: the last clean take of each sentence, once`, () => {
			const { a, kept, removed, heard } = cut(c);
			// every removed second, head and tail included, lies within a finding that removes — beyond its edges only
			// silence, and at most a frame of it (the frame grid)
			const removing = a.findings
				.filter((f) => f.suggested === 'remove')
				.map((f) => [sec(f.range.start), sec(f.range.end)] as const);
			const frame = 1 / FPS;
			const near = removing.map(([x, y]) => [x - frame - 1e-6, y + frame + 1e-6] as const);
			const voiced = [...c.words.map(([, s, e]) => [s, e] as const), ...(c.voiced ?? [])];
			for (const [x, y] of removed) {
				expect(outside(x, y, near), `${x.toFixed(3)}–${y.toFixed(3)} removed without a finding`).toBeLessThan(
					1e-6,
				);
				for (const [p, q] of voiced) {
					const [u, v] = [Math.max(x, p), Math.min(y, q)];
					if (v > u)
						expect(outside(u, v, removing), `voice ${p}–${q} removed beyond a finding`).toBeLessThan(1e-6);
				}
			}
			// a take marked kept loses no word
			for (const g of a.groups) {
				const t = g.takes[g.chosen]!;
				const lost = c.words.filter(
					([, s, e], i) =>
						i >= t.words[0] && i <= t.words[1] && !kept.some(([x, y]) => (s + e) / 2 >= x && (s + e) / 2 < y),
				);
				expect(
					lost.map((w) => w[0]),
					`kept take ${g.id} removed in part`,
				).toEqual([]);
			}
			const toks = heard.map((w) => cleanupNorm(w[0])).filter(Boolean);
			const text = heard.map((w) => w[0]).join(' ');
			const spec = SPEC[c.fragment]!;
			if (spec.allKept) expect(text).toBe(c.words.map((w) => w[0]).join(' '));
			for (const p of spec.once) expect(count(toks, p), `"${p}" once in: ${text}`).toBe(1);
			for (const p of spec.never) expect(count(toks, p), `"${p}" never in: ${text}`).toBe(0);
			for (const [x, y] of spec.gone ?? [])
				expect(outside(x, y, removed), `${x}–${y} kept`).toBeLessThan(1e-6);
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
			// no cut inside a word: a word is all kept or all removed (within a frame)
			const slack = 1 / FPS + 0.01;
			for (const [t, s, e] of c.words) {
				const out = outside(s, e, kept);
				expect(
					out < slack || out > e - s - slack,
					`"${t}" ${s}–${e} split: ${JSON.stringify(kept.filter(([x, y]) => x < e + 1 && y > s - 1))} ${JSON.stringify(a.findings.filter((f) => sec(f.range.start) < e + 0.5 && sec(f.range.end) > s - 0.5).map((f) => [f.kind, f.suggested, sec(f.range.start), sec(f.range.end)]))}`,
				).toBe(true);
			}
			// the speech without words the reporter measured is retries here: it goes
			for (const [x, y] of c.voiced ?? [])
				expect(y - x - outside(x, y, kept), `voice ${x}–${y} kept`).toBeLessThan(0.05);
		});

	it('speech a stretched word holds is flagged for review, and accepting it removes that speech (H "rápida")', () => {
		for (const c of corpus.cases.filter((x) => x.fragment === 'H')) {
			const { a } = cut(c);
			const f = a.findings.find((x) => x.kind === 'untranscribed' && x.reason.params.text === 'rápida');
			expect(f, c.id).toBeDefined();
			expect(f!.suggested).toBe('review');
			const [s, e] = [sec(f!.range.start), sec(f!.range.end)];
			expect(s).toBeCloseTo(15.95, 1);
			expect(e).toBeCloseTo(17.62, 1);
			const { removed } = cut(c, { accept: [f!.id] });
			expect(outside(s + 1 / FPS, e - 1 / FPS, removed), c.id).toBeLessThan(1e-6);
		}
	});

	it('rejecting every finding removes nothing, head and tail included', () => {
		for (const c of corpus.cases)
			expect(cut(c, { rejectKinds: [...FINDING_KINDS] }).removed, c.id).toEqual([]);
	});

	it('with every rule set to review nothing is removed until accepted', () => {
		const rules = Object.fromEntries(
			Object.keys(FAST_SETTINGS.rules).map((k) => [k, 'review']),
		) as unknown as CleanupSettings['rules'];
		for (const c of corpus.cases)
			expect(cut(c, undefined, { ...FAST_SETTINGS, rules }).removed, c.id).toEqual([]);
	});
});
