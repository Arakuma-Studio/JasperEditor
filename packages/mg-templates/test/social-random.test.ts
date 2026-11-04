// Seeded social-comment randomizer: identities, generated avatars, stats distribution and fillSocialParams.
import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	fillSocialParams,
	generatedAvatar,
	randomIdentity,
	randomStats,
	SOCIAL_PARAM_NAMES,
	SOCIAL_VARIANTS,
	socialCommentParamsSchema,
	socialDefaults,
} from '../src/index.ts';

const handleOk = (h: string) => socialCommentParamsSchema.shape.handle.safeParse(h).success;
const nameOk = (n: string) => socialCommentParamsSchema.shape.displayName.safeParse(n).success;

describe('determinism', () => {
	afterEach(() => vi.restoreAllMocks());
	it('uses no Math.random and repeats for the same seed', () => {
		vi.spyOn(Math, 'random').mockImplementation(() => {
			throw new Error('Math.random used');
		});
		for (const seed of [0, 1, 42, -7, 3.5, 2 ** 40, Number.NaN]) {
			expect(randomIdentity(seed)).toEqual(randomIdentity(seed));
			expect(generatedAvatar(seed)).toEqual(generatedAvatar(seed));
			for (const v of SOCIAL_VARIANTS) expect(randomStats(v, seed)).toEqual(randomStats(v, seed));
			expect(fillSocialParams({}, seed)).toEqual(fillSocialParams({}, seed));
		}
	});
});

describe('randomIdentity', () => {
	it('gives valid, varied, consistent identities', () => {
		const names = new Set<string>();
		const handles = new Set<string>();
		for (let seed = 0; seed < 500; seed++) {
			const id = randomIdentity(seed);
			expect(nameOk(id.displayName), id.displayName).toBe(true);
			expect(handleOk(id.handle), id.handle).toBe(true);
			// fits X's 15-character limit and the lower-case handle style
			expect(id.handle).toMatch(/^[a-z0-9][a-z0-9._]{0,14}$/);
			expect(id.handle).not.toMatch(/[._]$/);
			// the handle comes from the same name as the display name
			const firstWord = id.displayName.split(' ')[0]!.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '');
			expect(id.handle.includes(firstWord.slice(0, 5)), `${id.displayName} / ${id.handle}`).toBe(true);
			expect(Number.isInteger(id.avatar.generated)).toBe(true);
			names.add(id.displayName);
			handles.add(id.handle);
		}
		expect(names.size).toBeGreaterThan(400);
		expect(handles.size).toBeGreaterThan(450);
	});

	it('accepts any number as a seed (property)', () => {
		fc.assert(
			fc.property(fc.double(), (seed) => {
				const id = randomIdentity(seed);
				expect(handleOk(id.handle) && nameOk(id.displayName)).toBe(true);
				expect(socialCommentParamsSchema.shape.avatar.safeParse(id.avatar).success).toBe(true);
			}),
		);
	});
});

describe('generatedAvatar', () => {
	it('describes a gradient with initials or a silhouette', () => {
		const styles = new Set<string>();
		for (let seed = 0; seed < 200; seed++) {
			const a = generatedAvatar(seed);
			styles.add(a.style);
			expect(a.background.from).toMatch(/^#[0-9A-F]{6}$/);
			expect(a.background.to).toMatch(/^#[0-9A-F]{6}$/);
			expect(a.foreground).toMatch(/^#[0-9A-F]{6}$/);
			expect(Number.isFinite(a.background.angleDeg)).toBe(true);
			if (a.style === 'initials') expect(a.initials).toMatch(/^\p{Lu}{1,2}$/u);
			else expect(a.initials).toBe('');
		}
		expect(styles).toEqual(new Set(['initials', 'silhouette']));
	});

	it('takes initials from the given name', () => {
		const seed = [...Array(50).keys()].find((s) => generatedAvatar(s).style === 'initials')!;
		expect(generatedAvatar(seed, 'zoë ödegaard').initials).toBe('ZÖ');
		expect(generatedAvatar(seed, 'Luna 🌙').initials).toBe('L');
		// a name without letters falls back to a silhouette
		expect(generatedAvatar(seed, '🌙 ✨')).toMatchObject({ style: 'silhouette', initials: '' });
		// same colours whatever the name
		expect(generatedAvatar(seed, 'A').background).toEqual(generatedAvatar(seed, 'B').background);
	});
});

describe('randomStats', () => {
	it("follows tokcomment's likes distribution and ratios", () => {
		const N = 20_000;
		const bands = [0, 0, 0, 0];
		let invalidSeed: number | null = null;
		for (let seed = 0; seed < N; seed++) {
			const s = randomStats('x-post', seed);
			if (s.likes <= 500) bands[0]!++;
			else if (s.likes <= 10_000) bands[1]!++;
			else if (s.likes <= 100_000) bands[2]!++;
			else bands[3]!++;
			if (
				invalidSeed === null &&
				!(
					[s.likes, s.replies, s.reposts, s.views, s.timeValue].every((n) => typeof n === 'number') &&
					s.likes >= 1 &&
					s.likes <= 5_000_000 &&
					s.replies >= Math.floor(s.likes * 0.01) &&
					s.replies <= Math.ceil(s.likes * 0.05) &&
					s.reposts >= Math.floor(s.likes * 0.1) &&
					s.reposts <= Math.ceil(s.likes * 0.3) &&
					s.views >= Math.floor(s.likes * 10) &&
					s.views <= Math.ceil(s.likes * 50) &&
					s.timeValue >= 1
				)
			)
				invalidSeed = seed;
		}
		expect(invalidSeed, 'first seed violating the documented count bounds and ratios').toBeNull();
		// band edges (500, 10k, 100k) are shared by two bands: tolerance covers it
		const share = bands.map((b) => b / N);
		expect(share[0]).toBeCloseTo(0.4, 1);
		expect(share[1]).toBeCloseTo(0.3, 1);
		expect(share[2]).toBeCloseTo(0.2, 1);
		expect(share[3]).toBeCloseTo(0.1, 1);
	});

	it('gives every variant valid stats with plausible ages', () => {
		for (const v of SOCIAL_VARIANTS) {
			const units = new Set<string>();
			for (let seed = 0; seed < 300; seed++) {
				const s = randomStats(v, seed);
				expect(socialCommentParamsSchema.safeParse({ ...socialDefaults(v), ...s }).success).toBe(true);
				units.add(s.timeUnit);
			}
			expect(units.size).toBeGreaterThanOrEqual(4);
		}
		// Instagram counts weeks instead of months and years
		for (let seed = 0; seed < 300; seed++)
			expect(['month', 'year']).not.toContain(randomStats('instagram-post', seed).timeUnit);
	});
});

describe('fillSocialParams', () => {
	it('fills every omitted field and returns params that parse', () => {
		const r = fillSocialParams({}, 7);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(socialCommentParamsSchema.parse(r.params)).toEqual(r.params);
		expect(r.filled).toEqual([...SOCIAL_PARAM_NAMES]);
		expect(r.params.variant).toBe('tiktok-reply');
		expect(r.params.avatar).toMatchObject({ generated: expect.any(Number) });
		expect(r.params.displayName).not.toBe('username');
	});

	it('keeps provided values, including explicit null avatar and the per-variant look defaults', () => {
		const r = fillSocialParams(
			{ variant: 'x-post', text: 'Hello ==world==', avatar: null, likes: 5, verified: true, theme: 'dark' },
			3,
		);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.params).toMatchObject({
			variant: 'x-post',
			text: 'Hello ==world==',
			avatar: null,
			likes: 5,
			verified: true,
			theme: 'dark',
			entrance: 'soft-spring',
		});
		// stats scale with the given likes
		expect(r.params.replies).toBeLessThanOrEqual(1);
		expect(r.params.views).toBeLessThanOrEqual(250);
		expect(r.filled).not.toContain('likes');
		expect(r.filled).not.toContain('avatar');
		expect(r.filled).toContain('handle');
	});

	it('derives a matching handle from a given name and vice versa', () => {
		const a = fillSocialParams({ displayName: 'María José' }, 1);
		expect(a.ok && a.params.handle.startsWith('maria')).toBe(true);
		const b = fillSocialParams({ handle: 'art.by.omar' }, 1);
		expect(b.ok && b.params.displayName).toBe('Omar');
		const c = fillSocialParams({ displayName: '🌙🌙' }, 1);
		expect(c.ok && c.params.displayName === '🌙🌙' && c.params.handle.length > 0).toBe(true);
	});

	it('treats explicit undefined as omitted', () => {
		const r = fillSocialParams({ variant: 'youtube-comment', handle: undefined }, 9);
		expect(r.ok && r.params.handle.length > 0).toBe(true);
	});

	it('reports invalid input instead of throwing', () => {
		const bad = [
			{ bogus: 1 },
			{ likes: -1 },
			{ handle: '@luna' },
			'text',
			42,
			[],
			{ text: 'a'.repeat(2001) },
		];
		for (const x of bad) {
			const r = fillSocialParams(x, 1);
			expect(r.ok).toBe(false);
			if (!r.ok) expect(r.error.length).toBeGreaterThan(0);
		}
		expect(fillSocialParams(null, 1).ok).toBe(true);
		expect(fillSocialParams(undefined, 1).ok).toBe(true);
	});

	it('fills only omitted fields and always parses (property)', () => {
		const full = fc.record({
			variant: fc.constantFrom(...SOCIAL_VARIANTS),
			theme: fc.constantFrom('light', 'dark'),
			displayName: fc.constantFrom('Ana', 'Kofi Mensah 🔥', 'Ж'),
			handle: fc.constantFrom('ana', 'kofi_m', 'zh.x'),
			avatar: fc.oneof(
				fc.constant(null),
				fc.record({ generated: fc.nat() }),
				fc.record({ mediaId: fc.constant('m1') }),
			),
			verified: fc.boolean(),
			timeValue: fc.integer({ min: 0, max: 10_000 }),
			timeUnit: fc.constantFrom('minute', 'hour', 'day', 'week', 'month', 'year'),
			likes: fc.integer({ min: 0, max: 1e12 }),
			replies: fc.integer({ min: 0, max: 1e12 }),
			text: fc.string({ maxLength: 50 }),
		});
		fc.assert(
			fc.property(full, fc.subarray<string>([...SOCIAL_PARAM_NAMES]), fc.integer(), (all, keep, seed) => {
				const partial = Object.fromEntries(Object.entries(all).filter(([k]) => keep.includes(k)));
				const r = fillSocialParams(partial, seed);
				expect(r.ok).toBe(true);
				if (!r.ok) return;
				expect(socialCommentParamsSchema.safeParse(r.params).success).toBe(true);
				for (const [k, v] of Object.entries(partial)) expect(r.params[k as keyof typeof r.params]).toEqual(v);
				expect(r.filled.sort()).toEqual(SOCIAL_PARAM_NAMES.filter((k) => !(k in partial)).sort());
			}),
		);
		fc.assert(
			fc.property(fc.anything(), fc.double(), (x, seed) => {
				fillSocialParams(x, seed);
			}),
		);
	});
});
