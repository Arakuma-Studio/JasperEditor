import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	inferTypesFromName,
	isSoundTypeId,
	MAX_INFERRED_TYPES,
	SOUND_BED_TYPES,
	SOUND_EFFECT_TYPES,
	SOUND_FAMILIES,
	SOUND_TYPE_IDS,
	SOUND_TYPE_PROFILES,
	SOUND_TYPES,
	TYPE_SYNONYMS,
	tokenizeSoundText,
	typeFitForVisualKind,
	typesForVisualKind,
	typesInTokens,
	typesOfFamily,
	VISUAL_KINDS,
} from '../src/index.ts';

describe('sound taxonomy (spec 12 §2.1)', () => {
	it('has the 19 effect types of the spec plus ambience and room tone', () => {
		expect(SOUND_EFFECT_TYPES).toEqual([
			'hit',
			'boom',
			'riser',
			'reverse',
			'transition',
			'whoosh',
			'swish',
			'glitch',
			'ui',
			'click',
			'key',
			'tick',
			'tap',
			'pop',
			'thump',
			'paper',
			'chime',
			'shimmer',
			'zap',
		]);
		expect(SOUND_BED_TYPES).toEqual(['ambience', 'roomtone']);
		expect(SOUND_TYPE_IDS).toHaveLength(21);
		expect(Object.keys(SOUND_TYPES).sort()).toEqual([...SOUND_TYPE_IDS].sort());
		for (const id of SOUND_TYPE_IDS) expect(SOUND_TYPES[id].id).toBe(id);
	});

	it('aligns risers and reverses by their end, UI by its start, whooshes and hits by the peak', () => {
		expect(SOUND_TYPES.riser.defaultAlign).toBe('end');
		expect(SOUND_TYPES.reverse.defaultAlign).toBe('end');
		expect(SOUND_TYPES.ui.defaultAlign).toBe('start');
		expect(SOUND_TYPES.whoosh.defaultAlign).toBe('peak');
		const others = SOUND_EFFECT_TYPES.filter((t) => !['riser', 'reverse', 'ui'].includes(t));
		for (const t of others) expect(SOUND_TYPES[t].defaultAlign, t).toBe('peak');
	});

	it('groups the chips into the families of the panel', () => {
		expect(typesOfFamily('impacts')).toEqual(['hit', 'boom', 'thump']);
		expect(typesOfFamily('movement')).toEqual(['riser', 'reverse', 'transition', 'whoosh', 'swish']);
		expect(typesOfFamily('digital')).toEqual(['glitch', 'ui', 'click', 'zap']);
		expect(typesOfFamily('tactile')).toEqual(['key', 'tick', 'tap', 'pop', 'paper']);
		expect(typesOfFamily('tonal')).toEqual(['chime', 'shimmer']);
		expect(typesOfFamily('beds')).toEqual(['ambience', 'roomtone']);
		expect(SOUND_FAMILIES.flatMap(typesOfFamily).sort()).toEqual([...SOUND_TYPE_IDS].sort());
	});

	it('every field is sane: weights, visual kinds, duration fits and profiles', () => {
		for (const id of SOUND_TYPE_IDS) {
			const t = SOUND_TYPES[id];
			expect(['hero', 'support', 'ambient']).toContain(t.defaultWeight);
			for (const k of t.visualKinds) expect(VISUAL_KINDS).toContain(k);
			expect(new Set(t.visualKinds).size).toBe(t.visualKinds.length);
			const f = t.durationFit;
			expect(f.minSec).toBeGreaterThan(0);
			expect(f.minSec).toBeLessThanOrEqual(f.idealSec);
			expect(f.idealSec).toBeLessThanOrEqual(f.maxSec);
			// a comfortable length passes the judge's own duration limits
			expect(f.idealSec).toBeGreaterThanOrEqual(t.profile.minDurSec);
			expect(f.idealSec).toBeLessThanOrEqual(t.profile.maxDurSec);
			expect(SOUND_TYPE_PROFILES[id]).toBe(t.profile);
			expect(Object.isFrozen(t.profile)).toBe(true);
		}
		expect(SOUND_TYPES.ambience.visualKinds).toEqual([]);
		expect(SOUND_TYPES.boom.defaultWeight).toBe('hero');
		expect(SOUND_TYPES.ambience.defaultWeight).toBe('ambient');
	});

	it('scores type fit for visual kinds, best first', () => {
		expect(typeFitForVisualKind('hit', 'land')).toBe(1);
		expect(typeFitForVisualKind('hit', 'cut')).toBeCloseTo(0.9);
		expect(typeFitForVisualKind('hit', 'move')).toBe(0);
		expect(typeFitForVisualKind('nope', 'move')).toBe(0);
		expect(typesForVisualKind('move').slice(0, 2)).toEqual(['whoosh', 'swish']);
		for (const k of VISUAL_KINDS) expect(typesForVisualKind(k).length).toBeGreaterThan(0);
	});
});

describe('TYPE_SYNONYMS and name inference', () => {
	it('every synonym is a normalised phrase that names a real type, and every type id is its own synonym', () => {
		for (const [phrase, type] of Object.entries(TYPE_SYNONYMS)) {
			expect(isSoundTypeId(type), phrase).toBe(true);
			expect(tokenizeSoundText(phrase).join(' '), phrase).toBe(phrase);
			expect(typesInTokens(tokenizeSoundText(phrase)), phrase).toEqual([type]);
		}
		for (const id of SOUND_TYPE_IDS) expect(TYPE_SYNONYMS[id]).toBe(id);
	});

	it('tokenises file names: camelCase, digits, separators, diacritics', () => {
		expect(tokenizeSoundText('Swoosh_Fast-03.wav')).toEqual(['swoosh', 'fast', '03', 'wav']);
		expect(tokenizeSoundText('bigBoomSubDrop2')).toEqual(['big', 'boom', 'sub', 'drop', '2']);
		expect(tokenizeSoundText('Ambiance Forêt')).toEqual(['ambiance', 'foret']);
		expect(tokenizeSoundText('')).toEqual([]);
	});

	it('infers types from paths: file name first, phrases before words, folders deepest first', () => {
		expect(inferTypesFromName('/sfx/Whooshes/swoosh_fast_03.wav')).toEqual(['whoosh']);
		expect(inferTypesFromName('C:\\Sounds\\Impacts\\door slam 2.ogg')).toEqual(['hit']);
		expect(inferTypesFromName('kit/sub-drop.wav')).toEqual(['boom']);
		expect(inferTypesFromName('UI/Buttons/click_01.wav')).toEqual(['click', 'ui']);
		expect(inferTypesFromName('Typing/keyboard_typing_long.flac')).toEqual(['key']);
		expect(inferTypesFromName('beds/room tone office.wav')).toEqual(['roomtone']);
		expect(inferTypesFromName('reverse cymbal into hit.wav')).toEqual(['reverse', 'hit']);
		expect(inferTypesFromName('Interface/MenuSelect.wav')).toEqual(['ui']);
		expect(inferTypesFromName('misc/door_creak.wav')).toEqual([]);
		expect(inferTypesFromName('')).toEqual([]);
	});

	it('never throws and returns at most 4 valid types for any input (property)', () => {
		fc.assert(
			fc.property(
				fc.oneof(
					fc.string({ maxLength: 300 }),
					fc
						.array(fc.constantFrom(...Object.keys(TYPE_SYNONYMS), 'x', '/', '\\', '_', ' ', '.wav'), {
							maxLength: 40,
						})
						.map((a) => a.join('')),
				),
				(s) => {
					const r = inferTypesFromName(s);
					expect(r.length).toBeLessThanOrEqual(MAX_INFERRED_TYPES);
					expect(new Set(r).size).toBe(r.length);
					for (const t of r) expect(isSoundTypeId(t)).toBe(true);
				},
			),
			{ numRuns: 400, seed: 1215 },
		);
		expect(inferTypesFromName(42 as never)).toEqual([]);
		expect(inferTypesFromName('a/'.repeat(10_000))).toEqual([]);
	});
});
