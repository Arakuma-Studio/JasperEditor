// Rebuild from script for the kept speech (docs/wp-notes/script-correction.md "Rebuild from script"): the per-span
// alignment rules on real excerpts of the reporter's cut — heard words from its transcripts at rev 144 (the media's
// current transcript and the first large-v3-turbo pass), the script lines as written — the kept spans of a sequence,
// and the edits written back through `transcript.replaceWords` in one transaction.
import { describe, expect, it } from 'vitest';
import { checkInvariants, FLICKS_PER_SECOND, sequenceWords } from '../src/index.ts';
import {
	type HeardWord,
	keptSpans,
	parseScript,
	REBUILD_DEFAULTS,
	rebuildEdits,
	rebuildSpan,
	rebuildSpans,
} from '../src/script-fix/index.ts';
import { Harness } from './helpers.ts';

const sec = (x: number) => Math.round(x * FLICKS_PER_SECOND);

/** "text[start-end]" words (seconds), as the excerpts were dumped from the project file. */
function heard(s: string, confidence: number | null = 0.9): HeardWord[] {
	return s
		.trim()
		.split(/\s+/)
		.map((tok) => {
			const m = /^(.*)\[([\d.]+)-([\d.]+)\]$/.exec(tok);
			if (!m) throw new Error(`bad token ${tok}`);
			return { text: m[1]!, start: sec(Number(m[2])), end: sec(Number(m[3])), confidence };
		});
}

const SCRIPT = parseScript(
	[
		'Es algo que de hecho es muy complejo de hacer, y si buscas en internet "debería hacer mi propio motor?", el 99% de las respuestas son "no, definitivamente no lo hagas, usa Unity o Godot como todos los demás".',
		'Y el otro 1% son personas que hicieron su propio motor y nunca terminaron un juego en toda su vida.',
		'Y bueno, de la misma forma usando librerías le puse el sistema de sonido, sistema de pathfinding para que los enemigos sepan encontrar el camino por el mapa, y muchas cosas básicas más que usa cualquier juego.',
		'En Unity tienes que agarrar libro por libro, acomodarlo, rotarlo, y revisar que no quede flotando o metido dentro de la madera.',
		'Con unos 30 libros tengo que hacerlo 30 veces manualmente.',
		'Una tortura.',
		'Así que para hacer un botón con bordes redondeados, degradado y brillito, tienes que abrir Photoshop, dibujarlo, exportarlo, meterlo a Unity, recortarlo para que no se deforme…',
		'O sea, literalmente puedes agarrar el HTML y el CSS de una página y se renderiza en el engine como interfaz del juego.',
		'Así que el botón con bordes redondeados, degradado, brillito y sombra son cuatro líneas de código.',
	].join('\n'),
	{ language: 'es' },
);

const text = (ws: ReadonlyArray<{ text: string }>) => ws.map((w) => w.text).join(' ');
const origins = (ws: ReadonlyArray<{ text: string; origin: string }>) =>
	Object.fromEntries(ws.map((w) => [w.text, w.origin]));
const sortedInside = (ws: ReadonlyArray<{ start: number; end: number }>, a: number, b: number) => {
	let prev = a;
	for (const w of ws) {
		expect(w.start).toBeGreaterThanOrEqual(prev);
		expect(w.end).toBeGreaterThanOrEqual(w.start);
		prev = w.end;
	}
	expect(prev).toBeLessThanOrEqual(b);
};

describe("rebuild from script: the alignment rules on the reporter's cut", () => {
	it('replaced inside the span → script text with the heard timing; missing words inserted', () => {
		// rev 144 subtitles read "tienes ir a dibujarlo"; the audio says "…redondeados, degradado y brillito, tienes que
		// abrir Photoshop, dibujarlo" (2.2 s without words after "redondeados,")
		const h = heard(
			'Así[2147.22-2147.38] que[2147.38-2147.52] para[2147.52-2147.68] hacer[2147.68-2147.84] un[2147.84-2147.98] botón[2148.00-2148.24] con[2148.24-2148.44] bordes[2148.53-2148.78] redondeados,[2148.78-2149.05] tienes[2151.21-2151.52] ir[2151.62-2151.74] a[2151.74-2151.92] dibujarlo,[2152.53-2153.19]',
		);
		const r = rebuildSpan({ heard: h, script: SCRIPT, language: 'es' });
		expect(text(r.words)).toBe(
			'Así que para hacer un botón con bordes redondeados, degradado y brillito, tienes que abrir Photoshop, dibujarlo,',
		);
		const o = origins(r.words);
		expect([o.degradado, o.y, o['brillito,']]).toEqual(['inserted', 'inserted', 'inserted']);
		expect([o.abrir, o['Photoshop,']]).toEqual(['replaced', 'replaced']);
		// replaced words keep the heard timing; inserted ones fill the wordless 2.2 s, script-derived confidence
		const at = (t: string) => r.words.find((w) => w.text === t)!;
		expect([at('Photoshop,').start, at('Photoshop,').end]).toEqual([sec(2151.74), sec(2151.92)]);
		expect(at('degradado').start).toBe(sec(2149.05));
		expect(at('brillito,').end).toBe(sec(2151.21));
		expect(at('degradado').confidence).toBe(REBUILD_DEFAULTS.scriptDerivedConfidence);
		sortedInside(r.words, sec(2147.22), sec(2153.19));
	});

	it('a whole missing phrase is inserted where it fits ("sepan encontrar el camino por el mapa")', () => {
		// rev 144: "sepan el mapa" — the transcript had lost "encontrar el camino por", which the audio says
		const h = heard(
			'el[986.39-986.46] sistema[986.47-986.73] de[986.75-987.01] sonido,[987.04-987.58] sistema[987.69-987.93] de[987.94-988.19] pathfinding[988.22-988.62] para[988.84-988.93] que[988.94-989.08] los[989.09-989.23] enemigos[989.25-989.59] sepan[989.59-989.91] el[990.25-990.36] mapa,[990.99-991.11]',
		);
		const r = rebuildSpan({ heard: h, script: SCRIPT, language: 'es' });
		expect(text(r.words)).toBe(
			'el sistema de sonido, sistema de pathfinding para que los enemigos sepan encontrar el camino por el mapa,',
		);
		expect(r.counts).toMatchObject({ inserted: 4, dropped: 0 });
		const i = r.words.findIndex((w) => w.text === 'encontrar');
		// between "sepan" (ends 989.91) and the heard "el" (990.25…)
		expect(r.words[i]!.start).toBeGreaterThanOrEqual(sec(989.91));
		expect(r.words[i + 3]!.end).toBeLessThanOrEqual(r.words[i + 4]!.start);
		sortedInside(r.words, sec(986.39), sec(991.11));
	});

	it('words not in the script are dropped, or kept with keepOffScript', () => {
		// rev 144: "En En Unity tienes que agarrar…" (a restart Whisper wrote twice)
		const h = heard(
			'En[1552.90-1553.06] En[1553.06-1553.21] Unity[1553.21-1553.47] tienes[1553.53-1553.85] que[1553.85-1553.97] agarrar[1553.97-1554.50] libro[1554.51-1554.79] por[1554.79-1554.99] libro,[1554.99-1555.52]',
		);
		const dropped = rebuildSpan({ heard: h, script: SCRIPT, language: 'es' });
		expect(text(dropped.words)).toBe('En Unity tienes que agarrar libro por libro,');
		expect(dropped.counts.dropped).toBe(1);
		const kept = rebuildSpan({ heard: h, script: SCRIPT, language: 'es', keepOffScript: true });
		expect(text(kept.words)).toBe('En En Unity tienes que agarrar libro por libro,');
		expect(kept.counts.kept).toBe(1);
	});

	it('equal words take the script spelling', () => {
		// large-v3-turbo wrote "manualmente, una tortura." where the script reads "manualmente. / Una tortura."
		const h = heard(
			'hacerlo[1576.52-1576.80] 30[1576.80-1577.08] veces[1577.08-1577.44] manualmente,[1577.44-1578.16] una[1578.16-1578.30] tortura.[1578.30-1578.94]',
		);
		const r = rebuildSpan({ heard: h, script: SCRIPT, language: 'es' });
		expect(text(r.words)).toBe('hacerlo 30 veces manualmente. Una tortura.');
		expect(r.counts).toMatchObject({ exact: 6, replaced: 0, inserted: 0 });
		expect(r.words.map((w) => [w.start, w.end])).toEqual(h.map((w) => [w.start, w.end]));
	});

	it('a spoken symbol written apart joins its number: "1 %" → "1%", never "1% %"', () => {
		const h = heard(
			'el[471.34-471.46] otro[471.46-471.62] 1[471.62-471.82] %[471.82-472.30] Son[472.30-472.66] personas[472.66-472.96] que[472.96-473.08]',
		);
		const r = rebuildSpan({ heard: h, script: SCRIPT, language: 'es' });
		expect(text(r.words)).toBe('el otro 1% son personas que');
		// the number word covers the symbol's sound
		expect([r.words[2]!.start, r.words[2]!.end]).toEqual([sec(471.62), sec(472.3)]);
	});

	it('emoticons ride on the word before them: from the current transcript, and from the script', () => {
		// the current transcript has "juego XD." (added by hand; never heard); the re-transcription hears "juego."
		const h = heard(
			'como[2271.98-2272.26] interfaz[2272.26-2272.66] del[2272.66-2272.80] juego.[2272.80-2273.37]',
		);
		const previous = heard(
			'como[2271.97-2272.27] interfaz[2272.27-2272.65] del[2272.72-2272.80] juego[2272.83-2273.11] XD.[2273.11-2273.28]',
		);
		const [r] = rebuildSpans({ spans: [h], previous: [previous], script: SCRIPT, language: 'es' });
		expect(text(r!.words)).toBe('como interfaz del juego. XD.');
		const xd = r!.words[4]!;
		expect(xd.origin).toBe('emoticon');
		expect(xd.start).toBe(r!.words[3]!.end);
		expect(xd.end - xd.start).toBe(Math.round(REBUILD_DEFAULTS.emoticonSeconds * FLICKS_PER_SECOND));
		// a script that writes the emoticon: attached after its word although nobody says it
		const withXd = parseScript('se renderiza en el engine como interfaz del juego XD.\nAsí que el botón', {
			language: 'es',
		});
		const s = rebuildSpan({
			heard: [
				...h,
				...heard('Así[2273.60-2273.80] que[2273.80-2273.90] el[2273.90-2274.00] botón[2274.00-2274.40]'),
			],
			script: withXd,
			language: 'es',
		});
		expect(text(s.words)).toBe('como interfaz del juego XD. Así que el botón');
		expect(s.words[4]!.start).toBe(s.words[3]!.end);
	});

	it('spans align in one pass but nothing missing is inserted across their boundary', () => {
		// two kept spans of one sentence with a removed restart between them: the script words between the spans'
		// words ("encontrar el camino por") are not spoken in the kept audio of either span
		const a = heard('los[989.09-989.23] enemigos[989.25-989.59] sepan[989.59-989.91]');
		const b = heard('el[990.82-990.94] mapa,[990.94-991.24] y[991.24-991.54] muchas[991.54-991.80]');
		const [ra, rb] = rebuildSpans({ spans: [a, b], script: SCRIPT, language: 'es' });
		expect(text(ra!.words)).toBe('los enemigos sepan');
		expect(text(rb!.words)).toBe('el mapa, y muchas');
	});
});

describe('rebuild from script: kept spans and the edits', () => {
	/** 30 fps: media A transcribed (words every 0.3 s from 0.3 s), placed on A1 by the given clips. */
	function cut(words: string[], clips: Array<[number, number, number]>) {
		const H = new Harness({ preset: 'hd-1080p-30' });
		const a = H.registerVideo({ seconds: 60 });
		for (const [at, inS, outS] of clips)
			H.ok([
				{
					type: 'clip.place',
					source: { mediaId: a },
					sourceRange: { in: { seconds: inS }, out: { seconds: outS } },
					at,
					tracks: { audio: ['A1'] },
					mode: 'overwrite',
				},
			]);
		const r = H.ok([
			{
				type: 'transcript.create',
				mediaId: a,
				language: 'es',
				origin: 'whisper-local',
				words: words.map((t, i) => ({
					text: t,
					start: sec(0.3 + i * 0.3),
					end: sec(0.3 + i * 0.3 + 0.25),
					confidence: 0.5,
				})),
			},
		]);
		return { H, a, transcriptId: (r.results[0] as { transcriptId: string }).transcriptId };
	}

	it('merges clips of one media that touch or share a word; separate takes stay separate', () => {
		const { H, a, transcriptId } = cut(
			['uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho'],
			[
				[0, 0, 1], // 0–1 s
				[30, 1, 1.3], // touches the first
				[39, 1.4, 1.8], // 0.1 s later, but "cuatro" (1.2–1.45) is heard in both
				[51, 2.2, 2.6], // a later take
			],
		);
		const spans = keptSpans(H.doc, H.seq);
		expect(spans.map((s) => [s.start, s.end])).toEqual([
			[0, sec(1.8)],
			[sec(2.2), sec(2.6)],
		]);
		expect(spans.every((s) => s.mediaId === a && s.transcriptId === transcriptId)).toBe(true);
	});

	it('writes a span back as ≤ 64-word edits in one transaction: invariants hold, the sequence reads the script', () => {
		const n = 150;
		const old = Array.from({ length: n }, (_, i) => `palabra${i}`);
		const { H, transcriptId } = cut(old, [[0, 0, 0.3 + n * 0.3]]);
		const [span] = keptSpans(H.doc, H.seq);
		const words = Array.from({ length: n }, (_, i) => ({
			text: `Palabra${i}.`,
			start: sec(0.32 + i * 0.3),
			end: sec(0.32 + i * 0.3 + 0.2),
			confidence: 0.8,
			origin: 'exact' as const,
		}));
		const edits = rebuildEdits(H.doc.transcripts[transcriptId]!.words, span!, words)!;
		expect(edits.length).toBeGreaterThan(2);
		expect(edits.every((e) => e.expect.length <= 64 && e.words.length <= 64)).toBe(true);
		const before = H.doc;
		H.ok([{ type: 'transcript.replaceWords', transcriptId, edits }]);
		expect(checkInvariants(H.doc)).toEqual([]);
		expect(sequenceWords(H.doc, H.seq).map((w) => w.text)).toEqual(words.map((w) => w.text));
		// the previous document (what undo restores) is untouched
		expect(before.transcripts[transcriptId]!.words.map((w) => w.text)).toEqual(old);
		// nothing to write when the words are already there
		expect(rebuildEdits(H.doc.transcripts[transcriptId]!.words, span!, words)).toEqual([]);
	});
});
