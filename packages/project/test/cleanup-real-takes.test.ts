// Clean Up on real transcripts (docs/wp-notes/transcript-cleanup.md "Real-take corpus"): whisper-large-v3-turbo
// transcripts of ~80 s fragments of the reporter's 57-minute Spanish talking-head recording, as the hidden-retake
// test wrote them in its runs 2–6 (re-decode on, `chunking: "vad"`, re-decode off; run 5 adds G–L, run 6 M–T;
// `fixtures/cleanup-real-takes.json`, text and times only, plus the speech without words the reporter measured). The
// spec is what the speaker meant, written by hand per fragment: the edit keeps the last complete clean take of every
// sentence once, removes every earlier attempt, restart and aside, never plays a sentence twice, never loses what only
// one take says, and no cut starts or ends inside a word. And for every case: whatever is removed, head and tail
// included, lies inside a finding that removes, rejecting every finding or setting every rule to review removes
// nothing, and a take marked kept loses no word. The cut is the sequence's (`analyzeSequenceCleanup`, Fast preset)
// with a voice analysis that has speech under every word and where the reporter measured it.
//
// Split: the repeat mechanism (`repeats.ts`) was developed against the dev fragments (A–F, M, N, O, Q) and evaluated
// on the held-out ones (G–L, P, R, S, T) only at the end; round 8 held out run 7 (U–AB, `held-out-r7`), round 10 run 9
// (AC–AH, `held-out-r9`); round 11 adds run 11 (AI–AN, `held-out-r11`), mainly regression coverage: its bug reports
// were read first and the recording has no unused gaps left for a blind split.
// `CLEANUP_CORPUS=dev|held-out|held-out-r7|held-out-r9|held-out-r11` runs one split's spec cases.
// The last test measures precision and recall of the removals against each case's `dup` reference, per finding kind
// and per split (`CLEANUP_CORPUS_REPORT=<file>` writes the table). A word removed in a case's `debatable` span counts
// as wrong; the precision excluding those is reported for information only, never asserted. A word removed in an
// `alt` span (run 11's references: removal right but not required) counts as right and is not required for recall.
import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { CleanupVoice } from '../src/cleanup/detector.ts';
import { builtinLists, cleanupNorm, sameWord } from '../src/cleanup/lists.ts';
import type { CleanupFinding } from '../src/cleanup/schema.ts';
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
	/** Media time a correct edit removes as repeats, asides and hallucinations (seconds; fillers and pauses aside). */
	dup: Array<[number, number]>;
	/** Media time the judgements call editorially debatable: removing it counts as wrong; reported apart for information. */
	debatable?: Array<[number, number]>;
	/** Media time whose removal is right but not required (run 11's references). */
	alt?: Array<[number, number]>;
	/** The run's measured voice-analysis levels (dBFS): the corpus voice uses them instead of its defaults. */
	levels?: { floorDb: number; speechDb: number; speechThresholdDb: number };
	/** Measured speech quieter than the words around it: [start, end, dBFS] (an off-mic aside, a mumbled attempt). */
	quiet?: Array<[number, number, number]>;
};

/** Fragments held out while the repeat mechanism was developed (round 6)… */
const HELD_OUT = new Set(['G', 'H', 'I', 'J', 'K', 'L', 'P', 'R', 'S', 'T']);
/** … and while round 8 was developed (run 7; its bug reports were read before, its spec cases evaluated at the end). */
const HELD_OUT_R7 = new Set(['U', 'V', 'W', 'X', 'Y', 'Z', 'AA', 'AB']);
/** … and while round 10 was developed (run 9; written from its judgements before the development). */
const HELD_OUT_R9 = new Set(['AC', 'AD', 'AE', 'AF', 'AG', 'AH']);
/** … and round 11 (run 11): regression coverage written from its judgements before the evaluation; not blind. */
const HELD_OUT_R11 = new Set(['AI', 'AJ', 'AK', 'AL', 'AM', 'AN']);
const splitOf = (c: Case) =>
	HELD_OUT_R11.has(c.fragment)
		? 'held-out-r11'
		: HELD_OUT_R9.has(c.fragment)
			? 'held-out-r9'
			: HELD_OUT_R7.has(c.fragment)
				? 'held-out-r7'
				: HELD_OUT.has(c.fragment)
					? 'held-out'
					: 'dev';
/**
 * Spec cases that fail for a documented limit (docs/wp-notes/transcript-cleanup.md "Round 10"): registered as expected
 * failures, so a fix shows up as a failing test to promote.
 */
const KNOWN_FAILURES: Record<string, string> = {
	// H6: "Se llama Cloud Code. No, …" is not linked to "Se llama Cloud Decode." 17 s later: the pronunciation aside
	// between them (25 words, 15 s) is beyond rule 4's limits (the chunked transcript passes only because it writes the
	// name as one word, "Cloudecode")
	'AG-r9a': 'the first take of the name is not linked across the pronunciation aside',
};
const SPLIT = process.env.CLEANUP_CORPUS;
const inSplit = (c: Case) => !SPLIT || splitOf(c) === SPLIT;

const corpus = JSON.parse(
	readFileSync(new URL('./fixtures/cleanup-real-takes.json', import.meta.url), 'utf8'),
) as { cases: Case[] };

/** Per fragment: phrases the edit says exactly once, phrases it never says (normalised words, ASR variants match). */
const SPEC: Record<
	string,
	{
		once: string[];
		never: string[];
		allKept?: boolean;
		gone?: Array<[number, number]>;
		/** Spans whose words are all heard or all removed (an aside kept or cut whole, never chopped). */
		together?: Array<[number, number]>;
	}
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
	// run 6 (written from its listening judgements)
	M: {
		once: [
			'cualquier juego',
			'funcionar igualito a unity',
			'porque llevo toda mi vida',
			'acostumbrarme a otra cosa',
			'me paso con godot',
			'un infierno',
		],
		// the four earlier takes and the aside between the last two; the false start "Ya. | Ya me pasó"
		never: ['a porque', 'otra porque', 'puta madre', 'ya ya'],
	},
	N: {
		once: [
			'physics para los juegos en 3d',
			'muchisimos juegos de godot',
			'death stranding 2',
			'hideo kojima',
			'de la misma forma',
			'sistema de sonido',
			'encontrar el camino',
			'usa cualquier juego',
		],
		// the first take of the sentence and the aside before the second (round 6 kept both: the sentence played twice)
		never: ['espera', 'sin aire', 'que saben'],
	},
	O: {
		once: [
			'el tema oscuro de unity',
			'la barra de menus de unity',
			'absolutamente todo',
			'en el mismo lugar que en unity',
			'una plantilla 2d o 3d',
			'la imagen por defecto de la plantilla 2d',
			'naranja sobre un fondo azul',
			'hagamos una comparacion',
		],
		// the abandoned attempts; round 6 cut "o 3D" of the finished sentence instead
		never: ['imagen de la plantilla', 'imagen por y'],
	},
	P: {
		once: [
			'suscribete que no cuesta absolutamente nada',
			// a deliberate repetition, said once in the edit (round 6 cut one "Guiño")
			'guino guino',
			'no viene por defecto',
			'unity 0',
			'ronda 4',
			'dentro de unity animar',
			'pose por pose',
			'keyframe por keyframe',
			'muy tieso',
		],
		never: [],
	},
	Q: {
		once: [
			'esto es increible',
			'simulacion de fluidos',
			'pintar con el mouse',
			'se llama literalmente psicodelico',
			'les juro que me quede como 20 minutos',
			'en vez de seguir haciendo este video',
			'tambien tiene un boton que agarra',
			'como si fuera 3d',
			'texturas infinitas',
			'foto chiquita',
			'reboten como gelatina',
			'cae al piso',
			'boing boing boing',
		],
		// the restart "… jugando con esto en lugar…" (round 6 kept it: the clause played twice)
		never: ['en lugar', 'cae al en', 'cae en el'],
	},
	R: {
		once: [
			'tuve que reescribirlo entero',
			'no lo reescribi yo',
			'lo reescribi a mis agentes',
			'linea por linea',
			'200 archivos',
			'33 mil lineas',
			'fueron rehechos en html',
			'la parte mas loca',
			'en menos de un dia',
			'hasta me sobro tiempo para agregar 3 juegos',
			'queria meter a la',
			'monster truck hunter',
			'de hecho fue mi primer juego',
			'solo existia chatgpt',
		],
		// the abandoned takes ("tres" / "3" are one number; "hechos" / "rehechos" match as ASR variants, so the
		// abandoned "fueron hechos en HTML" is checked by "fueron rehechos en html" said once)
		never: ['tiempo para y', 'mi primer que'],
	},
	// controls without takes: every word stays (round 6: "¡En mis juegos!" in T was cut as a take of a later sentence)
	S: { once: [], never: [], allKept: true },
	T: { once: [], never: [], allKept: true },
	// held out in round 8 (run 7): written from that run's listening judgements before the evaluation
	U: {
		once: [
			'oh shit',
			'hola hola',
			'hoy voy a ser mi propio',
			'tengo solo 30 dias para hacer un',
			'para hacer un motor de videojuegos entero',
			'con fisicas graficos',
			'todas las cosas que se necesitan',
		],
		// the asides inside the run of attempts and what the recogniser inserted into them
		never: ['espera', 'suscribete', 'canal', 'un video'],
	},
	V: {
		once: [
			'el motor es esa cocina',
			'es lo que dibuja',
			'cuando tocas un boton',
			'muy complejo de hacer',
			'si buscas en internet',
			'deberia ser mi propio motor',
			'de las respuestas son',
			'definitivamente no lo hagas',
			'como todos los demas',
		],
		never: [],
	},
	W: {
		once: [
			'mitad del video',
			'se lo que',
			'por que carajo hiciste eso',
			'te va muy bien',
			'si es cierto',
			'es cierto pero tengo mis razones',
			'literalmente todos los hice en unity',
			'dependo completamente de',
			'la play store',
			'que aparece un bug',
			'buscando el problema',
			'el error no es mio',
		],
		// the corrected first take and the correction aside
		never: ['completamente de unity', 'no tengo que repetir'],
	},
	X: {
		once: [
			'con unos 30 libros',
			'30 veces manualmente',
			'una tortura',
			'seleccionas los 30 libros',
			'mantienes apretado el espacio',
			'ronda 2',
			'objetos a la vez',
			'monedas girando',
			'lluvia de meteoritos',
		],
		// the joke aside between the takes
		never: ['ya no soy argentino', 'porque lo puse'],
	},
	Y: {
		once: [
			'cada intento de arreglar un bug',
			'me costaba dos horas',
			'si no arreglaba todo en dos dias',
			'perderia el reto del video',
			'tenia que coordinar',
			'a trabajar toda la noche',
			'uno por cada bug',
			'a la manana siguiente',
			'20 minutos',
			'estaban arreglados',
			'todos los que habia encontrado',
		],
		never: ['uno por uno'],
	},
	Z: {
		once: [
			'la base del motor',
			'me falta el logo',
			'no puede ser que justo haciendo este video',
			'una letra j blanca',
			'cuadrado rojo',
			'hay que reemplazarlo',
			'un mes entero',
			'logo temporal',
			'voy a pensar en un logo mejor',
			'completamente gratis',
			'suscribete',
		],
		// the first take ("literalmente es" became "es literalmente")
		never: ['literalmente es una'],
	},
	AA: { once: [], never: [], allKept: true },
	AB: { once: [], never: [], allKept: true },
	// held out in round 10 (run 9): written from that run's listening judgements before the development
	AC: {
		once: [
			'gracias por avisar hermano',
			'muy amable de tu parte',
			'despues de casi explotar',
			'hubo uno en el que',
			'el segundo se crasheaba',
			'hubo otro',
			'en una ventana para editar animaciones',
			'borrar un puntito',
			'te borraba el objeto entero',
			'lo peor es que el motor',
			'dos horas en compilar',
		],
		// the abandoned first take, the abandoned attempts of "Hubo otro…" and the cut-off "el tor-"
		never: ['haber casi', 'que una ventana', 'el tor'],
	},
	AD: {
		once: [
			'mi primer triangulo blanco',
			'wow increible',
			'de que me sirve un triangulo blanco',
			'asi que le puse shaders',
			'la receta que decide',
			'cada pixel',
			// the end of the sentence the next one (15 s later) opens with (run 9 cut "las sombras." as a false start)
			'se renderizan las luces y las sombras',
			'las sombras funcionan dibujando',
			'esta en la sombra',
		],
		// the earlier complete take (b's "pasa?" over noise is not measurable on the corpus voice)
		never: ['pixel luces'],
	},
	AE: {
		once: [
			'en unity por defecto',
			'se anima con un esqueleto',
			'el procesador tiene que calcular donde esta cada hueso',
			'en cada frame del juego',
			'con uno o diez personajes',
			'500 personas',
			'un millon y medio de huesos',
			'el pobre procesador',
			'vertex animations',
			'antes de que empiece el juego',
		],
		// the take with the word the correction replaces, and the correction
		never: ['cada imagen', 'no imagen'],
	},
	AF: {
		once: [
			'como programo mis juegos',
			'esta hecho en c',
			'lo odio',
			'me muero de viejo',
			'se programan en lua',
			'se usa en roblox',
			'ya se que roblox usa',
			'no me lo pongan en los comentarios',
		],
		never: [],
	},
	AG: {
		once: [
			'tengo un amigo que no come',
			'es extremadamente rapido',
			'llama cloud',
			'que todo esto fuera posible',
			'un ejercito de',
			'a las 4 de la manana',
			'casi me hacen explotar la computadora',
			'ya llegaremos a eso',
		],
		// the restart "(Y) es… Espera. | es extremadamente rápido" (the pronunciation aside is debatable: not asserted)
		never: ['espera', 'es es', 'y es'],
	},
	AH: { once: [], never: [], allKept: true },
	// round 11 (run 11): written from that run's judgements before the evaluation
	AI: {
		once: [
			'tienes que escribir un shader',
			'encima tienes que hacer que se vea bien',
			'tablets y pantallas ultra wide que miden dos metros',
		],
		never: [],
	},
	AJ: {
		once: [
			'como interfaz del juego',
			'asi que el boton con bordes redondeados degradado brillito y sombra',
			'cuatro lineas de codigo',
		],
		// the first take; the off-mic aside "Sí. (Son) las 3 y que..." is debatable — kept or removed, never chopped
		never: ['degradado y brillito'],
		together: [[21.0, 26.0]],
	},
	AK: {
		once: [
			'pero hay un pequeno detalle',
			// an ASR doubling over one spoken "megas": kept, no repeat
			'mb megas',
			'asi que tecnicamente si lo he cumplido',
			'no vuelvo a unity',
			'para que ustedes la puedan descargar',
		],
		never: [],
	},
	AL: { once: [], never: [], allKept: true },
	AM: {
		once: [
			'una ventana negra',
			'negra como mi alma',
			'toca dibujar las cosas',
			'aqui nos encontramos con un problema enorme',
		],
		// the mumbled broken-off attempt (default mode writes it "y aquí no sé", chunked "y aquí nos")
		never: ['aqui no se aqui', 'nos y aqui nos'],
	},
	// no repeat: the whispered noise word ("¡Draw it!" / "Droid.") may go
	AN: { once: ['box2d para los juegos 2d', 'la fisica que usaba el angry birds'], never: [] },
};

const FPS = 30;
/** Kinds that remove words because the speech after them says them again. */
const REPEATS = new Set(['restart', 'false-start', 'retake', 'hidden-retake', 'stutter']);
/** A word that ends a sentence: ". ? !" — not the recogniser's "…", which marks a word broken off. */
const endsSentence = (text: string) =>
	/[.?!]["'»”’)]*$/u.test(text.trim()) && !/(\.\.\.|…)[?!]?$/.test(text.trim());

/**
 * Review findings of take chains' asides: repeat findings for review right after a removed one, in a row (the attempt
 * before them goes, the aside says new words — round 10's default).
 */
function asideReviews(a: { findings: ReadonlyArray<CleanupFinding> }) {
	const take = (f: CleanupFinding) => !!f.words && REPEATS.has(f.kind);
	const ends = new Set(a.findings.filter((f) => take(f) && f.suggested === 'remove').map((f) => f.words![1]));
	const out: CleanupFinding[] = [];
	// in word order: a review right after a removed take, or right after another such review (an aside in pieces)
	for (const f of [...a.findings].filter(take).sort((x, y) => x.words![0] - y.words![0]))
		if (f.suggested === 'review' && ends.has(f.words![0] - 1)) {
			out.push(f);
			ends.add(f.words![1]);
		}
	return out;
}

/** The case's cut: removed and kept ranges (seconds), the words heard, the analysis. */
function cut(c: Case, decisions?: CleanupDecisions, settings: CleanupSettings = FAST_SETTINGS) {
	const end = Math.max(...c.words.map((w) => w[2])) + 2;
	const n = Math.ceil(end * 100);
	// the run's measured levels when the case has them (words 6 dB under the speech level), else the defaults
	const floorDb = c.levels?.floorDb ?? -64;
	const wordDb = c.levels ? c.levels.speechDb - 6 : -20;
	const q = (db: number) => Math.round((120 + db) * 2);
	const classes = new Uint8Array(n);
	const level = new Uint8Array(n).fill(q(floorDb));
	const speech = (a: number, b: number, on: boolean) => {
		for (let f = Math.floor(a * 100); f < Math.min(n, Math.ceil(b * 100)); f++) {
			classes[f] = on ? 2 : 0;
			level[f] = q(on ? wordDb : floorDb);
		}
	};
	for (const [, s, e] of c.words) speech(s, e, true);
	for (const [a, b] of c.voiced ?? []) speech(a, b, true);
	for (const [a, b] of c.unvoiced ?? []) speech(a, b, false);
	for (const [a, b, db] of c.quiet ?? [])
		for (let f = Math.floor(a * 100); f < Math.min(n, Math.ceil(b * 100)); f++)
			if (classes[f] === 2) level[f] = q(db);
	const voice: CleanupVoice = {
		classes,
		level,
		frameCount: n,
		levels: c.levels
			? { ...c.levels, breathFloorDb: c.levels.floorDb + 5 }
			: { floorDb: -64, speechDb: null, speechThresholdDb: null, breathFloorDb: null },
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
	for (const c of corpus.cases.filter(inSplit))
		(KNOWN_FAILURES[c.id] ? it.fails : it)(
			`${c.id}${splitOf(c) === 'dev' ? '' : ` (${splitOf(c)})`}: the last clean take of each sentence, once${KNOWN_FAILURES[c.id] ? ` (known limit: ${KNOWN_FAILURES[c.id]})` : ''}`,
			() => {
				const { a, kept, removed, heard } = cut(c);
				// every removed second, head and tail included, lies within a finding that removes — beyond its edges only
				// silence, and at most a frame of it (the frame grid)
				const removing = a.findings
					.filter((f) => f.suggested === 'remove')
					.map((f) => [sec(f.range.start), sec(f.range.end)] as const);
				const frame = 1 / FPS;
				const near = removing.map(([x, y]) => [x - frame - 1e-6, y + frame + 1e-6] as const);
				// at the start of a removal of words the cut takes the frame boundary at or before it, whatever that frame
				// holds: in continuous voice the grid cannot split two words, and the removed word goes whole
				const claims = a.findings
					.filter((f) => f.suggested === 'remove')
					.map((f) => [sec(f.range.start) - (f.words ? frame + 1e-6 : 0), sec(f.range.end)] as const);
				const voiced = [...c.words.map(([, s, e]) => [s, e] as const), ...(c.voiced ?? [])];
				for (const [x, y] of removed) {
					expect(
						outside(x, y, near),
						`${x.toFixed(3)}–${y.toFixed(3)} removed without a finding`,
					).toBeLessThan(1e-6);
					for (const [p, q] of voiced) {
						const [u, v] = [Math.max(x, p), Math.min(y, q)];
						if (v > u)
							expect(outside(u, v, claims), `voice ${p}–${q} removed beyond a finding`).toBeLessThan(1e-6);
					}
				}
				// no removal of a word's time unless a finding that removes that word is accepted — a pause never takes a
				// transcribed word (round 11: pauses took the quiet off-mic words "las", "3", "que...") — but where an accepted
				// removal of the next words starts: the frame at or before its start (continuous voice, the frame grid)
				c.words.forEach(([t, s, e], i) => {
					const own = a.findings
						.filter((f) => f.suggested === 'remove' && f.words && f.words[0] <= i && i <= f.words[1])
						.map((f) => [sec(f.range.start), sec(f.range.end)] as const);
					const next = a.findings
						.filter((f) => f.suggested === 'remove' && f.words && f.words[0] > i)
						.map((f) => [sec(f.range.start) - frame - 0.01, sec(f.range.end)] as const);
					for (const [x, y] of removed) {
						const [u, v] = [Math.max(x, s), Math.min(y, e)];
						if (v > u)
							expect(
								outside(u, v, [...own, ...next]),
								`"${t}" ${s}–${e} removed without its finding`,
							).toBeLessThan(1e-6);
					}
				});
				// a take marked kept loses no word to its own group (a restart inside it has its own finding)
				for (const g of a.groups) {
					const t = g.takes[g.chosen]!;
					const lost = c.words.filter(
						([, s, e], i) =>
							i >= t.words[0] &&
							i <= t.words[1] &&
							!kept.some(([x, y]) => (s + e) / 2 >= x && (s + e) / 2 < y) &&
							!a.findings.some((f) => f.group !== g.id && f.words && f.words[0] <= i && i <= f.words[1]),
					);
					expect(
						lost.map((w) => w[0]),
						`kept take ${g.id} removed in part`,
					).toEqual([]);
				}
				// a removed take never takes the end of a sentence the kept words before it began (the word before it a function
				// word, or said into it), unless the kept speech right after it (no silence over 5 s, other removals between) says
				// that sentence's last content word again
				const isKept = (i: number) =>
					kept.some(
						([x, y]) =>
							(c.words[i]![1] + c.words[i]![2]) / 2 >= x && (c.words[i]![1] + c.words[i]![2]) / 2 < y,
					);
				const stop = new Set(builtinLists('es').stopWords);
				for (const f of a.findings) {
					if (!f.words || f.suggested !== 'remove' || !REPEATS.has(f.kind)) continue;
					const [fa, fb] = f.words;
					let e = fa;
					while (e < fb && !endsSentence(c.words[e]![0])) e++;
					const p = fa - 1;
					if (!endsSentence(c.words[e]![0]) || p < 0 || !isKept(p)) continue;
					// "¡…" / "¿…" opens a sentence of its own: the one begun before ended unwritten
					if (c.words.slice(fa + 1, e + 1).some((w) => /^[¡¿]/.test(w[0].trim()))) continue;
					if (endsSentence(c.words[p]![0])) continue;
					// the kept words before it began the sentence: a function word, or a word said into it without a pause
					if (!stop.has(cleanupNorm(c.words[p]![0])) && c.words[fa]![1] - c.words[p]![2] >= 0.3) continue;
					let q = fb + 1;
					while (q < c.words.length && !isKept(q)) q++;
					const silences = c.words.slice(fb, q + 1).map((w, x, all) => (x ? w[1] - all[x - 1]![2] : 0));
					const last = c.words
						.slice(fa, e + 1)
						.map((w) => cleanupNorm(w[0]))
						.filter((x) => x && !stop.has(x) && x.length >= 3)
						.at(-1);
					const after = c.words
						.slice(q)
						.filter((_, x) => isKept(q + x))
						.slice(0, 40)
						.map((w) => cleanupNorm(w[0]));
					const said = `${f.reason.params.text}: ${c.words
						.slice(q, q + 8)
						.map((w) => w[0])
						.join(' ')}`;
					expect(
						Math.max(...silences),
						`sentence end taken, nothing said right after: ${said}`,
					).toBeLessThanOrEqual(5);
					if (last)
						expect(
							after.some((x) => sameWord(x, last)),
							`sentence end taken, not said again: ${said}`,
						).toBe(true);
				}
				// the edit the speaker meant, with the asides of take chains accepted: by default an aside that says new words
				// is its own review finding (round 10, precision first) — the phrases below check the edit once accepted
				const asides = asideReviews(a);
				const meant = asides.length ? cut(c, { accept: asides.map((f) => f.id) }) : { heard, removed };
				const toks = meant.heard.map((w) => cleanupNorm(w[0])).filter(Boolean);
				const text = meant.heard.map((w) => w[0]).join(' ');
				const spec = SPEC[c.fragment]!;
				if (spec.allKept) expect(text).toBe(c.words.map((w) => w[0]).join(' '));
				for (const p of spec.once) expect(count(toks, p), `"${p}" once in: ${text}`).toBe(1);
				for (const p of spec.never) expect(count(toks, p), `"${p}" never in: ${text}`).toBe(0);
				for (const [x, y] of spec.gone ?? [])
					expect(outside(x, y, meant.removed), `${x}–${y} kept`).toBeLessThan(1e-6);
				for (const [x, y] of spec.together ?? []) {
					const inside = c.words.filter(([, s, e]) => (s + e) / 2 >= x && (s + e) / 2 < y);
					const heardThere = inside.filter((w) => meant.heard.includes(w));
					expect(
						heardThere.length === 0 || heardThere.length === inside.length,
						`${x}–${y} chopped: heard ${heardThere.map((w) => w[0]).join(' ')} of ${inside.map((w) => w[0]).join(' ')}`,
					).toBe(true);
				}
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
			},
		);

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

	it('removals: precision per finding kind and recall of the repeats, dev and held out', () => {
		const es = builtinLists('es');
		const filler = new Set([...es.fillers, ...es.markers.filter((m) => !m.includes(' '))]);
		const fillerKinds = new Set(['filler-vocalic', 'filler-phrase', 'filler-lexical']);
		const frameKinds = new Set(['pause', 'breath', 'untranscribed']);
		type Tally = { right: number; wrong: number; wrongWords: string[] };
		const report: Record<
			string,
			{
				kinds: Record<string, Tally>;
				dup: number;
				hit: number;
				asides: number;
				missed: string[];
				debatable: string[];
			}
		> = {};
		for (const c of corpus.cases) {
			const split = splitOf(c);
			const r = (report[split] ??= { kinds: {}, dup: 0, hit: 0, asides: 0, missed: [], debatable: [] });
			const { a, kept } = cut(c);
			const gone = (s: number, e: number) => !kept.some(([x, y]) => (s + e) / 2 >= x && (s + e) / 2 < y);
			const asides = asideReviews(a);
			const proposed = (i: number) => asides.some((f) => f.words![0] <= i && i <= f.words![1]);
			const inDup = (s: number, e: number) => c.dup.some(([x, y]) => (s + e) / 2 >= x && (s + e) / 2 < y);
			const inAlt = (s: number, e: number) =>
				(c.alt ?? []).some(([x, y]) => (s + e) / 2 >= x && (s + e) / 2 < y);
			const debatable = (s: number, e: number) =>
				(c.debatable ?? []).some(([x, y]) => (s + e) / 2 >= x && (s + e) / 2 < y);
			for (const f of a.findings) {
				if (!f.words || f.suggested !== 'remove' || frameKinds.has(f.kind)) continue;
				const t = (r.kinds[f.kind] ??= { right: 0, wrong: 0, wrongWords: [] });
				for (let i = f.words[0]; i <= f.words[1]; i++) {
					const [text, s, e] = c.words[i]!;
					if (!gone(s, e)) continue;
					if (inDup(s, e) || inAlt(s, e) || (fillerKinds.has(f.kind) && filler.has(cleanupNorm(text))))
						t.right++;
					else {
						t.wrong++;
						t.wrongWords.push(`${c.id} ${s} ${text}`);
						if (debatable(s, e)) r.debatable.push(`${c.id} ${s} ${text}`);
					}
				}
			}
			c.words.forEach(([text, s, e], i) => {
				if (!inDup(s, e) || filler.has(cleanupNorm(text))) return;
				r.dup++;
				if (gone(s, e)) r.hit++;
				else if (proposed(i)) r.asides++;
				else r.missed.push(`${c.id} ${s} ${text}`);
			});
		}
		const lines: string[] = [];
		for (const [split, r] of Object.entries(report)) {
			let right = 0;
			let wrong = 0;
			for (const [kind, t] of Object.entries(r.kinds).sort()) {
				right += t.right;
				wrong += t.wrong;
				lines.push(
					`${split} ${kind}: precision ${(t.right / Math.max(1, t.right + t.wrong)).toFixed(3)} (${t.right} right, ${t.wrong} wrong)${t.wrong ? ` ${t.wrongWords.join('; ')}` : ''}`,
				);
			}
			lines.push(
				`${split} all word removals: precision ${(right / Math.max(1, right + wrong)).toFixed(3)} (${right} / ${right + wrong}); repeats recall ${(r.hit / Math.max(1, r.dup)).toFixed(3)} (${r.hit} / ${r.dup} words), with asides proposed for review ${((r.hit + r.asides) / Math.max(1, r.dup)).toFixed(3)} (missed: ${r.missed.join('; ')})`,
			);
			if (r.debatable.length)
				lines.push(
					`${split} information only (never the gate): ${r.debatable.length} of the wrong words lie in debatable spans; precision excluding them ${(right / Math.max(1, right + wrong - r.debatable.length)).toFixed(3)} (${r.debatable.join('; ')})`,
				);
		}
		if (process.env.CLEANUP_CORPUS_REPORT)
			writeFileSync(process.env.CLEANUP_CORPUS_REPORT, `${lines.join('\n')}\n`);
		// precision first: at most 1 % of the removed words wrong in either split; the repeats mostly found
		for (const [split, r] of Object.entries(report)) {
			let right = 0;
			let wrong = 0;
			for (const k of Object.values(r.kinds)) {
				right += k.right;
				wrong += k.wrong;
			}
			expect(right / Math.max(1, right + wrong), `${split}: ${lines.join('\n')}`).toBeGreaterThanOrEqual(
				0.99,
			);
			// the repeats mostly found: removed, or — asides of take chains that say new words, round 10 — proposed for review
			// (the default recall is reported above)
			expect((r.hit + r.asides) / Math.max(1, r.dup), `${split}: ${lines.join('\n')}`).toBeGreaterThanOrEqual(
				0.95,
			);
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
