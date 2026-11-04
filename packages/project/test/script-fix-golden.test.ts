// Golden cases of the script-correction model (spec 17 SC-101) on invented Spanish and English text: names, merges,
// joins, del, retakes, off-script chatter, directions, headings, "&", numbers, stylised spellings, mixed regions,
// glossary candidates, strictness presets and the Maybe band.
import { describe, expect, it } from 'vitest';
import {
	alignTranscript,
	buildScoreWindows,
	type CandidateScore,
	candidateScores,
	decideFix,
	delAnchorOf,
	type FixCandidate,
	type FixWord,
	findFixCandidates,
	type GlossaryEntryInput,
	type ParsedScript,
	parseScript,
	replaceWordsEdit,
	type ScoreWindowResult,
	scoreRequestWindows,
} from '../src/script-fix/index.ts';
import { FLICKS_PER_SECOND } from '../src/time.ts';

const F = FLICKS_PER_SECOND;

/** Transcript words 0.3 s long with `gap` s between them (default 0.05 s; `|` in the text = a 1.5 s pause). */
function say(text: string, gap = 0.05): FixWord[] {
	const out: FixWord[] = [];
	let t = 0.5;
	for (const w of text.split(/\s+/)) {
		if (w === '|') {
			t += 1.5;
			continue;
		}
		out.push({ text: w, start: Math.round(t * F), end: Math.round((t + 0.3) * F), confidence: 0.9 });
		t += 0.3 + gap;
	}
	return out;
}

function run(
	scriptText: string,
	transcript: string,
	lang = 'es',
	glossary?: GlossaryEntryInput[],
	gap?: number,
) {
	const script = parseScript(scriptText, { language: lang });
	const words = say(transcript, gap);
	const alignment = alignTranscript({
		words,
		script,
		language: lang,
		mediaId: 'media-1',
		transcriptId: 'tr-1',
	});
	if (!alignment.ok) throw new Error(alignment.message);
	const res = findFixCandidates({
		mediaId: 'media-1',
		transcriptId: 'tr-1',
		words,
		script,
		alignment,
		language: lang,
		glossary,
	});
	return { script, words, alignment, ...res };
}

const brief = (c: FixCandidate) => `${c.kind}:${c.category}:${c.asr.join(' ')}→${c.script.join(' ')}`;

describe('script parsing (SC-002)', () => {
	it('keeps lines, marks directions and headings, counts sections, reads "&"', () => {
		const s: ParsedScript = parseScript(
			'INTRO\nHola a todos (sonrisa a cámara) y bienvenidos.\n\nEscena dos:\nSunblob & Moonblob es un juego (mostrar\nla portada) de plataformas.\nVídeo largo\nFin.',
			{ language: 'es' },
		);
		expect(s.summary.sections.map((x) => x.heading)).toEqual([null, 'INTRO', 'Escena dos:', 'Vídeo largo']);
		expect(s.summary.headingLines).toBe(3);
		expect(s.summary.directions).toBe(2);
		expect(s.tokens.filter((t) => t.kind === 'paren').map((t) => t.norm)).toEqual([
			'sonrisa',
			'a',
			'camara',
			'mostrar',
			'la',
			'portada',
		]);
		const amp = s.tokens.find((t) => t.text === '&')!;
		expect(amp.norm).toBe('y');
		expect(amp.line).toBe(4);
		expect(amp.section).toBe(2);
		expect(parseScript('Salt & Pepper', { language: 'en' }).tokens[1]!.norm).toBe('and');
		// an unclosed parenthesis ends at the blank line
		const open = parseScript('Uno (dos tres\n\ncuatro cinco', { language: 'es' });
		expect(open.tokens.map((t) => t.kind)).toEqual(['word', 'paren', 'paren', 'word', 'word']);
	});

	it('finds proper nouns by mid-sentence capitals and brand-like spellings, not by sentence starts or all caps', () => {
		const s = parseScript(
			'Hoy abrimos Glimmerbox. Glimmerbox es genial. Esto es MUY importante. Lo vi en iOS.',
			{
				language: 'es',
			},
		);
		expect(s.properNorms).toEqual(['glimmerbox', 'ios']);
	});

	it('a name the script writes both ways is proper when capitalised mid-sentence in a third of its uses', () => {
		const s = parseScript(
			'Hoy llega Nova al juego. Con nova todo cambia. Ya ves, nova gana. Y luego Nova pierde. ' +
				'El mapa es enorme. Un mapa nuevo, otro mapa y el Mapa final. Miramos el mapa otra vez.',
			{ language: 'es' },
		);
		// nova: 2 capitalised mid-sentence, 2 lower case → proper; mapa: 1 capitalised, 4 lower case → not
		expect(s.properNorms).toEqual(['nova']);
	});
});

describe('alignment and candidates, Spanish (SC-010 … SC-026)', () => {
	it('names: a misheard name is a proper `sub` candidate; the report counts aligned words', () => {
		const r = run(
			'Hoy probamos el motor de Pixelforge con un nivel nuevo.',
			'hoy probamos el motor de pixelforch con un nivel nuevo',
		);
		expect(r.candidates.map(brief)).toEqual(['sub:proper:pixelforch→Pixelforge']);
		expect(r.alignment.report.exactTokens).toBe(9);
		expect(r.alignment.report.alignedShare).toBeCloseTo(0.9, 6);
		expect(r.alignment.report.unusedLines).toEqual([]);
	});

	it('merges: two ASR words for one script word (non-exact) is a `merge`', () => {
		const r = run(
			'Ahora abrimos Glimmerbox y creamos una escena vacía.',
			'ahora abrimos glimer vox y creamos una escena vacía',
		);
		expect(r.candidates.map(brief)).toEqual(['merge:proper:glimer vox→Glimmerbox']);
	});

	it('joins: an exact concatenation with another split is a no-audio `join` only for proper script words', () => {
		const r = run(
			'Ahora abrimos Glimmerbox y creamos una escena vacía.',
			'ahora abrimos glimmer box y creamos una escena vacía',
		);
		expect(r.candidates.map(brief)).toEqual(['join:proper:glimmer box→Glimmerbox']);
		expect(r.candidates[0]!.needsAudio).toBe(false);
		// a common word joined differently ("me dio" ↔ "medio") is left alone
		const common = run(
			'Al final me dio un error rarísimo en la consola.',
			'al final medio un error rarísimo en la consola',
		);
		expect(common.candidates).toEqual([]);
	});

	it('del: a script word the ASR dropped becomes a `del` candidate over the gap between its neighbours', () => {
		const r = run(
			'Ahora vamos a guardar el proyecto en la carpeta de trabajo.',
			'ahora vamos guardar el proyecto en la carpeta de trabajo',
		);
		expect(r.candidates.map(brief)).toEqual(['del:function:→a']);
		const c = r.candidates[0]!;
		expect(c.asr).toEqual([]);
		expect(c.start).toBe(r.words[1]!.end);
		expect(c.end).toBe(r.words[2]!.start);
		expect(c.fromWord).toBe(2);
		// the 50 ms gap is under DEL_MIN_GAP_SECONDS: the following word is taken in
		expect(c.anchor).toMatchObject({
			side: 'after',
			text: 'guardar',
			start: r.words[2]!.start,
			end: r.words[2]!.end,
		});
		expect(c.bounds).toEqual({ start: r.words[1]!.end, end: r.words[2]!.end });
	});

	it('ins: words said but not in the script are never offered', () => {
		const r = run(
			'Primero diseñé la carretera con curvas muy cerradas.',
			'primero diseñé la carretera pues con curvas muy cerradas',
		);
		expect(r.candidates).toEqual([]);
		expect(r.skippedCounts.ins).toBe(1);
		expect(r.alignment.report.insertedTokens).toBe(1);
	});

	it('retakes: each take aligns (backward jump counted) and gets its own candidates', () => {
		const r = run(
			'Bienvenidos a Glimmerbox. Hoy os enseño cómo hacer un menú principal con tres botones grandes.',
			'bienvenidos a glimmerbox hoy os enseño como hacer un menu principal hoy os enseño cómo hacer un menú prinsipal con tres botones grandes',
		);
		expect(r.alignment.report.retakeJumps).toBe(1);
		// "menu" = "menú" (accents stripped); "prinsipal" sounds like "principal" but is a recognition error to verify
		expect(r.candidates.map(brief)).toEqual(['sub:other:prinsipal→principal']);
	});

	it('retakes with a misrecognition in both takes offer it twice, with the same fingerprint', () => {
		const r = run(
			'Hoy os enseño el editor de NovaPlay paso a paso con calma.',
			'hoy os enseño el editor de nova plei paso a | hoy os enseño el editor de nova plei paso a paso con calma',
		);
		const subs = r.candidates.filter((c) => c.script.join(' ') === 'NovaPlay');
		expect(subs).toHaveLength(2);
		expect(subs[0]!.fingerprint).toBe(subs[1]!.fingerprint);
		expect(subs[0]!.id).not.toBe(subs[1]!.id);
	});

	it('off-script chatter is aligned to OFF and produces no candidates', () => {
		const r = run(
			'Vamos a añadir tres botones grandes al menú principal.',
			'vamos a añadir tres botones | uy espera que se me ha caído el café encima del teclado otra vez madre mía | grande al menú principal',
		);
		expect(r.alignment.report.offScriptTokens).toBeGreaterThanOrEqual(10);
		expect(r.candidates).toEqual([]);
	});

	it('directions: parenthesised words skip for free; a region touching them is never offered', () => {
		const r = run(
			'Hola a todos (mirar a cámara) y bienvenidos al canal de siempre.',
			'hola a todos y bienvenidos al canal de siempre',
		);
		expect(r.candidates).toEqual([]);
		expect(r.alignment.report.skippedScriptTokens).toBe(3);
		const touching = run(
			'Hola a todos (mirar a cámara) y bienvenidos.',
			'hola a todos mirando la cámara y bienvenidos',
		);
		expect(touching.candidates).toEqual([]);
	});

	it('headings: heading lines are skipped like directions', () => {
		const r = run(
			'SHORT ENFOCADO EN EL JUEGO\nHoy jugamos al modo carrera con amigos.\nEscena dos:\nY ganamos la final.',
			'hoy jugamos al modo carrera con amigos y ganamos la final',
		);
		expect(r.candidates).toEqual([]);
		expect(r.script.summary.headingLines).toBe(2);
		expect(r.alignment.report.exactTokens).toBe(11);
	});

	it('"&" reads as "y": the spoken "y" matches; a misheard "en" is offered as "y"', () => {
		expect(
			run('Hoy jugamos a Sunblob & Moonblob otra vez.', 'hoy jugamos a sunblob y moonblob otra vez')
				.candidates,
		).toEqual([]);
		const r = run('Hoy jugamos a Sunblob & Moonblob otra vez.', 'hoy jugamos a sunblob en moonblob otra vez');
		expect(r.candidates.map(brief)).toEqual(['sub:function:en→y']);
	});

	it('numbers: digits match number words (24 = veinticuatro, 1 = una); number disagreements are never offered', () => {
		const ok = run(
			'Lo hice en 24 horas y con 1 sola mano.',
			'lo hice en veinticuatro horas y con una sola mano',
		);
		expect(ok.candidates).toEqual([]);
		expect(ok.alignment.report.exactTokens).toBe(10);
		const bad = run('Lo hice en 24 horas y con una sola mano.', 'lo hice en 25 horas y con una sola mano');
		expect(bad.candidates).toEqual([]);
		expect(bad.skippedCounts.number).toBe(1);
	});

	it('stylised spellings in the script are never offered', () => {
		const r = run(
			'Y el resultado quedó Peeerfecto para el vídeo final.',
			'y el resultado quedó perfecto para el vídeo final',
		);
		expect(r.candidates).toEqual([]);
		expect(r.skippedCounts.stylised).toBe(1);
	});

	it('mixed regions are split into the proper part and the plain part (SC-025)', () => {
		const r = run(
			'Y ahora es NovaDev Arcade el mejor estudio del mundo.',
			'y ahora la nova de barcade el mejor estudio del mundo',
		);
		expect(r.candidates.map(brief)).toEqual([
			'sub:function:la→es',
			'merge:proper:nova de barcade→NovaDev Arcade',
		]);
		expect(r.candidates.every((c) => c.mixed)).toBe(true);
	});

	it('display form (SC-031): script spelling, ASR punctuation and capital, script casing only for proper words', () => {
		const r = run(
			'Después programé los COCHES con físicas sencillas.',
			'¿Después programé los coche, con físicas sencillas?',
		);
		expect(r.candidates.map((c) => c.script)).toEqual([['coches,']]);
		const cap = run('Hoy abrimos Glimmerbox otra vez.', 'Hoy abrimos glimer-box. Otra vez');
		expect(cap.candidates[0]!.script).toEqual(['Glimmerbox.']);
	});

	it('fingerprints are stable across re-transcription timing and differ by context', () => {
		const a = run(
			'Hoy probamos el motor de Pixelforge con un nivel nuevo.',
			'hoy probamos el motor de pixelforch con un nivel nuevo',
		);
		const b = run(
			'Hoy probamos el motor de Pixelforge con un nivel nuevo.',
			'| hoy probamos el motor de pixelforch con un nivel nuevo',
		);
		expect(a.candidates[0]!.fingerprint).toBe(b.candidates[0]!.fingerprint);
		const c = run(
			'Ayer probamos el motor de Pixelforge con un nivel nuevo.',
			'ayer probamos el motor de pixelforch con un nivel nuevo',
		);
		expect(c.candidates[0]!.fingerprint).toBe(a.candidates[0]!.fingerprint); // context is ± 2 words
		const d = run(
			'Hoy probamos el motor de Pixelforge sin un nivel nuevo.',
			'hoy probamos el motor de pixelforch sin un nivel nuevo',
		);
		expect(d.candidates[0]!.fingerprint).not.toBe(a.candidates[0]!.fingerprint);
	});

	it('rejected fingerprints are skipped unless asked for (SC-055)', () => {
		const a = run(
			'Hoy probamos el motor de Pixelforge con un nivel nuevo.',
			'hoy probamos el motor de pixelforch con un nivel nuevo',
		);
		const fp = a.candidates[0]!.fingerprint;
		const again = findFixCandidates({
			mediaId: 'media-1',
			transcriptId: 'tr-1',
			words: a.words,
			script: a.script,
			alignment: a.alignment,
			rejected: [fp],
		});
		expect(again.candidates).toEqual([]);
		expect(again.skippedCounts.rejected).toBe(1);
		const shown = findFixCandidates({
			mediaId: 'media-1',
			transcriptId: 'tr-1',
			words: a.words,
			script: a.script,
			alignment: a.alignment,
			rejected: [fp],
			includeRejected: true,
		});
		expect(shown.candidates[0]!.rejected).toBe(true);
		expect(decideFix(shown.candidates[0]!, { ...score(shown.candidates[0]!, 0) }).selected).toBe(false);
	});
});

describe('English (SC-012 en rules)', () => {
	it('names, joins and plain substitutions', () => {
		const r = run(
			'Today we build a racing game in Pixelforge with three tracks.',
			'today we built a racing game in pixel forge with three tracks',
			'en',
		);
		expect(r.candidates.map(brief)).toEqual(['sub:other:built→build', 'join:proper:pixel forge→Pixelforge']);
		for (const [text, spoken, exactTokens] of [
			['I made it in 24 hours.', 'i made it in twentyfour hours', 6],
			['We need one more level.', 'we need 1 more level', 5],
		] as const) {
			expect(run(text, spoken, 'en')).toMatchObject({
				candidates: [],
				alignment: { report: { exactTokens } },
			});
		}
	});
});

describe('glossary candidates (SC-073)', () => {
	const glossary: GlossaryEntryInput[] = [
		{ from: ['glimer box', 'glimmer vox'], to: 'Glimmerbox' },
		{ from: ['pixel forge'], to: 'Pixelforge' },
		{ from: ['nova plei'], to: 'NovaPlay', lang: 'en' },
	];

	it('finds ASR spellings without a script; spelling-only entries need no audio; other languages ignored', () => {
		const words = say('hoy abrimos glimer box y luego pixel forge y nova plei');
		const res = findFixCandidates({ mediaId: 'm', transcriptId: 't', words, language: 'es', glossary });
		expect(res.candidates.map(brief)).toEqual([
			'glossary:proper:glimer box→Glimmerbox',
			'glossary:proper:pixel forge→Pixelforge',
		]);
		expect(res.candidates.map((c) => c.needsAudio)).toEqual([true, false]);
		const d = decideFix(res.candidates[1]!, null);
		expect(d).toMatchObject({
			decision: 'fix',
			group: 'spelling',
			rule: 'glossary-spelling',
			deltaTok: null,
		});
		expect(d.words.map((w) => w.text)).toEqual(['Pixelforge']);
		expect(d.words[0]!.start).toBe(words[6]!.start);
		expect(d.words[0]!.end).toBe(words[7]!.end);
	});

	it('script candidates win over overlapping glossary candidates; glossary words count as proper', () => {
		const r = run(
			'Hoy abrimos Glimmerbox y creamos una escena.',
			'hoy abrimos glimmer vox y creamos una escena',
			'es',
			glossary,
		);
		expect(r.candidates.map(brief)).toEqual(['merge:proper:glimmer vox→Glimmerbox']);
		expect(r.skippedCounts.overlap).toBe(1);
	});
});

/** A fake audio score for a candidate. */
function score(c: FixCandidate, deltaTok: number): CandidateScore {
	return {
		candidateId: c.id,
		delta: deltaTok * 3,
		deltaTok,
		scriptTokens: 3,
		asrTokens: 2,
		words: c.script.map((text, k) => ({
			text,
			tokens: 1,
			logprob: -0.1,
			probability: 0.8,
			start: c.start + k * 1000,
			end: c.start + (k + 1) * 1000,
		})),
		before: null,
		after: null,
	};
}

describe('decisions (SC-034): presets and the Maybe band', () => {
	const base = run(
		'Hoy probamos el motor de Pixelforge con un nivel nuevo.',
		'hoy probamos el motor de pixelforch con un nivel nuevo',
	);
	const proper = base.candidates[0]!;
	const plain = { ...proper, category: 'other' as const };

	it.each([
		// [category, deltaTok, preset, decision, rule]
		['other', -1.2, 'careful', 'maybe', 'maybe'],
		['other', -1.2, 'standard', 'fix', 'audio'],
		['other', -1.8, 'standard', 'maybe', 'maybe'],
		['other', -1.8, 'generous', 'fix', 'audio'],
		['other', -3.5, 'careful', 'keep', 'below-margin'],
		['other', -3.5, 'standard', 'maybe', 'maybe'],
		['other', -4.5, 'generous', 'keep', 'below-margin'],
		['proper', -3.5, 'careful', 'fix', 'spelling'],
		['proper', -4.5, 'careful', 'keep', 'below-margin'],
		['proper', -4.5, 'standard', 'fix', 'spelling'],
		['proper', -5.5, 'generous', 'keep', 'below-margin'],
	] as const)('%s Δ_tok %d with %s → %s (%s)', (cat, d, preset, decision, rule) => {
		const c = cat === 'proper' ? proper : plain;
		expect(proper.psim).toBeGreaterThanOrEqual(0.8);
		const r = decideFix(c, score(c, d), preset);
		expect(r.decision).toBe(decision);
		expect(r.rule).toBe(rule);
		expect(r.group).toBe(decision === 'keep' ? null : decision);
		expect(r.selected).toBe(decision === 'fix');
		expect(r.words.length).toBe(decision === 'keep' ? 0 : 1);
	});

	it('the spelling rule needs psim ≥ 0.8', () => {
		const far = { ...proper, psim: 0.6 };
		expect(decideFix(far, score(far, -4.5)).decision).toBe('keep');
	});

	it('del is fixed only when the script reading is at least as likely; unscored candidates are kept', () => {
		const r = run(
			'Ahora vamos a guardar el proyecto en la carpeta.',
			'ahora vamos guardar el proyecto en la carpeta',
		);
		const del = r.candidates[0]!;
		expect(decideFix(del, score(del, 0.1)).rule).toBe('del');
		expect(decideFix(del, score(del, -0.5)).decision).toBe('maybe');
		expect(decideFix(del, null)).toMatchObject({ decision: 'keep', rule: 'unscored', group: null });
	});
});

describe('windows, scores, edits (SC-030 … SC-042)', () => {
	it('end to end: windows → fake scores → Δ_tok → decision → replaceWords edit', () => {
		const r = run(
			'Hoy probamos el motor de Pixelforge con un nivel nuevo. Ahora vamos a guardar el proyecto en la carpeta.',
			'hoy probamos el motor de pixelforch con un nivel nuevo | ahora vamos guardar el proyecto en la carpeta',
		);
		expect(r.candidates.map((c) => c.kind)).toEqual(['sub', 'del']);
		// the 1.5 s pause splits the stretches; unpacked (an option) they are one window each
		const unpacked = buildScoreWindows(r.words, r.candidates, { pack: false });
		expect(unpacked.unplaced).toEqual([]);
		expect(unpacked.windows.map((w) => [w.fromWord, w.toWord, w.mute])).toEqual([
			[0, 10, []],
			[10, 18, []],
		]);
		// by default both fit one packed window of ≤ 28 s whose gap between the padded stretches is muted
		const { windows, unplaced } = buildScoreWindows(r.words, r.candidates);
		expect(unplaced).toEqual([]);
		expect(windows).toHaveLength(1);
		const w = windows[0]!;
		expect(w.mute).toEqual([{ start: unpacked.windows[0]!.end, end: unpacked.windows[1]!.start }]);
		expect(w.mute[0]!.start).toBe(r.words[9]!.end + Math.round(0.35 * F));
		expect(w.mute[0]!.end).toBe(r.words[10]!.start - Math.round(0.25 * F));
		expect(scoreRequestWindows(windows)[0]!.mute).toEqual(w.mute);
		expect(buildScoreWindows(r.words, r.candidates, { muteGaps: false }).windows[0]!.mute).toEqual([]);
		expect(w.readings.map((x) => x.words.join(' '))).toEqual([
			'hoy probamos el motor de pixelforch con un nivel nuevo ahora vamos guardar el proyecto en la carpeta',
			'hoy probamos el motor de Pixelforge con un nivel nuevo ahora vamos guardar el proyecto en la carpeta',
			'hoy probamos el motor de pixelforch con un nivel nuevo ahora vamos a guardar el proyecto en la carpeta',
		]);
		expect(w.start).toBe(r.words[0]!.start - Math.round(0.25 * F));
		expect(w.end).toBe(r.words[r.words.length - 1]!.end + Math.round(0.35 * F));
		expect(Object.keys(scoreRequestWindows(windows)[0]!).sort()).toEqual([
			'end',
			'id',
			'mute',
			'readings',
			'start',
		]);
		expect(Object.keys(scoreRequestWindows(unpacked.windows)[0]!).sort()).toEqual([
			'end',
			'id',
			'readings',
			'start',
		]);
		// fake SC-092 result: per-word tokens 1 (pixelforch 3, Pixelforge 2), LLs chosen for the test
		const results: ScoreWindowResult[] = [
			{
				id: w.id,
				readings: w.readings.map((rd, k) => ({
					id: rd.id,
					logprob: [-40, -41, -39.5][k]!,
					tokens: rd.words.length,
					words: rd.words.map((text, i) => ({
						text,
						tokens: text === 'pixelforch' ? 3 : text === 'Pixelforge' ? 2 : 1,
						logprob: -1,
						probability: text === 'Pixelforge' ? 0.42 : 0.9,
						start: r.words[0]!.start + i * Math.round(0.35 * F) + 1000,
						end: r.words[0]!.start + i * Math.round(0.35 * F) + Math.round(0.3 * F) - 1000,
					})),
				})),
			},
		];
		const scores = candidateScores(windows, results);
		const [sub, del] = r.candidates as [FixCandidate, FixCandidate];
		expect(scores.get(sub.id)).toMatchObject({ delta: -1, scriptTokens: 2, asrTokens: 3 });
		expect(scores.get(sub.id)!.deltaTok).toBeCloseTo(-1 / 3, 9);
		expect(scores.get(del.id)!.deltaTok).toBeCloseTo(0.5, 9);
		const ds = decideFix(sub, scores.get(sub.id));
		expect(ds).toMatchObject({ decision: 'fix', group: 'fix', rule: 'audio' });
		const edit = replaceWordsEdit(sub, ds)!;
		expect(edit.expect).toEqual(['pixelforch']);
		expect(edit.words).toHaveLength(1);
		expect(edit.words[0]).toMatchObject({ text: 'Pixelforge', confidence: 0.42 });
		// SC-040: inside [previous word end, next word start]
		expect(edit.start).toBe(r.words[4]!.end);
		expect(edit.end).toBe(r.words[6]!.start);
		expect(edit.words[0]!.start).toBeGreaterThanOrEqual(edit.start);
		expect(edit.words[0]!.end).toBeLessThanOrEqual(edit.end);
		// 50 ms between "vamos" and "guardar": the edit takes "guardar" in and re-times it with the inserted "a"
		const dd = decideFix(del, scores.get(del.id));
		const delEdit = replaceWordsEdit(del, dd)!;
		const guardar = r.words[12]!;
		expect(guardar.text).toBe('guardar');
		expect(delEdit.expect).toEqual(['guardar']);
		expect(delEdit.start).toBe(r.words[11]!.end);
		expect(delEdit.end).toBe(guardar.end);
		expect(delEdit.words.map((x) => x.text)).toEqual(['a', 'guardar']);
		expect(delEdit.words[1]!.confidence).toBe(guardar.confidence);
		let cursor = delEdit.start;
		for (const x of delEdit.words) {
			expect(x.start).toBeGreaterThanOrEqual(cursor);
			expect(x.end - x.start).toBeGreaterThanOrEqual(1);
			cursor = x.end;
		}
		expect(cursor).toBeLessThanOrEqual(delEdit.end);
	});

	it('del into a gap of ≥ 60 ms stays inside the gap; neighbours keep their times', () => {
		const r = run(
			'Ahora vamos a guardar el proyecto en la carpeta.',
			'ahora vamos guardar el proyecto en la carpeta',
			'es',
			undefined,
			0.2,
		);
		const del = r.candidates[0]!;
		expect(del.kind).toBe('del');
		expect(del.anchor).toBeNull();
		expect(del.bounds).toEqual({ start: r.words[1]!.end, end: r.words[2]!.start });
		const { windows } = buildScoreWindows(r.words, [del]);
		const w = windows[0]!;
		const readingId = w.regions.find((g) => g.candidateId === del.id)!.readingId;
		const reading = w.readings.find((x) => x.id === readingId)!;
		// forced times that spill over both neighbours: clamped into the gap
		const results: ScoreWindowResult[] = [
			{
				id: w.id,
				readings: w.readings.map((rd) => ({
					id: rd.id,
					logprob: rd.id === readingId ? -10 : -11,
					tokens: rd.words.length,
					words: rd.words.map((text, i) => ({
						text,
						tokens: 1,
						logprob: -1,
						probability: 0.7,
						start: rd === reading && i === 2 ? r.words[1]!.start : r.words[0]!.start,
						end: rd === reading && i === 2 ? r.words[2]!.end : r.words[0]!.end,
					})),
				})),
			},
		];
		const s = candidateScores(windows, results).get(del.id)!;
		const edit = replaceWordsEdit(del, decideFix(del, s))!;
		expect(edit.expect).toEqual([]);
		expect(edit).toMatchObject({ start: r.words[1]!.end, end: r.words[2]!.start });
		expect(edit.words).toEqual([
			{ text: 'a', start: r.words[1]!.end, end: r.words[2]!.start, confidence: 0.7 },
		]);
	});

	it('del after the last word takes the previous word in (no following word)', () => {
		const words = say('vamos a guardar el proyecto');
		const last = words[4]!;
		const widened = delAnchorOf(words, 5)!;
		expect(widened.anchor).toMatchObject({
			side: 'before',
			text: 'proyecto',
			start: last.start,
			end: last.end,
		});
		expect(widened.bounds).toEqual({ start: last.start, end: last.end + Math.round(0.35 * F) });
		expect(delAnchorOf(say('vamos guardar', 0.2), 1)).toBeNull();
		const del = {
			...run('Vamos a guardar el proyecto.', 'vamos guardar el proyecto').candidates[0]!,
			fromWord: 5,
			toWord: 5,
			start: last.end,
			end: last.end,
			script: ['ahora'],
			...widened,
		};
		const { windows, unplaced } = buildScoreWindows(words, [del]);
		expect(unplaced).toEqual([]);
		expect(windows[0]!.readings[1]!.words).toEqual(['vamos', 'a', 'guardar', 'el', 'proyecto', 'ahora']);
		const t = (s: number) => Math.round(s * F);
		const results: ScoreWindowResult[] = [
			{
				id: windows[0]!.id,
				readings: windows[0]!.readings.map((rd) => ({
					id: rd.id,
					logprob: rd.id === windows[0]!.regions[0]!.readingId ? -5 : -6,
					tokens: rd.words.length,
					words: rd.words.map((text, i) => ({
						text,
						tokens: 1,
						logprob: -1,
						probability: 0.6,
						start: i === 4 ? t(1.9) : i === 5 ? t(2.0) : (words[i]?.start ?? 0),
						end: i === 4 ? t(2.0) : i === 5 ? t(9) : (words[i]?.end ?? 0),
					})),
				})),
			},
		];
		const edit = replaceWordsEdit(del, decideFix(del, candidateScores(windows, results).get(del.id)))!;
		expect(edit.expect).toEqual(['proyecto']);
		expect(edit.start).toBe(last.start);
		expect(edit.end).toBe(widened.bounds.end);
		expect(edit.words).toEqual([
			{ text: 'proyecto', start: last.start, end: t(2.0), confidence: 0.9 },
			{ text: 'ahora', start: t(2.0), end: widened.bounds.end, confidence: 0.6 },
		]);
	});

	it('a malformed score result gives no score (kept, never a crash)', () => {
		const r = run(
			'Hoy probamos el motor de Pixelforge con un nivel nuevo.',
			'hoy probamos el motor de pixelforch con un nivel nuevo',
		);
		const { windows } = buildScoreWindows(r.words, r.candidates);
		const valid: ScoreWindowResult[] = windows.map((w) => ({
			id: w.id,
			readings: w.readings.map((rd) => ({
				id: rd.id,
				logprob: -1,
				tokens: rd.words.length,
				words: rd.words.map((text, i) => ({
					text,
					tokens: 1,
					logprob: -1,
					probability: 0.9,
					start: w.start + i,
					end: w.start + i + 1,
				})),
			})),
		}));
		expect(candidateScores(windows, valid).size).toBe(1);
		const nonfinite = structuredClone(valid);
		nonfinite[0]!.readings[0]!.logprob = Number.NaN;
		expect(candidateScores(windows, nonfinite).size).toBe(0);
		const shortened = structuredClone(valid);
		shortened[0]!.readings[0]!.words.pop();
		expect(candidateScores(windows, shortened).size).toBe(0);
		const missing = structuredClone(valid);
		missing[0]!.readings.pop();
		expect(candidateScores(windows, missing).size).toBe(0);
		expect(candidateScores(windows, []).size).toBe(0);
	});

	it('long stretches split at their largest gap; windows only where candidates are', () => {
		const words: FixWord[] = [];
		for (let k = 0; k < 120; k++) {
			const t = k * 0.4 + (k >= 60 ? 0.8 : 0); // one 1.2 s-like gap at word 60 (0.1 + 0.8 s)
			words.push({ text: `w${k}`, start: Math.round(t * F), end: Math.round((t + 0.3) * F) });
		}
		const cand = {
			id: 'c',
			needsAudio: true,
			fromWord: 70,
			toWord: 71,
			script: ['x'],
		} as unknown as FixCandidate;
		const { windows } = buildScoreWindows(words, [cand], { gapSeconds: 5 });
		expect(windows).toHaveLength(1);
		expect(windows[0]!.fromWord).toBe(60);
		expect(windows[0]!.toWord).toBe(120);
	});
});
