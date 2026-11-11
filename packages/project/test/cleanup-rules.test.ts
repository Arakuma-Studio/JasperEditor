// Every rule of the transcript cleanup detector on small Spanish and English cases (spec 14 TC-011 / TC-070), the
// lists per language and the sequence's edited lists, fingerprints (TC-013), script alignment (TC-012) and the edge
// helpers (TC-021). Words are synthetic; the voice analysis is a hand-made plane (speech under every word).
import { describe, expect, it } from 'vitest';
import {
	type CleanupVoice,
	type CleanupWordIn,
	detectCleanup,
	effectiveLists,
	findingFingerprint,
} from '../src/cleanup/detector.ts';
import { edgeThreshold, levelInPoint, levelOutPoint, snapEdge } from '../src/cleanup/edges.ts';
import { cleanupLanguageOf, cleanupNorm } from '../src/cleanup/lists.ts';
import {
	type CleanupOverrides,
	FAST_SETTINGS,
	type FindingKind,
	mergeCleanupSettings,
	NATURAL_SETTINGS,
} from '../src/cleanup/schema.ts';
import { scriptLines } from '../src/cleanup/script.ts';
import { FLICKS_PER_SECOND } from '../src/time.ts';

const S = (x: number) => Math.round(x * FLICKS_PER_SECOND);

/** Words "a b c | d e" with `|` a 0.8 s pause; 0.25 s words, `gap` between words. */
function say(
	text: string,
	opts: { gap?: number; pause?: number; t0?: number; dur?: number } = {},
): CleanupWordIn[] {
	let t = opts.t0 ?? 1;
	const out: CleanupWordIn[] = [];
	for (const tok of text.split(/\s+/)) {
		if (tok === '|') {
			t += opts.pause ?? 0.8;
			continue;
		}
		const d = opts.dur ?? 0.25;
		out.push({ text: tok, start: S(t), end: S(t + d), confidence: 0.9 });
		t += d + (opts.gap ?? 0.05);
	}
	return out;
}

function voiceFor(words: readonly CleanupWordIn[], extraSpeech: Array<[number, number]> = []): CleanupVoice {
	const end = Math.max(...words.map((w) => w.end)) / FLICKS_PER_SECOND + 2;
	const n = Math.ceil(end * 100);
	const classes = new Uint8Array(n);
	const level = new Uint8Array(n).fill((120 - 65) * 2);
	const mark = (a: number, b: number) => {
		for (let f = Math.floor(a * 100); f < Math.min(n, Math.ceil(b * 100)); f++) {
			classes[f] = 2;
			level[f] = (120 - 25) * 2;
		}
	};
	for (const w of words) mark(w.start / FLICKS_PER_SECOND, w.end / FLICKS_PER_SECOND);
	for (const [a, b] of extraSpeech) mark(a, b);
	return {
		classes,
		level,
		frameCount: n,
		levels: { floorDb: -65, speechDb: -25, speechThresholdDb: -53, breathFloorDb: -60 },
	};
}

function kinds(
	text: string,
	o: {
		language?: string;
		settings?: CleanupOverrides;
		base?: typeof FAST_SETTINGS;
		script?: string;
		voice?: boolean;
		words?: CleanupWordIn[];
	} = {},
) {
	const words = o.words ?? say(text);
	const r = detectCleanup({
		mediaId: 'med_r',
		words,
		voice: o.voice === false ? null : voiceFor(words),
		language: o.language ?? 'es',
		script: o.script ?? null,
		settings: mergeCleanupSettings(o.base ?? FAST_SETTINGS, o.settings),
	});
	const byWord = words.map(() => null as null | FindingKind);
	for (const f of r.findings) if (f.words) for (let i = f.words[0]; i <= f.words[1]; i++) byWord[i] = f.kind;
	return { r, byWord, label: (i: number) => byWord[i] };
}

describe('lists and languages', () => {
	it('normalises like the prototype and picks lists by language tag', () => {
		expect(cleanupNorm('¿Sí?')).toBe('si');
		expect(cleanupNorm('Diseñé,')).toBe('disene');
		expect(cleanupNorm('jue-')).toBe('jue');
		expect(cleanupLanguageOf('es-MX')).toBe('es');
		expect(cleanupLanguageOf('spa')).toBe('es');
		expect(cleanupLanguageOf('en-US')).toBe('en');
		expect(cleanupLanguageOf('und')).toBeNull();
		expect(effectiveLists('es').fillers).toContain('mmm');
		expect(effectiveLists('es').fillers).not.toContain('a');
		expect(effectiveLists('en').fillers).toContain('um');
		expect(effectiveLists(null).markers).toEqual([]);
		// edited lists replace the built-in list they name (normalised)
		const l = effectiveLists('es', { fillers: ['Ehh', 'o sea'], markers: ['¿Sabes?'] });
		expect(l.fillers).toEqual(['ehh']);
		expect(l.markers).toEqual(['sabes']);
		expect(l.allow).toEqual(effectiveLists('es').allow);
	});
});

describe('rules (Spanish)', () => {
	it('vocalic fillers and a drawn-out vowel', () => {
		const words = [...say('hoy eh vamos'), { text: 'yyy', start: S(3), end: S(4.2), confidence: 0.9 }];
		const { label } = kinds('', { words });
		expect(label(1)).toBe('filler-vocalic');
		expect(label(3)).toBe('filler-vocalic');
		expect(label(0)).toBeNull();
		// "a" (the preposition) is not a filler
		expect(kinds('voy a casa').label(1)).toBeNull();
	});

	it('restarts, false starts and retakes with a take group (last take kept)', () => {
		const r = kinds('le puse texturas le puse texturas a la carretera');
		expect(r.byWord.slice(0, 3)).toEqual(['restart', 'restart', 'restart']);
		expect(r.byWord.slice(3)).toEqual([null, null, null, null, null, null]);
		const fs = kinds('primero | primero diseñé la carretera');
		expect(fs.label(0)).toBe('false-start');
		const rt = kinds('diseñé las curvas cerradas | ahora diseñé las curvas muy cerradas y largas', {
			settings: { rules: { restart: 'off' } },
		});
		expect(rt.byWord.slice(0, 4)).toEqual(['retake', 'retake', 'retake', 'retake']);
		const g = rt.r.groups[0]!;
		expect(g.takes).toHaveLength(2);
		expect(g.chosen).toBe(1);
		expect(rt.r.findings.find((f) => f.kind === 'retake')!.group).toBe(g.id);
	});

	it('restarts and retakes re-say what they remove: lists, comparisons and other numbers are kept (Clean Up report)', () => {
		// a repeated n-gram framing different words: cutting up to its second copy loses words said once
		for (const text of [
			'el tema oscuro de Unity, la barra de menús de Unity y los iconos',
			'o tipo caricatura, o tipo de goma',
			'mis juegos en mi motor funcionan mejor que mis juegos en Unity',
			// a different number is a different statement, not a restart or a retake of the line
			'Me quedan nueve días | Me quedan seis días y quiero terminar el juego',
			'Me quedan 9 días | Me quedan 6 días y quiero terminar el juego',
		])
			expect(kinds(text).byWord.filter(Boolean), text).toEqual([]);
	});

	it('a script prefers an earlier take that covers the line better', () => {
		const script = 'Diseñé las curvas cerradas para el circuito de montaña.';
		const r = kinds(
			'diseñé las curvas cerradas para el circuito de montaña | diseñé las curvas cerradas para',
			{
				script,
				settings: { rules: { restart: 'off', falseStart: 'off' } },
			},
		);
		const g = r.r.groups[0];
		expect(g).toBeDefined();
		expect(g!.chosen).toBe(0);
		expect(g!.takes[0]!.scriptLine).toBe(0);
		// the later, shorter take is the one removed
		expect(r.byWord.slice(0, 9).every((k) => k === null)).toBe(true);
		expect(r.byWord.slice(9).every((k) => k === 'retake')).toBe(true);
		expect(r.r.script).toEqual([{ index: 0, text: script, said: true, takes: 2 }]);
	});

	it('off-script phrases and head / tail need a script', () => {
		const script = 'Hoy vamos a crear un juego de carreras.\nDespués programé los coches.';
		const r = kinds(
			'vale ya está grabando esto | hoy vamos a crear un juego de carreras | madre mía qué calor hace aquí | después programé los coches | adiós amigos',
			{ script },
		);
		expect(r.byWord.slice(0, 5).every((k) => k === 'off-script')).toBe(true);
		expect(r.byWord.slice(13, 19).every((k) => k === 'off-script')).toBe(true);
		expect(r.byWord.slice(5, 13).every((k) => k === null)).toBe(true);
		expect(r.byWord.slice(23)).toEqual(['head-tail', 'head-tail']);
		const none = kinds('vale ya está grabando esto | hoy vamos a crear un juego');
		expect(none.byWord.some((k) => k === 'off-script' || k === 'head-tail')).toBe(false);
	});

	it('off-script chatter is found although its function words occur in the script', () => {
		// A speaker thinking aloud between script lines: "cómo" and "lo" are in every Spanish script, and counting them
		// put the phrase over the in-script share, so long recordings got no off-script findings at all.
		const script =
			'Hoy os enseño cómo funciona Claude Code.\nLo podéis instalar con un solo comando.\nDespués os explico cómo lo uso yo cada día.';
		const r = kinds(
			'hoy os enseño cómo funciona claude code | ¿Cómo lo puedo pronunciar? Cloud… | lo puedes instalar con un comando | después os explico cómo lo uso yo cada día',
			{ script },
		);
		expect(r.byWord.slice(7, 12)).toEqual(Array(5).fill('off-script'));
		// on-script lines, one of them reworded, stay
		expect(r.byWord.slice(0, 7).every((k) => k === null)).toBe(true);
		expect(r.byWord.slice(12).every((k) => k === null)).toBe(true);
	});

	it('a paraphrased closing line is not tail chatter (TC-071 calibration regression)', () => {
		// The user rewords the last script line when recording; the head / tail rule used to cut everything after the
		// last unit that matched a line, i.e. the closing sentences the user kept (head / tail precision 0.17 on shorts).
		const script = 'Hoy vamos a crear un juego de carreras.\nAl final añadí música y efectos de sonido.';
		const r = kinds(
			'hoy vamos a crear un juego de carreras | y para terminar le puse música chula al juego | madre mía qué calor hace | adiós amigos',
			{ script },
		);
		expect(r.r.script?.map((l) => l.said)).toEqual([true, false]);
		expect(r.byWord.slice(0, 17).every((k) => k === null)).toBe(true);
		// chatter after it is still removed: off-script (≥ 3 content words), else tail
		expect(r.byWord.slice(17, 22).every((k) => k === 'off-script')).toBe(true);
		expect(r.byWord.slice(22)).toEqual(['head-tail', 'head-tail']);
		// the head side stays strict: on-topic pre-roll before the first scripted line is still head (the user cuts it)
		const h = kinds('vale ya | vamos allá que hoy hay juego nuevo | hoy vamos a crear un juego de carreras', {
			script,
		});
		expect(h.byWord.slice(0, 9).every((k) => k === 'head-tail')).toBe(true);
		expect(h.byWord.slice(9).every((k) => k === null)).toBe(true);
	});

	it('marker phrases alone between pauses go; inside a sentence they stay; at a clause start they are reviewed', () => {
		const r = kinds('bueno | a ver | este video es genial | pero bueno funciona');
		expect(r.byWord.slice(0, 3)).toEqual(['filler-phrase', 'filler-phrase', 'filler-phrase']);
		expect(r.label(3)).toBeNull(); // "este video"
		expect(r.label(8)).toBeNull(); // "pero bueno"
		const words = say('bueno, ahora vamos', { gap: 0.2 });
		const lx = kinds('', { words });
		expect(lx.label(0)).toBe('filler-lexical');
		expect(lx.r.findings[0]!.suggested).toBe('review');
		expect(lx.r.findings[0]!.confidence).toBeLessThan(0.5);
		// Natural lists marker phrases for review only
		expect(kinds('bueno | hoy vamos', { base: NATURAL_SETTINGS }).r.findings[0]!.suggested).toBe('review');
	});

	it('stutters: repeats with almost no gap and cut-off words; emphasis is allowed', () => {
		const r = kinds('el el juego');
		expect(r.label(0)).toBe('stutter');
		expect(r.label(1)).toBeNull();
		expect(kinds('no no quiero eso', { settings: { rules: { restart: 'off' } } }).label(0)).toBeNull();
		const cut = kinds('jue- juego nuevo');
		expect(cut.label(0)).toBe('stutter');
		// a pause ≥ 0.3 s between the copies is not a stutter
		expect(
			kinds('el | el juego', { settings: { rules: { falseStart: 'off', retake: 'off' } } }).label(0),
		).toBeNull();
	});

	it('ASR suspects: low confidence, implausible durations, decoder scores', () => {
		const words = say('hola a todos');
		words[0]!.confidence = 0.2;
		words[2] = { ...words[2]!, end: words[2]!.start + S(3) };
		const r = kinds('', { words });
		expect(r.label(0)).toBe('asr-suspect');
		expect(r.label(2)).toBe('asr-suspect');
		expect(r.r.findings.find((f) => f.kind === 'asr-suspect')!.suggested).toBe('review');
		const w2 = say('hola a todos');
		const seg = detectCleanup({
			mediaId: 'med_r',
			words: w2,
			voice: voiceFor(w2),
			language: 'es',
			segments: [{ start: w2[0]!.start, end: w2[2]!.end, avgLogprob: -1.4 }],
			settings: FAST_SETTINGS,
		});
		expect(seg.findings.filter((f) => f.kind === 'asr-suspect').length).toBeGreaterThan(0);
	});

	it('hallucination guard: runs of identical tokens, words over silence, known phrases over non-speech', () => {
		const words = say('cab cab cab cab cab hola amigos');
		const r = kinds('', { words });
		expect(r.byWord.slice(0, 5).every((k) => k === 'hallucination')).toBe(true);
		const silent = [...say('hola amigos'), { text: 'Gracias.', start: S(5), end: S(5.5), confidence: 0.9 }];
		const d = detectCleanup({
			mediaId: 'med_r',
			words: silent,
			voice: voiceFor(silent.slice(0, 2)),
			language: 'es',
			settings: FAST_SETTINGS,
		});
		expect(d.findings.find((f) => f.kind === 'hallucination')?.words).toEqual([2, 2]);
		expect(d.guarded).toEqual([false, false, true]);
	});

	it('frame findings: pauses, breaths next to speech and untranscribed voice', () => {
		const words = say('hola a todos | vamos a empezar', { pause: 1.5 });
		const v = voiceFor(words, [[2.2, 2.5]]);
		// a breath just before "vamos"
		const onset = words[3]!.start / FLICKS_PER_SECOND;
		for (let f = Math.floor((onset - 0.3) * 100); f < Math.floor((onset - 0.02) * 100); f++) v.classes[f] = 1;
		const d = detectCleanup({ mediaId: 'med_r', words, voice: v, language: 'es', settings: FAST_SETTINGS });
		const k = d.findings.map((f) => f.kind);
		expect(k).toContain('pause');
		expect(k).toContain('breath');
		const u = d.findings.find((f) => f.kind === 'untranscribed')!;
		expect(u.suggested).toBe('review');
		expect(u.range.start / FLICKS_PER_SECOND).toBeCloseTo(2.2, 1);
	});
});

describe('round 6 local fixes (docs/wp-notes/transcript-cleanup.md "Repeats by alignment")', () => {
	const sec = (f: number) => f / FLICKS_PER_SECOND;
	const detect = (words: CleanupWordIn[], voice: CleanupVoice) =>
		detectCleanup({ mediaId: 'med_r', words, voice, language: 'es', settings: FAST_SETTINGS });

	it('a coordinating "e" said into an i- word is no filler; a held "e" is', () => {
		expect(kinds('de Godot e incluso en juegos').byWord).toEqual([null, null, null, null, null, null]);
		expect(kinds('de Godot | e | ahora').label(2)).toBe('filler-vocalic');
	});

	it('a reduplication is reviewed, never cut by default; a restart of one word is', () => {
		const g = kinds('que no cuesta nada. Guiño, guiño. | En Unity', {
			words: say('que no cuesta nada. Guiño, guiño. | En Unity'),
		});
		const f = g.r.findings.find((x) => x.kind === 'stutter')!;
		expect(f.suggested).toBe('review');
		expect(kinds('y hace boing, boing, boing.').r.findings.filter((x) => x.suggested === 'remove')).toEqual(
			[],
		);
		expect(kinds('Ya. Ya me pasó con Godot').label(0)).toBe('false-start');
	});

	it('breaths and pauses never cut into a kept word (fricative onset, closure inside)', () => {
		const words = say('hola | Physics gelatina', { pause: 1 });
		const v = voiceFor(words);
		const [ps, pe] = [sec(words[1]!.start), sec(words[1]!.end)];
		// "Ph": unvoiced breath-like noise over the word's first 120 ms and the 30 ms before it
		for (let f = Math.round((ps - 0.03) * 100); f < Math.round((ps + 0.12) * 100); f++) {
			v.classes[f] = 1;
			v.level[f] = (120 - 28) * 2;
		}
		// a 150 ms closure in "gelatina" (silence inside its time)
		const gs = sec(words[2]!.start);
		v.classes.fill(0, Math.round((gs + 0.05) * 100), Math.round((gs + 0.2) * 100));
		v.level.fill((120 - 65) * 2, Math.round((gs + 0.05) * 100), Math.round((gs + 0.2) * 100));
		const d = detect(words, v);
		for (const f of d.findings.filter((x) => x.kind === 'breath' || x.kind === 'pause'))
			for (const w of words.slice(1))
				expect(
					sec(f.range.end) <= sec(w.start) + 1e-9 || sec(f.range.start) >= sec(w.end) - 1e-9,
					`${f.kind} ${sec(f.range.start)}–${sec(f.range.end)} in "${w.text}" (${ps}–${pe})`,
				).toBe(true);
	});

	it('a review-only sliver between two removed pauses is proposed for removal', () => {
		const words = say('hola | pasa? | vamos', { pause: 1 });
		words[1]!.end = words[1]!.start + S(0.1);
		words[1]!.confidence = 0.2;
		const d = detect(words, voiceFor(words));
		const f = d.findings.find((x) => x.kind === 'asr-suspect')!;
		expect(f.suggested).toBe('remove');
	});

	it('a stock phrase over voice without frication is a hallucination to review; with it, speech', () => {
		const words = say('vamos | ¡Suscríbete al canal! | Ahora', { pause: 1, dur: 0.6 });
		const v = voiceFor(words);
		const n = v.frameCount;
		// hummed under the speech level (round 6 measured the humming at −17…−30 dBFS; speech peaks around −6…−10)
		v.level.fill((120 - 35) * 2, Math.floor(sec(words[1]!.start) * 100), Math.ceil(sec(words[3]!.end) * 100));
		const hum = { ...v, voicing: new Uint8Array(n).fill(200), flatness: new Uint8Array(n).fill(10) };
		const f = detect(words, hum).findings.find((x) => x.kind === 'hallucination')!;
		expect(f.words).toEqual([1, 3]);
		expect(f.suggested).toBe('review');
		const flatness = new Uint8Array(n).fill(10);
		// the "s" of "Suscríbete": 60 ms of unvoiced noise
		const s0 = Math.round(sec(words[1]!.start) * 100);
		flatness.fill(120, s0, s0 + 6);
		const voicing = new Uint8Array(n).fill(200).fill(40, s0, s0 + 6);
		expect(
			detect(words, { ...v, voicing, flatness }).findings.filter((x) => x.kind === 'hallucination'),
		).toEqual([]);
	});
});

describe('round 8 fixes (docs/wp-notes/transcript-cleanup.md "Round 8")', () => {
	const sec = (f: number) => f / FLICKS_PER_SECOND;
	const detect = (words: CleanupWordIn[], voice: CleanupVoice) =>
		detectCleanup({ mediaId: 'med_r', words, voice, language: 'es', settings: FAST_SETTINGS });
	const removes = (d: ReturnType<typeof detect>, i: number) =>
		d.findings.some((f) => f.words && f.suggested === 'remove' && f.words[0] <= i && i <= f.words[1]);

	it('a greeting said twice with a comma pause is deliberate ("Hola, hola." 0.30 s apart)', () => {
		const words: CleanupWordIn[] = [
			{ text: 'Hola,', start: S(3.13), end: S(3.59), confidence: 0.9 },
			{ text: 'hola.', start: S(3.89), end: S(4.43), confidence: 0.9 },
			...say('Hoy voy a ser mi propio Unity.', { t0: 7.69 }),
		];
		expect(removes(detect(words, voiceFor(words)), 0)).toBe(false);
	});

	it('an interjection written with a comma before a word opens an exclamation, no filler phrase ("Oh, | shit")', () => {
		const words = say('Oh, | shit, a ver. | Hola.', { pause: 0.75 });
		const d = detect(words, voiceFor(words));
		expect(removes(d, 0)).toBe(false);
		expect(kinds('bueno | oh | vamos').label(1)).toBe('filler-phrase');
	});

	it('a pause ends before voiced sound under the speech threshold that leads into an onset', () => {
		const words: CleanupWordIn[] = [
			{ text: 'shit.', start: S(1), end: S(1.25), confidence: 0.9 },
			{ text: 'ver', start: S(2.12), end: S(2.4), confidence: 0.9 },
		];
		const v = voiceFor(words);
		const voicing = new Uint8Array(v.frameCount).fill(30);
		for (const w of words) voicing.fill(200, Math.floor(sec(w.start) * 100), Math.ceil(sec(w.end) * 100));
		// 0.75 s of breath-like noise, then the soft voiced "a" of a missed "a ver" at −42 dBFS, not speech
		for (let f = 125; f < 200; f++) {
			v.classes[f] = 1;
			v.level[f] = (120 - 50) * 2;
		}
		for (let f = 200; f < 212; f++) v.level[f] = (120 - 42) * 2;
		voicing.fill(200, 200, 212);
		const d = detect(words, { ...v, voicing, flatness: new Uint8Array(v.frameCount).fill(60) });
		const pauses = d.findings
			.filter((f) => f.kind === 'pause')
			.map((f) => [sec(f.range.start), sec(f.range.end)]);
		expect(pauses.length).toBeGreaterThan(0);
		for (const [a, b] of pauses) expect(b <= 2 + 1e-9 || a >= 2.12 - 1e-9, `pause ${a}–${b}`).toBe(true);
	});

	/** Indices of the words a finding that removes covers. */
	const removed = (d: ReturnType<typeof detect>) => d.words.map((w) => w.i).filter((i) => removes(d, i));
	const indexOf = (words: readonly CleanupWordIn[], text: string, from = 0) =>
		words.findIndex((w, i) => i >= from && w.text === text);

	it('a stock phrase the recogniser inserted into an attempt does not keep the attempt (U b "¡Suscríbete!")', () => {
		// round 7, fragment U, chunked mode (16.5–49.8 s): ten attempts of one sentence, the third with an inserted
		// "¡Suscríbete!" hummed over 0.68 s; the third was kept and the first two only reviewed
		const real: Array<[string, number, number]> = [
			['Tengo', 16.5, 16.68],
			['solo', 16.68, 16.9],
			['30', 16.9, 17.2],
			['días', 17.2, 17.56],
			['para', 17.56, 17.9],
			['hacer', 17.9, 18.1],
			['un', 18.1, 18.22],
			['motor...', 18.22, 18.6],
			['Tengo', 19.63, 19.72],
			['solo', 19.72, 19.88],
			['30', 19.88, 20.02],
			['días', 20.02, 20.17],
			['para', 20.24, 20.3],
			['hacer', 20.3, 20.36],
			['un', 20.36, 20.44],
			['motor...', 20.44, 20.72],
			['Tengo', 22.84, 23.0],
			['solo', 23.0, 23.16],
			['30', 23.16, 23.4],
			['días', 23.4, 23.78],
			['para', 23.78, 24.02],
			['hacer', 24.02, 24.16],
			['un', 24.16, 24.3],
			['¡Suscríbete!', 24.3, 24.98],
			['motor...', 24.98, 25.91],
			['Tengo', 26.88, 27.05],
			['solo', 27.05, 27.31],
			['30', 27.31, 27.57],
			['días', 27.57, 27.94],
			['para', 27.94, 28.2],
			['hacer', 28.2, 28.38],
			['un', 28.38, 28.52],
			['motor', 28.52, 28.78],
			['de', 28.78, 28.94],
			['videojuegos', 28.94, 29.38],
			['entero.', 29.38, 30.06],
			['Tengo', 30.52, 30.7],
			['solo', 30.7, 30.92],
			['30', 30.92, 31.18],
			['días', 31.18, 31.56],
			['para', 31.56, 31.8],
			['hacer', 31.8, 31.98],
			['un', 31.98, 32.1],
			['video...', 32.1, 32.39],
			['Física', 35.44, 35.64],
			['de...', 35.64, 35.84],
			['Tengo', 37.29, 37.49],
			['solo', 37.49, 37.75],
			['30', 37.75, 38.05],
			['días', 38.05, 38.49],
			['Espera', 38.49, 38.69],
			['No', 39.24, 40.54],
			['Aquí', 41.93, 43.63],
			['Tengo', 45.11, 45.32],
			['solo', 45.32, 45.58],
			['30', 45.58, 45.86],
			['días', 45.86, 46.23],
			['para', 46.23, 46.49],
			['hacer', 46.49, 46.67],
			['un', 46.67, 46.81],
			['motor', 46.81, 47.07],
			['de', 47.07, 47.23],
			['videojuegos', 47.23, 47.63],
			['entero,', 47.63, 48.19],
			['con', 48.23, 48.43],
			['físicas,', 48.43, 49.15],
			['gráficos...', 49.15, 49.79],
		];
		const words = real.map(([text, a, b]) => ({ text, start: S(a), end: S(b), confidence: 0.9 }));
		const v = voiceFor(words);
		// hummed: voiced everywhere, no frication, the inserted word under the speech level
		const ins = indexOf(words, '¡Suscríbete!');
		v.level.fill(
			(120 - 35) * 2,
			Math.floor(sec(words[ins]!.start) * 100),
			Math.ceil(sec(words[ins]!.end) * 100),
		);
		const hum = {
			...v,
			voicing: new Uint8Array(v.frameCount).fill(200),
			flatness: new Uint8Array(v.frameCount).fill(10),
		};
		const d = detect(words, hum);
		const kept = indexOf(words, 'Tengo', 50);
		expect(removed(d)).toEqual(words.slice(0, kept).map((_, i) => i));
		expect(d.findings.filter((f) => f.kind === 'hallucination')).toEqual([]);
	});

	it('a stock phrase woven into an attempt does not move its cut inside it (U a "Tengo al … canal!")', () => {
		const words = say(
			'Tengo solo 30 días para hacer un motor ¡Suscríbete | Tengo al solo 30 días para hacer canal! un motor | Tengo solo 30 días para hacer un motor de videojuegos entero.',
		);
		const d = detect(words, voiceFor(words));
		const second = indexOf(words, 'Tengo', 1);
		const kept = indexOf(words, 'Tengo', second + 1);
		for (let i = 0; i < kept; i++) expect(removes(d, i), words[i]!.text).toBe(true);
	});

	it('words in another writing system are a hallucination to review (U a "Pen 와 blah blah금u")', () => {
		const words = say('Hoy voy a ser mi propio janeter tengo sólo treinta días Pen 와 blah blah금u Unity');
		const f = detect(words, voiceFor(words)).findings.find((x) => x.kind === 'hallucination')!;
		expect(f.suggested).toBe('review');
		expect(f.words).toEqual([indexOf(words, '와'), indexOf(words, 'blah금u')]);
	});

	it('text written over unvoiced noise alone between pauses is one hallucination that goes (V b "¿Qué pasa?")', () => {
		const words = say('cuando tocas un botón. | ¿Qué pasa? | Es algo muy complejo.', { pause: 2 });
		const v = voiceFor(words);
		const voicing = new Uint8Array(v.frameCount).fill(200);
		const [a, b] = [indexOf(words, '¿Qué'), indexOf(words, 'pasa?')];
		const f0 = Math.floor(sec(words[a]!.start) * 100);
		const f1 = Math.ceil(sec(words[b]!.end) * 100);
		voicing.fill(20, f0 - 5, f1 + 5);
		v.level.fill((120 - 40) * 2, f0, f1);
		v.classes.fill(1, f0, f1);
		const hs = detect(words, {
			...v,
			voicing,
			flatness: new Uint8Array(v.frameCount).fill(120),
		}).findings.filter((x) => x.kind === 'hallucination');
		expect(hs.map((x) => [x.words, x.suggested])).toEqual([[[a, b], 'remove']]);
	});

	it('a self-correction aside between a clause and its corrected retry (W: "de Unity. | No, de ellos, …")', () => {
		const text = (aside: string) =>
			`literalmente todos los hice en Unity. eso significa que dependo completamente de Unity. | ${aside} | eso significa que dependo completamente de ellos. Y a veces`;
		// the aside names the corrected word: the attempt and the aside go, with or without the marker
		for (const aside of [
			'No, de ellos, no tengo que repetir tanto.',
			'de ellos, no tengo que repetir tanto.',
		]) {
			const words = say(text(aside));
			const d = detect(words, voiceFor(words));
			const first = indexOf(words, 'eso');
			const retry = indexOf(words, 'eso', first + 1);
			for (let i = 0; i < words.length; i++)
				expect(removes(d, i), `${aside}: ${words[i]!.text}`).toBe(i >= first && i < retry);
		}
		// a correction marker without the word: reviewed
		const words = say(text('No, perdón, me equivoqué.'));
		const d = detect(words, voiceFor(words));
		const f = d.findings.find((x) => x.words?.[0] === indexOf(words, 'eso'))!;
		expect(f.suggested).toBe('review');
	});

	it('a sentence, its abandoned start and the take that stays: both earlier copies go (W a)', () => {
		const words = say(
			'te va muy bien. | Y sí, es cierto, pero tengo mis razones. | sí, es cierto, Y sí, es cierto, pero tengo mis razones. | Eh... Desde que',
		);
		const d = detect(words, voiceFor(words));
		const kept = indexOf(words, 'Y', indexOf(words, 'Y') + 1);
		for (let i = indexOf(words, 'Y'); i < kept; i++) expect(removes(d, i), words[i]!.text).toBe(true);
		expect(removes(d, kept)).toBe(false);
	});

	it('one word the recogniser wrote twice does not keep a whole sentence for review (W a "crecieron crashean")', () => {
		const words = say(
			'Y a veces la Play Store me dice que mis juegos crecieron crashean mucho o que aparece aparece un bug rarísimo | Y a veces la Play Store me dice que mis juegos crecían mucho o que aparece un bug rarísimo. | Y después',
		);
		const d = detect(words, voiceFor(words));
		const retry = indexOf(words, 'Y', 1);
		for (let i = 0; i < retry; i++) expect(removes(d, i), words[i]!.text).toBe(true);
	});
});

describe('round 10 fixes (docs/wp-notes/transcript-cleanup.md "Round 10")', () => {
	const sec = (f: number) => f / FLICKS_PER_SECOND;
	const detect = (words: CleanupWordIn[], voice: CleanupVoice = voiceFor(words)) =>
		detectCleanup({ mediaId: 'med_r', words, voice, language: 'es', settings: FAST_SETTINGS });
	const removes = (d: ReturnType<typeof detect>, i: number) =>
		d.findings.some((f) => f.words && f.suggested === 'remove' && f.words[0] <= i && i <= f.words[1]);
	const indexOf = (words: readonly CleanupWordIn[], text: string, from = 0) =>
		words.findIndex((w, i) => i >= from && w.text === text);
	/** Words written "text[start-end]" (seconds). */
	const real = (s: string): CleanupWordIn[] =>
		s
			.trim()
			.split(/\s+/)
			.map((x) => {
				const m = /^(.*)\[([\d.]+)-([\d.]+)\]$/.exec(x)!;
				return { text: m[1]!, start: S(Number(m[2])), end: S(Number(m[3])), confidence: 0.9 };
			});

	it('the end of a sentence the next sentence opens with is no false start (AD "…las luces y las sombras.")', () => {
		// run 9, fragment AD: "las sombras." ended the sentence; the next one opened with "las sombras" 15 s later
		const end = 'Así que le puse shaders que son la receta, se renderizan las luces y las sombras.';
		const next = 'las sombras funcionan dibujando la escena desde el punto de vista de la luz.';
		for (const [first, pause] of [
			[end, 15],
			// the sentence rule alone: the retry right after leaves "…las luces y" hanging
			[end, 1],
			// adjacency alone: no sentence end written, but 15 s of silence before the words come again
			[end.replace(/\.$/, ''), 15],
		] as const) {
			const words = say(`${first} | ${next}`, { pause });
			const d = detect(words);
			const at = indexOf(words, 'las', indexOf(words, 'y'));
			expect(removes(d, at) || removes(d, at + 1), `${first} (${pause} s)`).toBe(false);
		}
	});

	it('a stock word said as loud as the speech around it is speech, not a hummed hallucination (AC "gracias")', () => {
		// run 9, fragment AC: "Bueno, ok, gracias por avisar…" at −6…−10 dBFS, voicing 0.78–0.87; its final /s/ measured
		// flatness 0.10–0.18, under the frication test — the stock phrase alone flagged it
		const words = say('Bueno, ok, gracias por avisar, hermano.', { dur: 0.32 });
		const v = voiceFor(words);
		const n = v.frameCount;
		const voiced = { ...v, voicing: new Uint8Array(n).fill(210), flatness: new Uint8Array(n).fill(35) };
		expect(detect(words, voiced).findings.filter((f) => f.kind === 'hallucination')).toEqual([]);
	});

	it('a correction "[new], no [old]" with a word the recogniser inserted keeps the corrected take (AE b)', () => {
		// run 9, AE chunked: "…en cada imagen del juego. | cada La frame, no imagen. | Y el procesador … en cada frame del
		// juego." kept the "imagen" take and the correction: 22 words heard twice
		const words = real(`En[5.53-5.75] Unity[5.75-5.97] por[5.97-6.23] defecto[6.23-6.77] cada[6.77-7.01]
			personaje[7.01-7.47] se[7.48-7.65] anima[7.65-7.9] con[7.91-8.07] un[8.07-8.23]
			esqueleto[8.23-8.79] el[9.17-9.27] procesador[9.27-9.79] tiene[9.79-9.97] que[9.97-10.09]
			calcular[10.09-10.65] dónde[10.65-10.91] está[10.91-11.11] cada[11.11-11.37]
			hueso...[11.37-11.96] el[13.84-13.96] procesador[13.96-14.48] tiene[14.48-14.78] que[14.78-14.9]
			calcular[14.9-15.46] dónde[15.46-15.72] está[15.72-15.9] cada[15.9-16.14] hueso[16.14-16.54]
			de[16.54-16.64] cada[16.64-16.82] personaje[16.82-17.4] en[17.41-17.7] cada[17.7-17.88]
			imagen[17.88-18.26] del[18.26-18.44] juego.[18.44-18.85] cada[21.27-21.41] La[21.41-21.47]
			frame,[21.54-21.75] no[22.02-22.11] imagen.[22.11-22.32] Y[26.87-27.07] el[27.07-27.19]
			procesador[27.19-27.72] tiene[27.72-27.96] que[27.96-28.1] calcular[28.1-28.56]
			dónde[28.56-28.78] está[28.78-28.94] cada[28.94-29.18] hueso[29.18-29.56] de[29.56-29.68]
			cada[29.68-29.86] personaje[29.86-30.42] en[30.43-30.7] cada[30.7-30.94] frame[30.94-31.22]
			del[31.22-31.38] juego.[31.38-31.77] Con[32.94-33.08] uno[33.08-33.34] o[33.34-33.63]
			diez[33.63-33.77] personajes[33.77-34.22]`);
		const d = detect(words);
		const retry = indexOf(words, 'Y');
		for (let i = indexOf(words, 'el'); i < words.length; i++)
			expect(removes(d, i), `${words[i]!.text} ${sec(words[i]!.start)}`).toBe(i < retry);
	});

	it('a broken-off attempt said again word for word: after an aside, a re-said cut-off word, a lead (AF, AC, AG)', () => {
		// run 9: no finding for any of these in either mode; [first, last] words that go (by start time)
		const cases: Array<[string, number, number]> = [
			// AF: "Sí, ya sé que Roblox usa… ¿Dónde está el enojado? Sí, ya sé que Roblox usa el WoW"
			[
				`usa[49.12-49.48] en[49.48-49.74] Roblox.[49.74-50.29] Sí,[53.41-53.76] ya[53.76-53.84]
				sé[53.84-53.98] que[53.98-54.12] Roblox[54.12-54.62] usa...[54.62-54.98] ¿Dónde[57.26-57.52]
				está[57.52-57.66] el[57.66-57.76] enojado?[57.76-58.06] Sí,[58.49-58.84] ya[58.84-58.92]
				sé[58.92-59.06] que[59.06-59.2] Roblox[59.2-59.68] usa[59.68-59.88] el[59.88-60.02]
				WoW,[60.02-60.58] que[60.62-60.68] es[60.68-60.82] distinto,[60.82-61.64] pero[61.65-61.76]
				no[61.76-61.86] me[61.86-61.96] lo[61.96-62.04] pongan[62.04-62.3] en[62.3-62.38]
				los[62.38-62.46] comentarios.[62.46-63.13]`,
				53.41,
				57.76,
			],
			// AC: "lo peor es que el tor… | Y lo peor es que el motor…" (default and chunked)
			[
				`te[55.1-55.18] borraba[55.18-55.52] el[55.52-55.62] objeto[55.62-55.88] entero.[55.89-56.39]
				lo[60.14-60.24] peor[60.24-60.4] es[60.4-60.51] que[60.52-60.6] el[60.6-60.72]
				tor...[60.72-60.96] Y[61.16-61.34] lo[61.34-61.42] peor[61.42-61.58] es[61.58-61.68]
				que[61.68-61.76] el[61.76-61.86] motor[61.86-62.12] tardaba[62.12-62.56] como[62.56-62.82]
				dos[62.82-63.16] horas[63.16-63.48] en[63.48-63.66] compilar.[63.66-64.23]`,
				60.14,
				60.72,
			],
			[
				`te[55.1-55.2] borraba[55.2-55.54] el[55.54-55.62] objeto[55.62-55.9] entero.[55.9-56.39]
				lo[60.14-60.24] peor[60.24-60.42] es[60.42-60.54] que[60.54-60.6] el[60.6-60.72]
				tor-[60.72-60.96] y[61.16-61.34] lo[61.34-61.46] peor[61.46-61.6] es[61.6-61.7]
				que[61.7-61.78] el[61.78-61.88] motor[61.88-62.12] tardaba[62.12-62.56] como[62.56-62.82]
				dos[62.82-63.16] horas[63.16-63.48] en[63.48-63.66] compilar.[63.66-64.23]`,
				60.14,
				60.72,
			],
			// AG: "es… Espera. es extremadamente rápido." / "Y es… es extremadamente rápido."
			[
				`Pero[0.18-0.3] es[0.3-0.42] que[0.42-0.52] tengo[0.52-0.7] un[0.7-0.82] amigo[0.82-1.06]
				que[1.06-1.28] no[1.28-1.48] come,[1.48-2.08] no[2.08-2.18] descansa,[2.18-2.84]
				ni[2.84-3.06] duerme.[3.06-3.61] es...[4.4-4.75] Espera.[4.95-5.18] es[6.38-6.6]
				extremadamente[6.6-7.48] rápido.[7.48-8.2]`,
				4.4,
				4.95,
			],
			[
				`Pero[0.18-0.3] es[0.3-0.4] que[0.4-0.52] tengo[0.52-0.7] un[0.7-0.82] amigo[0.82-1.08]
				que[1.08-1.3] no[1.3-1.48] come,[1.48-2.08] no[2.08-2.18] descansa,[2.18-2.84] ni[2.84-3.06]
				duerme.[3.06-3.61] Y[4.29-4.42] es...[4.42-4.75] es[6.36-6.6] extremadamente[6.6-7.52]
				rápido.[7.52-8.2]`,
				4.29,
				4.42,
			],
		];
		for (const [text, from, to] of cases) {
			const words = real(text);
			const d = detect(words);
			for (let i = 0; i < words.length; i++) {
				const s = sec(words[i]!.start);
				expect(removes(d, i), `${words[i]!.text} ${s}`).toBe(s >= from - 1e-6 && s <= to + 1e-6);
			}
		}
	});

	it('an abandoned take the retry says again but for one word it drops goes (AC "…después de haber casi…")', () => {
		// run 9, AC: the first take (15 words) stayed for review in both modes because "haber" is not said again
		for (const text of [
			`Bueno,[0.19-0.7] ok,[0.7-0.96] gracias[0.96-1.18] por[1.18-1.4] avisar[1.4-1.82]
			hermano,[1.82-2.3] muy[2.3-2.42] amable[2.42-2.72] de[2.72-2.84] tu[2.84-2.94]
			parte[2.94-3.28] después[3.28-3.54] de[3.55-3.72] haber[3.72-3.86] casi...[3.86-4.22]
			Bueno,[4.93-5.46] ok,[5.47-5.58] gracias[5.58-5.9] por[5.9-6.1] avisar[6.1-6.54]
			hermano,[6.54-7.0] muy[7.0-7.12] amable[7.12-7.42] de[7.42-7.56] tu[7.56-7.66]
			parte[7.66-7.94] después[7.94-8.22] de[8.22-8.38] casi[8.38-8.54] explotar[8.54-8.82]
			mi[8.82-8.98] puta[8.98-9.18] laptop.[9.18-9.42] los[18.02-18.22] bugs,[18.22-18.61]
			oh[18.67-18.9] por[18.9-19.2]`,
			`Bueno,[0.19-0.7] ok,[0.7-0.98] gracias[0.98-1.18] por[1.18-1.4] avisar,[1.4-1.88]
			hermano,[1.88-2.3] muy[2.3-2.44] amable[2.44-2.7] de[2.7-2.84] tu[2.84-2.94]
			parte[2.94-3.28] después[3.28-3.54] de[3.55-3.72] haber[3.72-3.88] casi...[3.88-4.22]
			Bueno,[4.93-5.46] ok,[5.47-5.6] gracias[5.6-5.9] por[5.9-6.1] avisar,[6.1-6.66]
			hermano,[6.66-7.0] muy[7.0-7.12] amable[7.12-7.42] de[7.42-7.56] tu[7.56-7.66]
			parte[7.66-7.95] después[7.96-8.2] de[8.2-8.38] casi[8.38-8.54] explotar[8.54-8.84]
			mi[8.84-8.94] puta[8.94-9.18] laptop.[9.18-9.42] Y[17.94-18.06] los[18.06-18.24]
			bugs,[18.24-18.61] oh[18.67-19.02]`,
		]) {
			const words = real(text);
			const d = detect(words);
			const retry = indexOf(words, 'Bueno,', 1);
			for (let i = 0; i < retry; i++) expect(removes(d, i), words[i]!.text).toBe(true);
			for (let i = retry; i < words.length; i++) expect(removes(d, i), words[i]!.text).toBe(false);
		}
	});

	it('slivers: a loud voiced sound between pauses stays for review; a blip over a removed take goes with it', () => {
		// run 9, AG a: the deliberate mouth sound "Pup." (0.11 s, voiced, −16 dBFS) alone between two removed pauses
		const words: CleanupWordIn[] = [
			...say('La idea que hizo que todo esto fuera posible.'),
			{ text: 'Pup.', start: S(5.5), end: S(5.61), confidence: 0.2 },
			...say('Ya que tenía un ejército de agentes.', { t0: 7.5 }),
		];
		const v = voiceFor(words);
		const voicing = new Uint8Array(v.frameCount).fill(210);
		const pup = detect(words, {
			...v,
			voicing,
			flatness: new Uint8Array(v.frameCount).fill(30),
		}).findings.find((f) => f.words?.[0] === indexOf(words, 'Pup.'))!;
		expect(pup.suggested).toBe('review');
		// run 9, AD a: the recogniser's "Bueno," (0.12 s) over the onset of a removed take's "Así", after a pause
		const take = 'Así que le puse shaders, que son...';
		const blip: CleanupWordIn[] = [
			...say('todo plano?'),
			{ text: 'Bueno,', start: S(3.96), end: S(4.08), confidence: 0.9 },
			...say(`${take} | ${take.replace('...', ' la receta que decide de qué color va cada pixel.')}`, {
				t0: 4.08,
			}),
		];
		const d = detect(blip);
		const f = d.findings.find((x) => x.words?.[0] === 2)!;
		expect([f.kind, f.suggested, sec(f.range.end)]).toEqual(['filler-lexical', 'remove', 4.08]);
	});
});

describe('rules (English)', () => {
	it('English fillers, markers and restarts', () => {
		const r = kinds('so um we built the track | you know | then we we added cars', { language: 'en' });
		expect(r.label(1)).toBe('filler-vocalic');
		expect(r.byWord.slice(6, 8)).toEqual(['filler-phrase', 'filler-phrase']);
		expect(r.label(9)).toBe('stutter');
		// Spanish lists do not apply to English ("este" is a word)
		expect(kinds('este | bueno', { language: 'en' }).byWord).toEqual([null, null]);
	});
});

describe('fingerprints', () => {
	it('are stable for the same finding and differ by media, kind, range and text', () => {
		const a = findingFingerprint('med_1', 1, 'retake', 1.23, 2.34, 'Hola  Amigos');
		expect(a).toBe(findingFingerprint('med_1', 1, 'retake', 1.21, 2.31, 'hola amigos'));
		expect(a).not.toBe(findingFingerprint('med_2', 1, 'retake', 1.23, 2.34, 'hola amigos'));
		expect(a).not.toBe(findingFingerprint('med_1', 1, 'restart', 1.23, 2.34, 'hola amigos'));
		expect(a).not.toBe(findingFingerprint('med_1', 1, 'retake', 1.5, 2.34, 'hola amigos'));
		expect(a).toMatch(/^med_1~1~retake~12~23~[0-9a-f]{8}$/);
		const r1 = kinds('el el juego | eh').r.findings.map((f) => f.fingerprint);
		expect(kinds('el el juego | eh').r.findings.map((f) => f.fingerprint)).toEqual(r1);
		expect(new Set(r1).size).toBe(r1.length);
	});
});

describe('script lines', () => {
	it('splits sentences and line breaks, skips empty lines', () => {
		const l = scriptLines('Hola a todos. ¿Qué tal?\n\nVamos a empezar…\n# ', new Set(['a']));
		expect(l.map((x) => x.text)).toEqual(['Hola a todos.', '¿Qué tal?', 'Vamos a empezar…']);
		expect(l[0]!.content).toEqual(['hola', 'todos']);
	});
});

describe('edges', () => {
	const v: CleanupVoice = {
		frameCount: 40,
		classes: new Uint8Array(40),
		// floor −65; a word from frame 10 to 20 with an onset ramp and a decay to frame 26
		level: Uint8Array.from(
			Array.from({ length: 40 }, (_, k) => {
				const db = k < 9 ? -65 : k === 9 ? -45 : k < 20 ? -25 : k < 27 ? -25 - (k - 19) * 6 : -65;
				return (db + 120) * 2;
			}),
		),
		levels: { floorDb: -65, speechDb: -25, speechThresholdDb: -53, breathFloorDb: -60 },
	};
	it('thresholds against the floor or the speech level', () => {
		expect(edgeThreshold(v, FAST_SETTINGS.edges, 'out')).toBe(-45);
		expect(edgeThreshold(v, FAST_SETTINGS.edges, 'in')).toBe(-40);
		expect(edgeThreshold(v, { ...FAST_SETTINGS.edges, reference: 'speech', outDb: 22 }, 'out')).toBe(-47);
	});
	it('out point inside the decay, in point at the onset', () => {
		// decay: frames 20…26 at −31, −37, −43, −49 …: the first below −45 is frame 23
		expect(levelOutPoint(v, 0.1, 0.2, -45)).toBeCloseTo(0.23, 9);
		expect(levelInPoint(v, 0.1, -40)).toBeCloseTo(0.1, 9);
	});
	it('snaps to the quietest frame boundary in the window, else down (in) / up (out)', () => {
		expect(snapEdge(v, 0.2, 'out', 0.01, [0.185, 0.205, 0.225])).toBe(0.205);
		expect(snapEdge(v, 0.2, 'out', 0.0, [0.185, 0.215])).toBe(0.215);
		expect(snapEdge(v, 0.2, 'in', 0.0, [0.185, 0.215])).toBe(0.185);
		expect(snapEdge(v, 0.25, 'out', 0.02, [0.235, 0.255])).toBe(0.255);
	});
});
