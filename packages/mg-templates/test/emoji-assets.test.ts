// social-comment §7.8: emoji segmentation, codepoint keys and template asset requirements.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
	type AnyMgTemplate,
	emojiCodepointCandidates,
	emojiCodepointKey,
	emojiGraphemes,
	emojiKey,
	fullyQualifiedEmoji,
	graphemeOfEmojiKey,
	isEmojiGrapheme,
	resolveTemplateParams,
	splitEmoji,
	templateAssetOptions,
	templateRequiredAssets,
} from '../src/index.ts';

const SAMPLES = {
	thumbsTone: '\u{1F44D}\u{1F3FD}',
	family: '\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}',
	flagUs: '\u{1F1FA}\u{1F1F8}',
	flagEngland: '\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}',
	keycapOne: '1️⃣',
	keycapHashBare: '#⃣',
	redHeart: '❤️',
	grin: '\u{1F600}',
	rainbowFlag: '\u{1F3F3}️‍\u{1F308}',
	womanTechTone: '\u{1F469}\u{1F3FE}‍\u{1F4BB}',
	swatch: '\u{1F3FD}',
} as const;

describe('isEmojiGrapheme / splitEmoji', () => {
	it('recognises ZWJ sequences, skin tones, flags, keycaps and VS16 forms as single emoji', () => {
		for (const [name, g] of Object.entries(SAMPLES)) {
			expect(isEmojiGrapheme(g), name).toBe(true);
			expect(splitEmoji(g), name).toEqual([{ kind: 'emoji', grapheme: g }]);
		}
	});

	it('keeps text-presentation pictographs, VS15 forms, digits and letters as text', () => {
		for (const t of ['©', '™', '☺', '❤', '❤︎', '1', '#', 'a', 'é', '\u{1F600}︎'])
			expect(isEmojiGrapheme(t), JSON.stringify(t)).toBe(false);
	});

	it('splits mixed text in order and merges plain runs', () => {
		const text = `Hi ${SAMPLES.grin}${SAMPLES.grin} © ok${SAMPLES.family}!`;
		expect(splitEmoji(text)).toEqual([
			{ kind: 'text', text: 'Hi ' },
			{ kind: 'emoji', grapheme: SAMPLES.grin },
			{ kind: 'emoji', grapheme: SAMPLES.grin },
			{ kind: 'text', text: ' © ok' },
			{ kind: 'emoji', grapheme: SAMPLES.family },
			{ kind: 'text', text: '!' },
		]);
		expect(emojiGraphemes(text)).toEqual([SAMPLES.grin, SAMPLES.family]);
		expect(emojiGraphemes(text, 1)).toEqual([SAMPLES.grin]);
		expect(splitEmoji('')).toEqual([]);
	});

	it('round-trips any text (pieces concatenate to the input; emoji pieces are emoji, text pieces contain none)', () => {
		const emojiArb = fc.constantFrom(...Object.values(SAMPLES));
		const textArb = fc.array(fc.oneof(fc.string({ unit: 'grapheme', maxLength: 8 }), emojiArb), {
			maxLength: 12,
		});
		fc.assert(
			fc.property(textArb, (parts) => {
				const text = parts.join('');
				const pieces = splitEmoji(text);
				expect(pieces.map((p) => (p.kind === 'text' ? p.text : p.grapheme)).join('')).toBe(text);
				for (let i = 0; i < pieces.length; i++) {
					const p = pieces[i]!;
					if (p.kind === 'emoji') expect(isEmojiGrapheme(p.grapheme)).toBe(true);
					else {
						expect(p.text.length).toBeGreaterThan(0);
						// adjacent text pieces are merged
						expect(pieces[i + 1]?.kind).not.toBe('text');
					}
				}
			}),
			{ numRuns: 400 },
		);
	});
});

describe('codepoint keys (pack URL {cp})', () => {
	it('joins lower-case hex code points with "-" and applies the FE0F rules', () => {
		expect(emojiCodepointKey(SAMPLES.thumbsTone)).toBe('1f44d-1f3fd');
		expect(emojiCodepointKey(SAMPLES.keycapOne)).toBe('31-fe0f-20e3');
		expect(emojiCodepointCandidates(SAMPLES.redHeart, 'keep')).toEqual(['2764-fe0f']);
		expect(emojiCodepointCandidates(SAMPLES.redHeart, 'strip')).toEqual(['2764']);
		expect(emojiCodepointCandidates(SAMPLES.redHeart, 'try-both')).toEqual(['2764-fe0f', '2764']);
		expect(emojiCodepointCandidates(SAMPLES.grin, 'try-both')).toEqual(['1f600']);
		// a sequence typed without VS16 is looked up in its fully-qualified form too
		expect(emojiCodepointCandidates('\u{1F3F3}\u200D\u{1F308}', 'keep')).toEqual([
			'1f3f3-200d-1f308',
			'1f3f3-fe0f-200d-1f308',
		]);
		expect(emojiCodepointCandidates('\u{1F3F3}\u200D\u{1F308}', 'try-both')).toEqual([
			'1f3f3-200d-1f308',
			'1f3f3-fe0f-200d-1f308',
		]);
		expect(emojiCodepointCandidates('1\u20E3', 'keep')).toEqual(['31-20e3', '31-fe0f-20e3']);
		expect(fullyQualifiedEmoji(SAMPLES.womanTechTone)).toBe(SAMPLES.womanTechTone);
		expect(fullyQualifiedEmoji(SAMPLES.rainbowFlag)).toBe(SAMPLES.rainbowFlag);
		expect(fullyQualifiedEmoji('\u{1F44D}\u{1F3FD}')).toBe('\u{1F44D}\u{1F3FD}');
		expect(fullyQualifiedEmoji(SAMPLES.flagUs)).toBe(SAMPLES.flagUs);
		expect(emojiCodepointKey(SAMPLES.flagUs, { join: '_', minDigits: 4 })).toBe('1f1fa_1f1f8');
		expect(emojiCodepointKey(SAMPLES.keycapOne, { join: '_', minDigits: 4, stripFe0f: true })).toBe(
			'0031_20e3',
		);
	});

	it('maps canonical keys back to their grapheme and refuses anything else', () => {
		for (const g of Object.values(SAMPLES)) expect(graphemeOfEmojiKey(emojiKey(g))).toBe(g);
		for (const bad of [
			'',
			'0041',
			'41',
			'1F600',
			'01f600',
			'1f600-',
			'1f600--1f600',
			'1f600-1f600',
			'd800',
			'110000',
			'../x',
			'2764-fe0e',
		])
			expect(graphemeOfEmojiKey(bad), bad).toBeNull();
	});

	it('graphemeOfEmojiKey never throws and only returns emoji whose key is the input (fuzz)', () => {
		const hexKey = fc
			.array(fc.integer({ min: 0, max: 0x10ffff }), { minLength: 1, maxLength: 20 })
			.map((cps) => cps.map((c) => c.toString(16)).join('-'));
		fc.assert(
			fc.property(fc.oneof(hexKey, fc.string({ maxLength: 40 })), (key) => {
				const g = graphemeOfEmojiKey(key);
				if (g !== null) {
					expect(isEmojiGrapheme(g)).toBe(true);
					expect(emojiKey(g)).toBe(key);
				}
			}),
			{ numRuns: 1000 },
		);
	});
});

function fakeTemplate(required?: (p: Record<string, unknown>) => unknown): AnyMgTemplate {
	const paramsSchema = z
		.object({ text: z.string().default('hi'), pack: z.enum(['apple', 'twemoji']).default('apple') })
		.strict();
	return {
		id: 'fake',
		version: 1,
		name: 'Fake',
		category: 'Test',
		paramsSchema,
		defaults: { text: 'hi', pack: 'apple' },
		introFrames: 0,
		outroFrames: 0,
		defaultDurationSeconds: 1,
		canvases: [{ width: 100, height: 100 }],
		renderer: 'anime',
		renderVersion: 1,
		...(required ? { requiredAssets: required as never } : {}),
	} as AnyMgTemplate;
}

const declaring = fakeTemplate((p) => ({
	fonts: [
		{ family: 'Chirp', weight: 400, style: 'normal' },
		{ family: 'Chirp', weight: 700, style: 'normal' },
	],
	emoji: { pack: p.pack, graphemes: emojiGraphemes(String(p.text)) },
}));

describe('templateRequiredAssets', () => {
	it('collects fonts and emoji of the params and of every param keyframe value', () => {
		const r = templateRequiredAssets(
			declaring,
			{ text: `a ${SAMPLES.grin}`, pack: 'apple' },
			{
				text: [{ time: 0, value: `${SAMPLES.flagUs}`, interpolation: 'hold' } as never],
				pack: [{ time: 10, value: 'twemoji', interpolation: 'hold' } as never],
			},
		);
		expect(r).toEqual({
			fonts: [
				{ family: 'Chirp', weight: 400, style: 'normal' },
				{ family: 'Chirp', weight: 700, style: 'normal' },
			],
			emoji: [
				{ pack: 'apple', graphemes: [SAMPLES.grin, SAMPLES.flagUs] },
				{ pack: 'twemoji', graphemes: [SAMPLES.grin] },
			],
		});
	});

	it('collects remote image ids (bounded, validated)', () => {
		const r = templateRequiredAssets(
			fakeTemplate(() => ({ fonts: [], images: ['x-default-avatar', 'x-default-avatar'] })),
			{},
		);
		expect(r).toEqual({ fonts: [], emoji: [], images: ['x-default-avatar'] });
		expect(
			templateRequiredAssets(
				fakeTemplate(() => ({ fonts: [], images: ['Bad Id'] })),
				{},
			),
		).toBeNull();
	});

	it('is null for templates without the hook, that throw, or that return invalid data', () => {
		expect(templateRequiredAssets(fakeTemplate(), {})).toBeNull();
		expect(
			templateRequiredAssets(
				fakeTemplate(() => {
					throw new Error('boom');
				}),
				{},
			),
		).toBeNull();
		expect(
			templateRequiredAssets(
				fakeTemplate(() => ({ fonts: [{ family: '', weight: 400 }] })),
				{},
			),
		).toBeNull();
		expect(
			templateRequiredAssets(
				fakeTemplate(() => ({ fonts: [], emoji: { pack: 'x', graphemes: [] } })),
				{},
			),
		).toBeNull();
		expect(
			templateRequiredAssets(
				fakeTemplate(() => ({ fonts: [] })),
				{},
			),
		).toBeNull();
	});

	it('drops non-emoji graphemes and bounds the emoji list', () => {
		const many = Array.from({ length: 1500 }, (_, i) => String.fromCodePoint(0x1f300 + (i % 700)));
		const r = templateRequiredAssets(
			fakeTemplate(() => ({ fonts: [], emoji: { pack: 'noto', graphemes: ['a', '©', ...many] } })),
			{},
		);
		expect(r?.emoji[0]?.graphemes.every(isEmojiGrapheme)).toBe(true);
		expect(r?.emoji[0]?.graphemes.length).toBeLessThanOrEqual(512);
	});

	it('resolves params like the layer (invalid fields fall back to defaults)', () => {
		expect(resolveTemplateParams(declaring, { text: 5, pack: 'twemoji' })).toEqual({
			text: 'hi',
			pack: 'twemoji',
		});
	});

	it('templateAssetOptions looks templates up in the registry', () => {
		const opts = templateAssetOptions(
			{ getDefinition: (id) => (id === 'fake' ? declaring : undefined) },
			{ font: () => null, emoji: () => null },
		);
		expect(opts.required({ template: { id: 'nope', version: 1 }, params: {} })).toBeNull();
		expect(opts.required({ template: { id: 'fake', version: 1 }, params: {} })?.fonts).toHaveLength(2);
	});
});
