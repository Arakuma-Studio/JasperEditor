// Social-comment formatters (design 2026-10-25 §7.4): per-platform counts, times and replies labels.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	formatCount,
	formatRepliesLabel,
	formatTime,
	SOCIAL_COUNT_FIELDS,
	SOCIAL_TIME_UNITS,
	SOCIAL_VARIANTS,
	type SocialVariant,
} from '../src/index.ts';

/** The number a formatted count stands for ("1.2K" → 1200, "1,393" → 1393). */
function countValue(s: string): number {
	const m = /^([\d,]+)(?:\.(\d))?([KMB]?)$/.exec(s);
	if (!m) throw new Error(`not a count: ${s}`);
	const whole = Number(m[1]!.replaceAll(',', ''));
	const scale = { '': 1, K: 1e3, M: 1e6, B: 1e9 }[m[3] as '' | 'K' | 'M' | 'B'];
	return (whole * 10 + Number(m[2] ?? 0)) * (scale / 10);
}

describe('formatCount', () => {
	const cases: [number, Record<'tiktok' | 'instagram' | 'youtube' | 'x', string>][] = [
		[0, { tiktok: '0', instagram: '0', youtube: '0', x: '0' }],
		[7, { tiktok: '7', instagram: '7', youtube: '7', x: '7' }],
		[72, { tiktok: '72', instagram: '72', youtube: '72', x: '72' }],
		[999, { tiktok: '999', instagram: '999', youtube: '999', x: '999' }],
		[1000, { tiktok: '1,000', instagram: '1,000', youtube: '1K', x: '1K' }],
		[1200, { tiktok: '1,200', instagram: '1,200', youtube: '1.2K', x: '1.2K' }],
		[1250, { tiktok: '1,250', instagram: '1,250', youtube: '1.2K', x: '1.2K' }],
		[1299, { tiktok: '1,299', instagram: '1,299', youtube: '1.2K', x: '1.2K' }],
		[1393, { tiktok: '1,393', instagram: '1,393', youtube: '1.3K', x: '1.3K' }],
		[9999, { tiktok: '9,999', instagram: '9,999', youtube: '9.9K', x: '9.9K' }],
		[10_000, { tiktok: '10K', instagram: '10K', youtube: '10K', x: '10K' }],
		[12_000, { tiktok: '12K', instagram: '12K', youtube: '12K', x: '12K' }],
		[12_345, { tiktok: '12.3K', instagram: '12.3K', youtube: '12K', x: '12.3K' }],
		[123_456, { tiktok: '123.4K', instagram: '123.4K', youtube: '123K', x: '123.4K' }],
		[999_999, { tiktok: '999.9K', instagram: '999.9K', youtube: '999K', x: '999.9K' }],
		[1_000_000, { tiktok: '1M', instagram: '1M', youtube: '1M', x: '1M' }],
		[1_250_000, { tiktok: '1.2M', instagram: '1.2M', youtube: '1.2M', x: '1.2M' }],
		[12_500_000, { tiktok: '12.5M', instagram: '12.5M', youtube: '12M', x: '12.5M' }],
		[999_999_999, { tiktok: '999.9M', instagram: '999.9M', youtube: '999M', x: '999.9M' }],
		[1_500_000_000, { tiktok: '1.5B', instagram: '1.5B', youtube: '1.5B', x: '1.5B' }],
		[1e12, { tiktok: '1,000B', instagram: '1,000B', youtube: '1,000B', x: '1,000B' }],
	];
	const variantOf = {
		tiktok: ['tiktok-comment', 'tiktok-reply'],
		instagram: ['instagram-post', 'instagram-reel-reply'],
		youtube: ['youtube-comment', 'youtube-shorts-reply'],
		x: ['x-post'],
	} as const;
	it.each(cases)('%d', (n, expected) => {
		for (const [platform, variants] of Object.entries(variantOf))
			for (const v of variants)
				for (const field of SOCIAL_COUNT_FIELDS)
					expect(formatCount(v, n, field), `${v} ${field}`).toBe(expected[platform as keyof typeof expected]);
	});

	it('formats invalid input as 0 and drops fractions', () => {
		for (const v of SOCIAL_VARIANTS) {
			for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -5, -0.5])
				expect(formatCount(v, bad)).toBe('0');
			expect(formatCount(v, 999.99)).toBe('999');
			expect(formatCount(v, 'x' as unknown as number)).toBe('0');
		}
	});

	it('never throws, truncates, and is monotonic (property)', () => {
		fc.assert(
			fc.property(
				fc.constantFrom(...SOCIAL_VARIANTS),
				fc.integer({ min: 0, max: 1e12 }),
				fc.integer({ min: 0, max: 1e12 }),
				(v, a, b) => {
					const [lo, hi] = a <= b ? [a, b] : [b, a];
					const fl = formatCount(v, lo);
					const fh = formatCount(v, hi);
					expect(countValue(fl)).toBeLessThanOrEqual(countValue(fh));
					// truncation: never shows more than the real count, and loses at most one display step
					expect(countValue(fl)).toBeLessThanOrEqual(lo);
					expect(lo - countValue(fl)).toBeLessThan(Math.max(1, lo / 10 + 1));
				},
			),
		);
		fc.assert(
			fc.property(fc.constantFrom(...SOCIAL_VARIANTS), fc.double(), (v, n) => {
				const s = formatCount(v, n);
				expect(s).toMatch(/^[\d,]+(\.\d)?[KMB]?$/);
			}),
		);
	});
});

describe('formatTime', () => {
	it('uses compact units on TikTok, Instagram and X', () => {
		const compact: SocialVariant[] = [
			'tiktok-reply',
			'tiktok-comment',
			'instagram-post',
			'instagram-reel-reply',
			'x-post',
		];
		const suffix = { minute: 'm', hour: 'h', day: 'd', week: 'w', month: 'mo', year: 'y' } as const;
		for (const v of compact)
			for (const u of SOCIAL_TIME_UNITS) expect(formatTime(v, 3, u)).toBe(`3${suffix[u]}`);
		expect(formatTime('tiktok-comment', 1, 'day')).toBe('1d');
		expect(formatTime('instagram-post', 2, 'week')).toBe('2w');
		expect(formatTime('instagram-post', 56, 'week')).toBe('56w');
		expect(formatTime('x-post', 2, 'hour')).toBe('2h');
	});

	it('writes "N units ago" on YouTube with singular and plural, months as months', () => {
		for (const v of ['youtube-comment', 'youtube-shorts-reply'] as const) {
			expect(formatTime(v, 10, 'month')).toBe('10 months ago');
			expect(formatTime(v, 1, 'month')).toBe('1 month ago');
			expect(formatTime(v, 3, 'minute')).toBe('3 minutes ago');
			expect(formatTime(v, 1, 'hour')).toBe('1 hour ago');
			expect(formatTime(v, 2, 'day')).toBe('2 days ago');
			expect(formatTime(v, 1, 'week')).toBe('1 week ago');
			expect(formatTime(v, 5, 'year')).toBe('5 years ago');
		}
	});

	it('shows 0 as "now" / "Just now" per platform', () => {
		expect(formatTime('tiktok-comment', 0, 'day')).toBe('Just now');
		expect(formatTime('youtube-comment', 0, 'month')).toBe('Just now');
		expect(formatTime('instagram-post', 0, 'week')).toBe('now');
		expect(formatTime('x-post', 0, 'hour')).toBe('now');
	});

	it('never throws on any input (property)', () => {
		fc.assert(
			fc.property(
				fc.constantFrom(...SOCIAL_VARIANTS),
				fc.double(),
				fc.oneof(fc.constantFrom(...SOCIAL_TIME_UNITS), fc.string()),
				(v, value, unit) => {
					const s = formatTime(v, value, unit as never);
					expect(s).not.toMatch(/NaN|Infinity|undefined/);
					expect(s.length).toBeGreaterThan(0);
				},
			),
		);
		expect(formatTime('x-post', 1e9, 'year')).toBe('10000y');
		expect(formatTime('x-post', 2.9, 'hour')).toBe('2h');
	});
});

describe('formatRepliesLabel', () => {
	it('matches the platform wording, singular and plural', () => {
		expect(formatRepliesLabel('tiktok-comment', 2)).toBe('View 2 replies');
		expect(formatRepliesLabel('tiktok-comment', 1)).toBe('View 1 reply');
		expect(formatRepliesLabel('tiktok-comment', 12_345)).toBe('View 12.3K replies');
		expect(formatRepliesLabel('instagram-post', 5)).toBe('View 5 more replies');
		expect(formatRepliesLabel('instagram-post', 1)).toBe('View 1 more reply');
		expect(formatRepliesLabel('youtube-comment', 2)).toBe('2 replies');
		expect(formatRepliesLabel('youtube-comment', 1)).toBe('1 reply');
		expect(formatRepliesLabel('youtube-comment', 1500)).toBe('1.5K replies');
	});

	it('hides the label for 0 replies and for variants without a replies row (tokcomment bug "View 0 replies")', () => {
		for (const v of SOCIAL_VARIANTS) {
			expect(formatRepliesLabel(v, 0)).toBe('');
			expect(formatRepliesLabel(v, Number.NaN)).toBe('');
			expect(formatRepliesLabel(v, -3)).toBe('');
		}
		for (const v of ['tiktok-reply', 'instagram-reel-reply', 'youtube-shorts-reply', 'x-post'] as const)
			expect(formatRepliesLabel(v, 7)).toBe('');
	});

	it('never throws (property)', () => {
		fc.assert(
			fc.property(fc.constantFrom(...SOCIAL_VARIANTS), fc.double(), (v, n) => {
				expect(formatRepliesLabel(v, n)).not.toMatch(/NaN|Infinity|undefined|View 0/);
			}),
		);
	});
});
