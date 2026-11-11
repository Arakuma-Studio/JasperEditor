// The TypeScript detector and planner against the research prototype they port (spec 14 TC-010…TC-023): the
// fixture holds synthetic recordings (generated words with Whisper-like offsets, synthetic levels and classes,
// retakes, restarts, false starts, fillers, marker phrases, off-script chatter, hallucinations) together with the
// prototype's own output for them (`autocut.py detect` + `cut`, `common.py clean_words`; presets `fast` and `calm`),
// produced by a generator kept with the private research (docs/wp-notes/transcript-cleanup.md "Port check").
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type CleanupVoice, detectCleanup } from '../src/cleanup/detector.ts';
import { planMediaCuts } from '../src/cleanup/plan.ts';
import {
	type CleanupSettings,
	FAST_SETTINGS,
	type FindingKind,
	mergeCleanupSettings,
} from '../src/cleanup/schema.ts';
import { FLICKS_PER_SECOND } from '../src/time.ts';

type Case = {
	seed: number;
	preset: 'fast' | 'calm';
	script: string | null;
	words: Array<{ text: string; s: number; e: number }>;
	level: string;
	classes: string;
	floorDb: number;
	expect: { reasons: Array<string | null>; guarded: boolean[]; kept: Array<[number, number]> };
};

const fixture = JSON.parse(
	readFileSync(new URL('./fixtures/cleanup-port.json', import.meta.url), 'utf8'),
) as { cases: Case[] };

const b64 = (s: string) => Uint8Array.from(Buffer.from(s, 'base64'));

/** The prototype's rules only (the spec's extra rules off), its marker tokens, no drawn-vowel rule. */
const ONLY_PROTOTYPE = {
	rules: {
		stutter: 'off',
		fillerLexical: 'off',
		asrSuspect: 'off',
		headTail: 'off',
		untranscribed: 'off',
	},
	thresholds: { drawnVowelS: 10 },
} as const;

const PRESETS: Record<Case['preset'], CleanupSettings> = {
	fast: mergeCleanupSettings(FAST_SETTINGS, ONLY_PROTOTYPE),
	// prototype `calm`: the fast rules without off-script, speech-frame edges with 100 / 150 ms pads, gaps ≤ 0.45 s,
	// breaths before an onset kept (≤ 600 ms), pieces ≥ 0.25 s
	calm: mergeCleanupSettings(FAST_SETTINGS, {
		...ONLY_PROTOTYPE,
		rules: { ...ONLY_PROTOTYPE.rules, offScript: 'off' },
		edges: { mode: 'speech', padBeforeS: 0.1, padAfterS: 0.15 },
		gaps: { maxGapS: 0.45, keepGapS: 0.25, keepGapSentenceS: 0.25, breath: 'keep', breathKeepMaxS: 0.6 },
	}),
};

const PROTOTYPE_MARKERS = [
	'este',
	'esto',
	'pues',
	'bueno',
	'osea',
	'vale',
	'tipo',
	'nada',
	'ay',
	'oh',
	'a',
	'ver',
	'ok',
	'okay',
	'si',
	'no',
];

const KIND: Record<string, FindingKind> = {
	filler: 'filler-vocalic',
	restart: 'restart',
	false_start: 'false-start',
	retake: 'retake',
	offscript: 'off-script',
	filler_phrase: 'filler-phrase',
};

/** The take rules' labels compare as one class: the repeat mechanism replaced the prototype's restart and take rules. */
const REPEAT: ReadonlySet<string> = new Set(['restart', 'false-start', 'retake']);
const cls = (k: string | null) => (k && REPEAT.has(k) ? 'repeat' : k);

/**
 * Deliberate differences from the prototype (docs/wp-notes/transcript-cleanup.md "Repeats by alignment"): an attempt is
 * removed only when its retry says it again in full (`repeats.ts`). Per seed (both presets): word ranges and the port's
 * label class there; the prototype's kept ranges do not apply to these cases.
 */
const DIFFERENCES: Record<number, Array<[from: number, to: number, kind: string | null]>> = {
	// "Primero diseñé la carretera con curvas muy cerradas. Le puse texturas a la carretera…": "la carretera" said in
	// the next sentence is no restart. "Si te gusta el video | a ver | Si te gusta el video suscríbete…": "a ver" written
	// as one word is no marker of the prototype's list, so the attempt and its retry are not adjacent (the built-in list
	// has it)
	2: [
		[14, 23, null],
		[54, 59, null],
	],
	// The first sentence's "la carretera con curvas muy cerradas" stays, and so does the start of the last take
	// "Le puse texturas a la carretera y ambienté el lugar" (the prototype cut "Le puse texturas a")
	3: [
		[20, 25, null],
		[44, 47, null],
	],
	// "Le | Le puse texturas…" is a false start; of two identical "Si te gusta el video suscríbete al canal" the first
	// goes whole (the prototype cut only its "Si te gusta" and kept the rest of the sentence twice)
	6: [
		[32, 32, 'repeat'],
		[85, 89, 'repeat'],
	],
	7: [
		[17, 22, null],
		[30, 33, null],
	],
	// "espera que se me ha colgado el ordenador" is said once: no take (the prototype's take rule matched it by its
	// short-unit test); "Primero | Primero diseñé…" is a false start and "Le" a restart's first word
	8: [
		[24, 31, null],
		[32, 32, 'repeat'],
		[54, 54, 'repeat'],
	],
};

describe('cleanup port vs the research prototype', () => {
	for (const c of fixture.cases) {
		const diff = DIFFERENCES[c.seed];
		it(`seed ${c.seed} ${c.preset}${c.script ? ' with script' : ''}: same labels${diff ? ' but the deliberate differences' : ' and kept ranges'}`, () => {
			const level = b64(c.level);
			const classes = b64(c.classes);
			const voice: CleanupVoice = {
				classes,
				level,
				frameCount: level.length,
				levels: { floorDb: c.floorDb, speechDb: null, speechThresholdDb: null, breathFloorDb: null },
			};
			const settings = PRESETS[c.preset];
			const words = c.words.map((w) => ({
				text: w.text,
				start: Math.round(w.s * FLICKS_PER_SECOND),
				end: Math.round(w.e * FLICKS_PER_SECOND),
				confidence: null,
			}));
			const r = detectCleanup({
				mediaId: 'med_port',
				words,
				voice,
				script: c.script,
				language: 'es',
				lists: { markers: PROTOTYPE_MARKERS },
				settings,
			});
			expect(r.words.length).toBe(c.expect.reasons.length);
			expect(r.guarded).toEqual(c.expect.guarded);
			const label = new Map<number, FindingKind>();
			for (const f of r.findings)
				if (f.words && f.kind !== 'hallucination')
					for (let i = f.words[0]; i <= f.words[1]; i++) label.set(i, f.kind);
			const got = r.words.map((w, k) => (r.guarded[k] ? null : cls(label.get(w.i) ?? null)));
			const want: Array<string | null> = c.expect.reasons.map((x) => (x ? cls(KIND[x]!) : null));
			for (const [a, b, kind] of diff ?? []) want.fill(kind, a, b + 1);
			expect(got).toEqual(want);
			if (diff) return;
			const removed = r.words.map((w, k) => r.guarded[k] || label.has(w.i));
			const plan = planMediaCuts({ words: r.words, removed, voice, settings, strictRemoval: false });
			expect(plan.kept.length).toBe(c.expect.kept.length);
			plan.kept.forEach(([a, b], i) => {
				// deliberate difference (level edges): after removed words an in point inside the first kept word moves
				// back to that word's start (≤ 100 ms earlier than the prototype's; soft onsets stay)
				const proto = c.expect.kept[i]![0];
				if (Math.abs(a - proto) > 1e-9) {
					expect(c.preset).toBe('fast');
					expect(proto - a).toBeGreaterThan(0);
					expect(proto - a).toBeLessThanOrEqual(0.1);
					expect(r.words.some((w, k) => Math.abs(w.s - a) < 1e-9 && !removed[k] && removed[k - 1])).toBe(
						true,
					);
				}
				expect(b).toBeCloseTo(c.expect.kept[i]![1], 9);
			});
		});
	}
});
