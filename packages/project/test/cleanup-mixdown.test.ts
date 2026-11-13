// Clean Up on a dense, loudness-normalised mixdown (docs/wp-notes/transcript-cleanup.md "Hallucinations need non-speech
// evidence"): the real words, confidences and levels of `cut_v5.wav` (large-v3-turbo, voice analysis v2, main
// 37fd05e43), where 37 recovered script words were removed as hallucinations over non-speech and, with voice analysis
// v1, the head took 0–666 s of the 931 s scripted cut.
import { describe, expect, it } from 'vitest';
import { type CleanupVoice, type CleanupWordIn, detectCleanup } from '../src/cleanup/detector.ts';
import { type CleanupOverrides, FAST_SETTINGS, mergeCleanupSettings } from '../src/cleanup/schema.ts';
import { FLICKS_PER_SECOND } from '../src/time.ts';

const S = (x: number) => Math.round(x * FLICKS_PER_SECOND);
const sec = (f: number) => f / FLICKS_PER_SECOND;

/** Words written "text[start-end]@confidence" (seconds; confidence 1 when absent), shifted by `t0` seconds. */
const real = (s: string, t0 = 0): CleanupWordIn[] =>
	s
		.trim()
		.split(/\s+/)
		.map((x) => {
			const m = /^(.*)\[([\d.]+)-([\d.]+)\](?:@([\d.]+))?$/.exec(x)!;
			return {
				text: m[1]!,
				start: S(Number(m[2]) + t0),
				end: S(Number(m[3]) + t0),
				confidence: m[4] === undefined ? 1 : Number(m[4]),
			};
		});

/** The cut's measured levels (`results.json` step3_cleanUp.Cut.levels). */
const CUT = { floorDb: -31.6, speechDb: -10.5, speechThresholdDb: -38.5 };

type Flagged = { text: string; db: number; share: number };

/**
 * A voice analysis with the given levels: every word speech at −12 dBFS, the floor between words; a flagged word's
 * frames at its measured loudest level and speech only over its measured share (from its start), the rest silence-class.
 */
function voiceOf(
	words: readonly CleanupWordIn[],
	lv: typeof CUT,
	flagged: ReadonlyMap<number, Flagged>,
): CleanupVoice {
	const n = Math.ceil((Math.max(...words.map((w) => sec(w.end))) + 2) * 100);
	const q = (db: number) => Math.round((db + 120) * 2);
	const classes = new Uint8Array(n);
	const level = new Uint8Array(n).fill(q(lv.floorDb));
	words.forEach((w, i) => {
		const a = Math.trunc(sec(w.start) * 100);
		const b = Math.max(a + 1, Math.ceil(sec(w.end) * 100));
		const f = flagged.get(i);
		const speech = f ? Math.round(f.share * (b - a)) : b - a;
		for (let k = a; k < b; k++) {
			level[k] = q(f ? f.db : -12);
			classes[k] = k - a < speech ? 2 : 0;
		}
	});
	return { classes, level, frameCount: n, levels: { ...lv, breathFloorDb: lv.floorDb + 5 } };
}

const detect = (
	words: CleanupWordIn[],
	voice: CleanupVoice | null,
	script: string | null,
	rules: CleanupOverrides['rules'] = {},
) =>
	detectCleanup({
		mediaId: 'med_mix',
		words,
		voice,
		script,
		language: 'es',
		settings: mergeCleanupSettings(FAST_SETTINGS, { rules }),
	});

const removes = (d: ReturnType<typeof detect>, i: number) =>
	d.findings.some((f) => f.words && f.suggested === 'remove' && f.words[0] <= i && i <= f.words[1]);
const flaggedAs = (d: ReturnType<typeof detect>, i: number) =>
	d.findings.find((f) => f.kind === 'hallucination' && f.words && f.words[0] <= i && i <= f.words[1]);

describe('hallucinations on a dense, loudness-normalised mixdown (cut_v5.wav)', () => {
	// three of the 37: "tarjeta" (−14.7 dBFS, 12 % speech frames), "lo arreglen." (−22.0 dBFS, 14 %) and "que"
	// (−27.7 dBFS, none), each removed as a hallucination (cut_hallucinations_new.json); script lines 22–24, 65–67,
	// 172–174
	const script = [
		'Así que usé Sokol, una librería que hizo un alemán llamado Andre Weissflog, que es básicamente un traductor universal para tarjetas gráficas.',
		'Le dices "dibuja estos triángulos", y Sokol se lo dice a cada tarjeta gráfica en su idioma.',
		'Y así dibujé mi primer…',
		'Porque Unity no te deja tocar su código por dentro.',
		'Así que lo único que puedes hacer es reportar el bug, cruzar los dedos, y esperar a que ellos lo arreglen.',
		'Con mi propio engine puedo arreglar estas cosas yo mismo, puedo hacer que los juegos corran más rápido y más optimizados, y puedo agregarle cosas que en Unity no se podría.',
		'Mis juegos, corriendo sin Unity, con un motor propio, en mi celular.',
		'Es una locura lo que he logrado…',
		'Pero hay un pequeño detalle.',
	].join('\n');
	const cases: Array<{ words: string; flagged: Flagged[] }> = [
		{
			words: `dibujas[132.04-132.36]@0.782 tus[132.43-132.49]@0.987 triángulos[132.57-133.00]@0.996
				y[133.00-133.21]@0.264 Sokol[133.24-133.54]@0.885 se[133.54-133.68]@0.999 lo[133.68-133.78]@0.992
				dice[133.78-134.02] a[134.02-134.17]@0.885 cada[134.27-134.36]@0.997 tarjeta[134.44-134.74]@0.999
				gráfica[134.74-135.16] en[135.16-135.30]@0.997 su[135.30-135.42] idioma.[135.42-135.73] Y[135.79-135.86]
				así[135.86-136.02] dibujé[136.02-136.48] mi[136.48-136.68] primer[136.68-137.12] triángulo[137.12-137.70]`,
			flagged: [{ text: 'tarjeta', db: -14.7, share: 0.12 }],
		},
		{
			words: `hacer[321.58-321.78] es[321.78-321.99] reportar[322.03-322.52] el[322.52-322.64]
				bug,[322.64-322.86]@0.998 cruzar[323.18-323.24]@0.997 los[323.24-323.38] dedos[323.44-323.58]
				y[323.58-323.68]@0.996 esperar[323.68-323.96]@0.999 que[323.96-324.16]@0.586 ellos[324.16-324.35]
				lo[324.42-324.48]@0.995 arreglen.[324.57-324.63]@0.988 Con[324.73-324.80]@0.979 mi[324.80-324.92]
				propio[324.98-325.18]@0.999 engine[325.18-325.50]@0.915 puedo[325.50-325.82]@0.934
				arreglar[325.82-326.08] estas[326.08-326.24] cosas[326.38-326.52] yo[326.52-326.68] mismo.[326.68-327.00]`,
			flagged: [
				{ text: 'lo', db: -22, share: 0.14 },
				{ text: 'arreglen.', db: -22, share: 0.14 },
			],
		},
		{
			words: `motor[862.14-862.46]@0.999 propio[862.46-862.90] en[862.90-863.18] mi[863.18-863.34]
				celular.[863.34-863.80] Es[863.88-864.02]@0.986 una[864.02-864.18] locura[864.18-864.52] lo[864.52-864.66]
				que[864.66-864.76] he[864.76-864.84] logrado.[864.84-865.12] Pero[865.16-865.28] hay[865.28-865.42]
				un[865.42-865.56] pequeño[865.64-865.90] detalle.[865.90-866.32]`,
			flagged: [{ text: 'que', db: -27.7, share: 0 }],
		},
	];
	/** The case's words, with the flagged words' confidence and level replaced when given. */
	const build = (c: (typeof cases)[number], o: { confidence?: number; db?: number } = {}) => {
		const words = real(c.words);
		const at = new Map<number, Flagged>();
		for (const f of c.flagged) {
			const i = words.findIndex((w, k) => w.text === f.text && !at.has(k));
			at.set(i, { ...f, db: o.db ?? f.db });
			if (o.confidence !== undefined) words[i]!.confidence = o.confidence;
		}
		return { words, at };
	};

	it('a recovered script word the recogniser is sure of, said near the speech level, is no hallucination', () => {
		for (const c of cases) {
			// as reported (script, confidence and level), and with each of the three alone (−40 dBFS: over the floor's
			// silence, 29.5 dB under the speech level; confidence 0.3)
			for (const [name, withScript, o] of [
				['as reported', true, {}],
				['script only', true, { confidence: 0.3, db: -40 }],
				['confidence only', false, { db: -40 }],
				['level only', false, { confidence: 0.3 }],
			] as const) {
				const { words, at } = build(c, o);
				const d = detect(words, voiceOf(words, CUT, at), withScript ? script : null, { headTail: 'off' });
				for (const i of at.keys()) {
					expect(removes(d, i), `${name}: "${words[i]!.text}" removed`).toBe(false);
					expect(flaggedAs(d, i), `${name}: "${words[i]!.text}" flagged`).toBeUndefined();
				}
			}
		}
		// none of them: a word written over silence is still removed
		const { words, at } = build(cases[0]!, { confidence: 0.3, db: -40 });
		const d = detect(words, voiceOf(words, CUT, at), null);
		expect(flaggedAs(d, [...at.keys()][0]!)?.suggested).toBe('remove');
	});

	it('a quiet unsure word over sound without non-speech evidence is only reviewed', () => {
		// raw-recording levels (AG's: floor −51 dB, speech −5.5 dBFS): "tarjeta" unsure (0.3) at −33 dBFS — 21 dB under
		// the words around it, above the floor's silence, 12 % speech frames — is no proof of an invented word
		const { words, at } = build(cases[0]!, { confidence: 0.3, db: -33 });
		const lv = { floorDb: -51, speechDb: -5.5, speechThresholdDb: -37.35 };
		const d = detect(words, voiceOf(words, lv, at), null);
		const i = [...at.keys()][0]!;
		expect(flaggedAs(d, i)?.suggested).toBe('review');
		expect(removes(d, i)).toBe(false);
	});
});

describe('head and tail anchored on the script alignment (cut_v5.wav)', () => {
	// the cut's first 43 s: script lines 1–5 said without a pause of 0.6 s, so no unit says one line; then line 174
	const opening = `Hoy[0.01-0.32]@0.74 voy[0.32-0.50]@0.961 a[0.50-0.60]@0.999 ser[0.60-0.78]@0.485 mi[0.78-0.98]@0.997
		propio[1.00-1.22]@0.992 Unity.[1.32-1.75]@0.993 Tengo[1.92-2.12] solo[2.12-2.36]@0.924 30[2.36-2.65]@0.997
		días[2.72-3.02]@0.998 para[3.02-3.28] ser[3.28-3.46]@0.816 un[3.46-3.57] motor[3.62-3.86] de[3.86-4.02]
		videojuegos[4.02-4.37] entero,[4.45-4.89]@0.999 con[5.08-5.17]@0.999 físicas,[5.31-5.84]@0.997
		gráficos[5.92-6.48] y[6.48-6.62]@0.946 todas[6.62-6.78] las[6.78-6.92] cosas[6.92-7.12] que[7.12-7.26]
		necesita[7.26-7.62]@0.974 cualquier[7.62-7.83] juego.[7.94-8.39] Y[8.42-8.50] mi[8.50-8.62] motor[8.62-8.88]
		tiene[8.88-9.20] que[9.20-9.40] verse[9.40-9.70]@0.999 y[9.70-9.91] funcionar[9.92-10.36]@0.999
		igualito[10.36-10.76] a[10.90-11.00] Unity,[11.00-11.33] porque[11.46-11.68] llevo[11.68-11.96]@0.984
		toda[11.96-12.14]@0.974 mi[12.14-12.30] vida[12.30-12.46]@0.999 usando[12.46-12.72]@0.999
		Unity[12.72-13.05]@0.965 y[13.10-13.22]@0.998 me[13.22-13.28] da[13.28-13.38] muchísima[13.38-13.88]@0.998
		paja[13.96-14.08]@0.999 acostumarme[14.10-14.58]@0.986 a[14.58-14.66]@0.999 otra[14.68-14.74]@0.999
		cosa.[14.74-15.07] Ya[15.25-15.32] me[15.32-15.42] pasó[15.42-15.66]@0.987 con[15.66-15.88]
		Godot[15.88-16.22]@0.819 Unreal[16.22-16.46]@0.46 que[16.46-16.71]@0.987 usarlos[16.72-17.02]@0.979
		fue[17.02-17.22] un[17.22-17.32]@0.999 infierno.[17.32-17.86] Al[17.97-18.07] final[18.14-18.28]
		del[18.28-18.48] mes[18.48-18.70] debo[18.70-18.98]@0.977 portear[19.05-19.38]@0.938 todos[19.38-19.66]
		los[19.66-19.82] juegos[19.82-20.02] de[20.02-20.16] la[20.16-20.24]@0.991 Jasper[20.25-20.50]@0.992
		de[20.50-20.62]@0.909 Barcade[20.62-21.06]@0.864 y[21.06-21.28]@0.947 deben[21.28-21.48]@0.996
		funcionar[21.48-21.93] perfectamente[22.02-22.72] mi[22.72-22.86]@0.926 motor[22.86-23.16]@0.999
		y[23.16-23.38] correr[23.48-23.68] en[23.68-23.87] todas[23.94-24.02] las[24.02-24.14]
		plataformas[24.25-24.79] para[24.91-25.02]@0.998 poder[25.02-25.28] subirlos[25.28-25.80]@0.997 a[25.80-25.94]
		la[25.94-26.04] Play[26.04-26.24]@0.992 Store[26.24-26.42]@0.979 y[26.42-26.60]@0.999 App[26.60-26.70]@0.996
		Store.[26.87-26.98] Y[27.06-27.12]@0.849 si[27.39-27.56]@0.997 alguno[27.56-27.88] de[27.90-27.96]
		ellos[27.96-28.18] no[28.18-28.36]@0.992 funciona,[28.36-28.88]@0.999 debo[28.88-29.20]@0.981
		volver[29.20-29.38]@0.997 a[29.38-29.48]@0.998 Unity[29.48-29.69]@0.997 con[29.71-29.94]@0.978 la[29.94-30.06]
		cola[30.16-30.30] entre[30.30-30.48]@0.999 las[30.48-30.60] patas.[30.74-30.96] Y[31.00-31.08]@0.999
		antes[31.08-31.22] de[31.22-31.35] que[31.38-31.44] me[31.44-31.56] digan,[31.56-31.96]
		¡Pero[31.99-32.12]@0.668 Jasper,[32.12-32.60]@0.931 eso[32.60-32.80]@0.994 es[32.80-32.90]
		imposible![32.90-33.54] ¡Hacer[33.54-33.74]@0.992 un[33.74-33.83] motor[33.84-34.04]@0.995 de[34.04-34.18]
		videojuegos[34.18-34.60]@0.999 tarda[34.60-34.88]@0.997 años![34.88-35.29]@0.928 Déjenme[35.37-35.68]@0.994
		decirles[35.68-36.14] que[36.14-36.28] tienen[36.28-36.54] toda[36.54-36.80]@0.999 la[36.80-36.96]
		razón.[36.96-37.32] Pero[37.37-37.48] es[37.48-37.58] que[37.58-37.68] tengo[37.68-37.88] un[37.88-38.00]
		amigo[38.00-38.26] que[38.26-38.46] no[38.46-38.66] come,[38.80-39.26]@0.999 no[39.26-39.36]
		descansa,[39.36-40.02]@0.999 ni[40.02-40.24]@0.998 duerme,[40.24-40.66]@0.999 y[40.66-40.84]@0.999
		es...[40.84-41.04] y[41.04-41.16]@0.626 es[41.16-41.34]@0.999 extremadamente[41.34-42.22]@0.992
		rápido.[42.22-42.82]@0.995
		Pero[45.00-45.12] hay[45.12-45.26] un[45.26-45.40] pequeño[45.48-45.74] detalle.[45.74-46.16]`;
	const script = [
		'HOY voy a hacer mi propio Unity.',
		'Tengo solo 30 días para hacer un motor de videojuegos entero, con físicas, gráficos y todas las cosas que necesita cualquier juego, y mi motor tiene que verse y funcionar igualito a Unity, porque llevo toda mi vida usando Unity y me da muchísima paja acostumbrarme a otra cosa, ya me pasó con Godot o Unreal que usarlos fue un infierno.',
		'Al final del mes debo portear TODOS los juegos de la JasperDev Arcade, y deben funcionar perfectamente en mi motor y correr en todas las plataformas para poder subirlos a la Playstore y Appstore!',
		'Y si alguno de ellos no funciona, debo volver a Unity con la cola entre las patas.',
		'Y antes de que me digan "pero Jasper, eso es imposible, hacer un motor de videojuegos tarda años", déjenme decirles que tienen toda la razón, pero es que tengo un amigo, que no come, no descansa ni duerme, y es extremadamente rápido.',
		'Pero hay un pequeño detalle.',
	].join('\n');
	/** Talk before the first line: `n` two-word remarks, 2 s apart, from 0 s (too short for the off-script rule). */
	const remarks = (n: number): CleanupWordIn[] =>
		[
			'grabando ahora',
			'luz lista',
			'cámara puesta',
			'micro encendido',
			'nueva toma',
			'silencio total',
			'foco listo',
			'batería cargada',
			'trípode firme',
			'fondo limpio',
		]
			.slice(0, n)
			.flatMap((r, k) =>
				r.split(' ').map((text, j) => ({
					text,
					start: S(k * 2.55 + j * 0.3),
					end: S(k * 2.55 + j * 0.3 + 0.25),
					confidence: 0.95,
				})),
			);
	const headTail = (d: ReturnType<typeof detect>) => d.findings.filter((f) => f.kind === 'head-tail');

	it('scripted speech in a span with no unit saying one line is neither head nor tail', () => {
		const d = detect(real(opening), null, script);
		expect(headTail(d).map((f) => [sec(f.range.start), sec(f.range.end), f.reason.params.text])).toEqual([]);
	});

	it('talk before the first line is head; a long head is only reviewed', () => {
		// 3 s of talk before 46 s of script goes; 25 s (a third of the clip) is proposed
		for (const [n, suggested] of [
			[2, 'remove'],
			[10, 'review'],
		] as const) {
			const pre = remarks(n);
			const words = [...pre, ...real(opening, sec(pre[pre.length - 1]!.end) + 2)];
			const f = headTail(detect(words, null, script));
			expect(f.map((x) => [x.words, x.suggested])).toEqual([[[0, pre.length - 1], suggested]]);
		}
	});
});
