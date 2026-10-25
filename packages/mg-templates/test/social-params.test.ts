// social-comment params: variants, capability table, strict schema with agent descriptions, tokcomment defaults.
import { type MgTemplateInfo, paramsPropertySpecs } from '@jasper/project';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
	isReviewVariant,
	parseReviewDate,
	resolveEmojiStyle,
	SOCIAL_DEFAULT_REVIEW_TEXT,
	SOCIAL_DEFAULT_TEXT,
	SOCIAL_REVIEW_VARIANTS,
	SOCIAL_PARAM_NAMES,
	SOCIAL_VARIANTS,
	type SocialVariant,
	socialCommentParamsSchema,
	socialCommentPartialSchema,
	socialDefaults,
	VARIANT_CAPABILITIES,
	VARIANT_LABELS,
	VARIANT_PLATFORM,
	variantsWithParam,
} from '../src/index.ts';

const jsonSchema = () =>
	z.toJSONSchema(socialCommentParamsSchema, { io: 'input', unrepresentable: 'any' }) as {
		properties: Record<string, { description?: string; default?: unknown }>;
		additionalProperties: boolean;
	};

describe('variants and capabilities', () => {
	it('lists the seven tokcomment variants and the three store reviews with labels', () => {
		expect(SOCIAL_VARIANTS).toEqual([
			'tiktok-reply',
			'tiktok-comment',
			'instagram-post',
			'instagram-reel-reply',
			'youtube-comment',
			'youtube-shorts-reply',
			'x-post',
			'play-store-review',
			'app-store-review',
			'app-store-review-ios',
		]);
		expect(SOCIAL_REVIEW_VARIANTS).toEqual(['play-store-review', 'app-store-review', 'app-store-review-ios']);
		expect(SOCIAL_VARIANTS.filter(isReviewVariant)).toEqual([...SOCIAL_REVIEW_VARIANTS]);
		expect(isReviewVariant('x-post')).toBe(false);
		expect(isReviewVariant(42)).toBe(false);
		expect(VARIANT_PLATFORM['play-store-review']).toBe('play-store');
		expect(VARIANT_PLATFORM['app-store-review']).toBe('app-store');
		expect(VARIANT_PLATFORM['app-store-review-ios']).toBe('app-store');
		for (const v of SOCIAL_VARIANTS) expect(VARIANT_LABELS[v].length).toBeGreaterThan(0);
	});

	it('follows tokcomment: no stats on the reply cards, no verified on Reels/Shorts, reposts and views only on X', () => {
		const stats = ['timeValue', 'timeUnit', 'likes', 'replies', 'likeTick'] as const;
		const comments = SOCIAL_VARIANTS.filter((v) => !isReviewVariant(v));
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
		expect(variantsWithParam('displayName')).toEqual([
			'tiktok-reply',
			'tiktok-comment',
			'x-post',
			...SOCIAL_REVIEW_VARIANTS,
		]);
		expect(variantsWithParam('handle')).toEqual([
			'instagram-post',
			'instagram-reel-reply',
			'youtube-comment',
			'youtube-shorts-reply',
			'x-post',
		]);
		for (const p of ['variant', 'theme', 'emojiStyle', 'text', 'entrance', 'wordReveal'] as const)
			expect(variantsWithParam(p)).toEqual([...SOCIAL_VARIANTS]);
		// the comment cards are unchanged by the store reviews: every one draws an avatar, none a review field
		for (const p of ['avatar', 'showProfile'] as const)
			expect(variantsWithParam(p)).toEqual([...comments, 'play-store-review']);
		for (const v of comments)
			for (const p of ['rating', 'date', 'edited', 'title', 'truncate'] as const)
				expect(VARIANT_CAPABILITIES[v][p], `${v}.${p}`).toBe(false);
		// every variant shows at least one name
		for (const v of SOCIAL_VARIANTS)
			expect(VARIANT_CAPABILITIES[v].displayName || VARIANT_CAPABILITIES[v].handle).toBe(true);
	});

	it('gives the store reviews their fields (design §11)', () => {
		const caps = (v: SocialVariant) =>
			SOCIAL_PARAM_NAMES.filter((p) => VARIANT_CAPABILITIES[v][p] && !ALWAYS.includes(p));
		const ALWAYS: readonly string[] = ['variant', 'theme', 'emojiStyle', 'text', 'entrance', 'wordReveal'];
		// Play: avatar, name, stars + date, body (no title, no counts, no badge)
		expect(caps('play-store-review')).toEqual([
			'displayName',
			'avatar',
			'showProfile',
			'rating',
			'date',
			'truncate',
			'likeTick',
		]);
		// App Store web: no avatar; stars, "name, date", title, body
		expect(caps('app-store-review')).toEqual(['displayName', 'rating', 'date', 'title', 'truncate', 'likeTick']);
		// iPhone app: title + relative age (edited), stars + name, body
		expect(caps('app-store-review-ios')).toEqual([
			'displayName',
			'timeValue',
			'timeUnit',
			'rating',
			'edited',
			'title',
			'truncate',
			'likeTick',
		]);
		expect(variantsWithParam('likeTick')).toEqual([
			'tiktok-comment',
			'instagram-post',
			'youtube-comment',
			'x-post',
			...SOCIAL_REVIEW_VARIANTS,
		]);
	});

	it('resolves the auto emoji style per platform', () => {
		expect(resolveEmojiStyle('tiktok-reply', 'auto')).toBe('apple');
		expect(resolveEmojiStyle('instagram-post', 'auto')).toBe('apple');
		expect(resolveEmojiStyle('youtube-comment', 'auto')).toBe('noto');
		expect(resolveEmojiStyle('x-post', 'auto')).toBe('apple');
		expect(resolveEmojiStyle('x-post', 'apple')).toBe('apple');
		expect(resolveEmojiStyle('play-store-review', 'auto')).toBe('noto');
		expect(resolveEmojiStyle('app-store-review', 'auto')).toBe('apple');
		expect(resolveEmojiStyle('app-store-review-ios', 'auto')).toBe('apple');
		expect(resolveEmojiStyle('play-store-review', 'twemoji')).toBe('twemoji');
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
			// store reviews: neutral placeholders, 4 stars (the requester's Play screenshot), "1y ago" on the iPhone card
			'play-store-review': { displayName: 'Display Name', text: SOCIAL_DEFAULT_REVIEW_TEXT },
			'app-store-review': { displayName: 'Display Name', title: 'Review title', text: SOCIAL_DEFAULT_REVIEW_TEXT },
			'app-store-review-ios': {
				displayName: 'Display Name',
				title: 'Review title',
				timeValue: 1,
				timeUnit: 'year',
				edited: false,
				text: SOCIAL_DEFAULT_REVIEW_TEXT,
			},
		};
		for (const v of SOCIAL_VARIANTS) {
			const d = socialDefaults(v);
			expect(socialCommentParamsSchema.parse(d)).toEqual(d);
			expect(d).toMatchObject({
				variant: v,
				text: SOCIAL_DEFAULT_TEXT,
				rating: 4,
				date: '2025-09-24',
				truncate: true,
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
		// store reviews
		for (const r of [1, 2, 3, 4, 5]) expect(ok({ rating: r })).toBe(true);
		for (const r of [0, 6, 4.5, -1, Number.NaN, '5']) expect(ok({ rating: r })).toBe(false);
		expect(ok({ date: '2024-02-29' })).toBe(true); // leap day
		expect(ok({ date: '2000-02-29' })).toBe(true); // divisible by 400
		expect(ok({ date: '1900-02-28' })).toBe(false); // before 1970
		expect(ok({ date: '2023-02-29' })).toBe(false);
		expect(ok({ date: '2100-02-28' })).toBe(false); // after 2099
		for (const d of ['2025-04-31', '2025-13-01', '2025-00-10', '2025-9-24', '09/24/2021', '2025-09-24T10:00', ''])
			expect(ok({ date: d }), d).toBe(false);
		expect(ok({ title: '' })).toBe(true);
		expect(ok({ title: 'Great so far 🎉' })).toBe(true);
		expect(ok({ title: 'x'.repeat(120) })).toBe(true);
		expect(ok({ title: 'x'.repeat(121) })).toBe(false);
		expect(ok({ title: 'two\nlines' })).toBe(false);
		expect(ok({ edited: true, truncate: false })).toBe(true);
		expect(ok({ truncate: 'yes' })).toBe(false);
	});

	it('validates review dates exactly like the calendar (property)', () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 1960, max: 2110 }),
				fc.integer({ min: 0, max: 13 }),
				fc.integer({ min: 0, max: 32 }),
				(y, m, d) => {
					const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
					const t = new Date(Date.UTC(y, m - 1, d));
					const real =
						m >= 1 && m <= 12 && t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
					const inRange = y >= 1970 && y <= 2099;
					expect(socialCommentParamsSchema.shape.date.safeParse(iso).success).toBe(real && inRange);
					expect(parseReviewDate(iso) !== null).toBe(real && inRange);
				},
			),
		);
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
