// WP7a: the patches the social-comment Randomize actions write (capabilities respected, values consistent and valid).
import {
	SOCIAL_VARIANTS,
	type SocialVariant,
	socialCommentParamsSchema,
	socialDefaults,
	VARIANT_CAPABILITIES,
} from '@jasper/mg-templates';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	countOf,
	countPatch,
	identityPatch,
	randomSeed,
	statsPatch,
	timePatch,
	timeUnitOf,
	timeValueOf,
	variantOf,
} from '../src/social-comments/params.ts';

const seed = fc.integer({ min: 0, max: 0xffff_ffff });
const variant = fc.constantFrom(...SOCIAL_VARIANTS);

describe('social-comment param helpers', () => {
	it('reads untrusted values defensively', () => {
		expect(variantOf({ variant: 'x-post' })).toBe('x-post');
		expect(variantOf({ variant: 'myspace' })).toBe('tiktok-reply');
		expect(variantOf(null)).toBe('tiktok-reply');
		expect(countOf(12)).toBe(12);
		for (const bad of [-1, 1.5, Number.NaN, '12', null, 2e12]) expect(countOf(bad)).toBeNull();
		expect(timeValueOf(10_001)).toBeNull();
		expect(timeUnitOf('month')).toBe('month');
		expect(timeUnitOf('fortnight')).toBeNull();
		const s = randomSeed();
		expect(Number.isInteger(s) && s >= 0 && s <= 0xffff_ffff).toBe(true);
	});

	it('Randomize stats writes exactly the stats the variant draws, and the result is valid', () => {
		fc.assert(
			fc.property(variant, seed, (v: SocialVariant, s) => {
				const params = socialDefaults(v);
				const patch = statsPatch(params, s);
				const caps = VARIANT_CAPABILITIES[v] as Record<string, boolean>;
				for (const k of ['timeValue', 'timeUnit', 'likes', 'replies', 'reposts', 'views'])
					expect(k in patch, `${v} ${k}`).toBe(caps[k]);
				expect(socialCommentParamsSchema.safeParse({ ...params, ...patch }).success).toBe(true);
				if (caps.likes) {
					const likes = patch.likes as number;
					const replies = patch.replies as number;
					expect(replies).toBeLessThanOrEqual(Math.round(likes * 0.05));
				}
			}),
			{ numRuns: 400 },
		);
	});

	it('a field wand keeps the field consistent with the other counts', () => {
		fc.assert(
			fc.property(seed, fc.integer({ min: 1, max: 5_000_000 }), (s, likes) => {
				const params = { ...socialDefaults('x-post'), likes };
				const replies = countPatch('replies', params, s)!.replies as number;
				const reposts = countPatch('reposts', params, s)!.reposts as number;
				const views = countPatch('views', params, s)!.views as number;
				expect(replies).toBeGreaterThanOrEqual(Math.floor(likes * 0.01));
				expect(replies).toBeLessThanOrEqual(Math.ceil(likes * 0.05));
				expect(reposts).toBeGreaterThanOrEqual(Math.floor(likes * 0.1));
				expect(reposts).toBeLessThanOrEqual(Math.ceil(likes * 0.3));
				expect(views).toBeGreaterThanOrEqual(Math.floor(likes * 10));
				expect(views).toBeLessThanOrEqual(Math.ceil(likes * 50));
			}),
			{ numRuns: 300 },
		);
		fc.assert(
			fc.property(seed, fc.integer({ min: 1, max: 100_000 }), (s, replies) => {
				const likes = countPatch('likes', { ...socialDefaults('tiktok-comment'), replies }, s)!
					.likes as number;
				expect(replies / likes).toBeGreaterThanOrEqual(0.0099);
				expect(replies / likes).toBeLessThanOrEqual(0.0501);
			}),
			{ numRuns: 300 },
		);
	});

	it('leaves fields the variant hides alone', () => {
		const reply = socialDefaults('tiktok-reply');
		expect(countPatch('likes', reply, 1)).toBeNull();
		expect(countPatch('views', socialDefaults('tiktok-comment'), 1)).toBeNull();
		expect(timePatch(reply, 1)).toBeNull();
		expect(statsPatch(reply, 1)).toEqual({});
		expect(timePatch(socialDefaults('youtube-comment'), 7)).toMatchObject({
			timeValue: expect.any(Number),
			timeUnit: expect.any(String),
		});
	});

	it('Randomize identity writes a valid name, handle and generated avatar', () => {
		fc.assert(
			fc.property(seed, (s) => {
				const patch = identityPatch(s);
				expect(Object.keys(patch).sort()).toEqual(['avatar', 'displayName', 'handle']);
				expect(patch.avatar).toEqual({ generated: expect.any(Number) });
				expect(socialCommentParamsSchema.safeParse({ ...socialDefaults('x-post'), ...patch }).success).toBe(
					true,
				);
			}),
			{ numRuns: 200 },
		);
	});
});
