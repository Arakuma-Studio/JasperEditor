// social-comment params: variants, capability table, strict schema with agent descriptions, tokcomment defaults.
import { type MgTemplateInfo, paramsPropertySpecs } from '@jasper/project';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
	resolveEmojiStyle,
	SOCIAL_DEFAULT_TEXT,
	SOCIAL_PARAM_NAMES,
	SOCIAL_VARIANTS,
	type SocialVariant,
	socialCommentParamsSchema,
	socialCommentPartialSchema,
	socialDefaults,
	VARIANT_CAPABILITIES,
	VARIANT_LABELS,
	variantsWithParam,
} from '../src/index.ts';

const jsonSchema = () =>
	z.toJSONSchema(socialCommentParamsSchema, { io: 'input', unrepresentable: 'any' }) as {
		properties: Record<string, { description?: string; default?: unknown }>;
		additionalProperties: boolean;
	};

describe('variants and capabilities', () => {
	it('lists the seven tokcomment variants with labels', () => {
		expect(SOCIAL_VARIANTS).toEqual([
			'tiktok-reply',
			'tiktok-comment',
			'instagram-post',
			'instagram-reel-reply',
			'youtube-comment',
			'youtube-shorts-reply',
			'x-post',
		]);
		for (const v of SOCIAL_VARIANTS) expect(VARIANT_LABELS[v].length).toBeGreaterThan(0);
	});

	it('follows tokcomment: no stats on the reply cards, no verified on Reels/Shorts, reposts and views only on X', () => {
		const stats = ['timeValue', 'timeUnit', 'likes', 'replies', 'likeTick'] as const;
		for (const v of ['tiktok-reply', 'instagram-reel-reply', 'youtube-shorts-reply'] as const)
			for (const p of stats) expect(VARIANT_CAPABILITIES[v][p], `${v}.${p}`).toBe(false);
		for (const v of ['tiktok-comment', 'instagram-post', 'youtube-comment', 'x-post'] as const)
			for (const p of stats) expect(VARIANT_CAPABILITIES[v][p], `${v}.${p}`).toBe(true);
		expect(variantsWithParam('verified')).toEqual([
			'tiktok-reply',
			'tiktok-comment',
			'instagram-post',
			'youtube-comment',
			'x-post',
		]);
		for (const p of ['reposts', 'views', 'showReposts', 'showViews'] as const)
			expect(variantsWithParam(p)).toEqual(['x-post']);
		expect(variantsWithParam('displayName')).toEqual(['tiktok-reply', 'tiktok-comment', 'x-post']);
		expect(variantsWithParam('handle')).toEqual([
			'instagram-post',
			'instagram-reel-reply',
			'youtube-comment',
			'youtube-shorts-reply',
			'x-post',
		]);
		for (const p of [
			'variant',
			'theme',
			'emojiStyle',
			'avatar',
			'showProfile',
			'text',
			'entrance',
			'wordReveal',
		] as const)
			expect(variantsWithParam(p)).toEqual([...SOCIAL_VARIANTS]);
		// every variant shows at least one name
		for (const v of SOCIAL_VARIANTS)
			expect(VARIANT_CAPABILITIES[v].displayName || VARIANT_CAPABILITIES[v].handle).toBe(true);
	});

	it('resolves the auto emoji style per platform', () => {
		expect(resolveEmojiStyle('tiktok-reply', 'auto')).toBe('apple');
		expect(resolveEmojiStyle('instagram-post', 'auto')).toBe('apple');
		expect(resolveEmojiStyle('youtube-comment', 'auto')).toBe('noto');
		expect(resolveEmojiStyle('x-post', 'auto')).toBe('apple');
		expect(resolveEmojiStyle('x-post', 'apple')).toBe('apple');
	});
});

describe('socialCommentParamsSchema', () => {
	it('has exactly the documented params, each described for agents', () => {
		const js = jsonSchema();
		expect(Object.keys(js.properties)).toEqual([...SOCIAL_PARAM_NAMES]);
		expect(js.additionalProperties).toBe(false);
		for (const [name, p] of Object.entries(js.properties)) {
			expect(p.description, name).toBeTypeOf('string');
			expect(p.description!.length, name).toBeGreaterThan(30);
		}
		const capabilityKeys = Object.keys(VARIANT_CAPABILITIES['x-post']);
		expect(capabilityKeys).toEqual([...SOCIAL_PARAM_NAMES]);
		// marks syntax is documented where agents look
		expect(js.properties.text!.description).toContain('==highlighted words==');
		expect(js.properties.text!.description).toContain('||blurred words||');
		expect(js.properties.text!.description).toContain('~~removed words~~');
	});

	it('parses {} to the tiktok-reply defaults and rejects unknown keys', () => {
		expect(socialCommentParamsSchema.parse({})).toEqual(socialDefaults('tiktok-reply'));
		expect(socialCommentParamsSchema.safeParse({ bogus: 1 }).success).toBe(false);
		expect(socialCommentPartialSchema.safeParse({ bogus: 1 }).success).toBe(false);
		expect(socialCommentPartialSchema.parse({})).toEqual({});
	});

	it('defaults every variant to tokcomment values', () => {
		const expected: Record<SocialVariant, Record<string, unknown>> = {
			'tiktok-reply': { displayName: 'username' },
			'tiktok-comment': { displayName: 'username', timeValue: 1, timeUnit: 'day', likes: 1393, replies: 2 },
			'instagram-post': { handle: 'username', timeValue: 2, timeUnit: 'week', likes: 114, replies: 5 },
			'instagram-reel-reply': { handle: 'username' },
			'youtube-comment': { handle: 'Username', timeValue: 10, timeUnit: 'month', likes: 72, replies: 2 },
			'youtube-shorts-reply': { handle: 'Username' },
			'x-post': {
				displayName: 'Display Name',
				handle: 'username',
				timeValue: 2,
				timeUnit: 'hour',
				replies: 45,
				reposts: 12,
				likes: 1200,
				views: 12_000,
			},
		};
		for (const v of SOCIAL_VARIANTS) {
			const d = socialDefaults(v);
			expect(socialCommentParamsSchema.parse(d)).toEqual(d);
			expect(d).toMatchObject({
				variant: v,
				text: SOCIAL_DEFAULT_TEXT,
				theme: 'light',
				emojiStyle: 'auto',
				avatar: null,
				verified: false,
				showProfile: true,
				entrance: 'soft-spring',
				wordReveal: false,
				likeTick: false,
				...expected[v],
			});
		}
		expect(SOCIAL_DEFAULT_TEXT).toBe('Write any comment and see what happens 😊');
		// fresh objects: callers may mutate them
		expect(socialDefaults('x-post')).not.toBe(socialDefaults('x-post'));
	});

	it('enforces caps and shapes', () => {
		const ok = (patch: Record<string, unknown>) => socialCommentParamsSchema.safeParse(patch).success;
		expect(ok({ displayName: 'Luna Park 🌙' })).toBe(true);
		expect(ok({ displayName: '' })).toBe(false);
		expect(ok({ displayName: 'x'.repeat(65) })).toBe(false);
		expect(ok({ displayName: 'two\nlines' })).toBe(false);
		expect(ok({ handle: 'luna.makes' })).toBe(true);
		expect(ok({ handle: 'jake_rides22' })).toBe(true);
		expect(ok({ handle: 'María-José' })).toBe(true);
		expect(ok({ handle: '@luna' })).toBe(false);
		expect(ok({ handle: 'has space' })).toBe(false);
		expect(ok({ handle: 'x'.repeat(65) })).toBe(false);
		expect(ok({ likes: 0 })).toBe(true);
		expect(ok({ likes: 1e12 })).toBe(true);
		expect(ok({ likes: 1e12 + 1 })).toBe(false);
		expect(ok({ likes: 1.5 })).toBe(false);
		expect(ok({ likes: -1 })).toBe(false);
		expect(ok({ views: Number.NaN })).toBe(false);
		expect(ok({ timeValue: 10_000 })).toBe(true);
		expect(ok({ timeValue: 10_001 })).toBe(false);
		expect(ok({ timeUnit: 'months' })).toBe(false);
		expect(ok({ avatar: null })).toBe(true);
		expect(ok({ avatar: { mediaId: 'm_1' } })).toBe(true);
		expect(ok({ avatar: { mediaId: '' } })).toBe(false);
		expect(ok({ avatar: { generated: 42 } })).toBe(true);
		expect(ok({ avatar: { generated: 1.5 } })).toBe(false);
		expect(ok({ avatar: { mediaId: 'm', generated: 1 } })).toBe(false);
		expect(ok({ emojiStyle: 'twemoji' })).toBe(true);
		expect(ok({ emojiStyle: 'samsung' })).toBe(false);
		expect(ok({ entrance: 'drop-bounce' })).toBe(true);
		// text: 2000 visible characters; markup may add delimiters up to 4000
		expect(ok({ text: 'a'.repeat(2000) })).toBe(true);
		expect(ok({ text: 'a'.repeat(2001) })).toBe(false);
		expect(ok({ text: `==${'a'.repeat(1990)}==` })).toBe(true);
		expect(ok({ text: '==a=='.repeat(900) })).toBe(false); // 900 visible, 4500 markup
		expect(ok({ text: 'line one\nline two 😊' })).toBe(true);
	});

	it('maps to Properties specs without errors', () => {
		const info = {
			id: 'social-comment',
			version: 1,
			name: 'Social comment',
			category: 'Social',
			paramsSchema: socialCommentParamsSchema,
			defaults: socialDefaults('tiktok-reply'),
			introFrames: 15,
			outroFrames: 6,
			canvasDefault: 'sequence',
			canvases: [],
			renderer: 'anime',
			defaultDurationSeconds: 4,
		} as unknown as MgTemplateInfo;
		const specs = new Map(paramsPropertySpecs(info).map((s) => [s.key, s]));
		expect(specs.get('params.variant')?.kind).toBe('enum');
		expect(specs.get('params.likes')?.kind).toBe('number');
		expect(specs.get('params.likes')?.animatable).toBe('no');
		expect(specs.get('params.verified')?.kind).toBe('boolean');
		expect(specs.get('params.text')?.ui.multiline).toBe(true);
	});

	it('never throws on arbitrary input (property)', () => {
		fc.assert(
			fc.property(fc.anything(), (x) => {
				socialCommentParamsSchema.safeParse(x);
				socialCommentPartialSchema.safeParse(x);
			}),
		);
	});
});
