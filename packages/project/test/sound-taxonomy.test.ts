import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	inferTypesFromName,
	isSoundTypeId,
	SOUND_BED_TYPES,
	SOUND_EFFECT_TYPES,
	SOUND_TYPE_IDS,
	SOUND_TYPES,
	TYPE_SYNONYMS,
	tokenizeSoundText,
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
	});

	it('aligns risers and reverses by their end, UI by its start, whooshes and hits by the peak', () => {
		expect(SOUND_TYPES.riser.defaultAlign).toBe('end');
		expect(SOUND_TYPES.reverse.defaultAlign).toBe('end');
		expect(SOUND_TYPES.ui.defaultAlign).toBe('start');
		expect(SOUND_TYPES.whoosh.defaultAlign).toBe('peak');
		const others = SOUND_EFFECT_TYPES.filter((t) => !['riser', 'reverse', 'ui'].includes(t));
		for (const t of others) expect(SOUND_TYPES[t].defaultAlign, t).toBe('peak');
	});
});

describe('TYPE_SYNONYMS and name inference', () => {
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
					expect(r.length).toBeLessThanOrEqual(4);
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
