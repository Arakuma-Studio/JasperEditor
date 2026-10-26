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
