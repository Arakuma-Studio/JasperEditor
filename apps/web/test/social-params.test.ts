// WP7a: the patches the social-comment Randomize actions write (capabilities respected, values consistent and valid).
import { socialDefaults } from '@jasper/mg-templates';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { countPatch } from '../src/social-comments/params.ts';

const seed = fc.integer({ min: 0, max: 0xffff_ffff });

describe('social-comment param helpers', () => {
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
});
