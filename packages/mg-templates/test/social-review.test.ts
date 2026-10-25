// Store review cards (design §11): calendar dates and the stores' date formats, ratings, the review randomizer and
// fill, plain review text, the star fill of the "likes tick up" extra, and bulk import of store-review columns.
import {
	applyTransaction,
	cellIsoDate,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	mgImportTemplateOf,
	mgImportText,
	parseTable,
	planMgImport,
} from '@jasper/project';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	clampRating,
	dateOfDayNumber,
	dayNumber,
	fillSocialParams,
	formatCount,
	formatRepliesLabel,
	formatReviewAge,
	formatReviewDate,
	IOS_WEEKDAYS,
	isoDate,
	mgRegistry,
	parseReviewDate,
	randomRating,
	randomReviewDate,
	randomReviewTitle,
	randomStats,
	reviewAge,
	reviewAgeDays,
	SOCIAL_RATING_WEIGHTS,
	SOCIAL_REROLL_PARAMS,
	SOCIAL_REVIEW_DATE_ANCHOR,
	SOCIAL_REVIEW_VARIANTS,
	SOCIAL_STAR_COUNT,
	socialCommentParamsSchema,
	socialDefaults,
	socialLikesTick,
	socialStarFill,
	socialTickText,
	tokenizeComment,
	weekday,
	weekdayBeforeAnchor,
} from '../src/index.ts';

describe('calendar dates', () => {
	it('parses real ISO dates only', () => {
		expect(parseReviewDate('2018-11-06')).toEqual({ year: 2018, month: 11, day: 6 });
		expect(parseReviewDate('2024-02-29')).toEqual({ year: 2024, month: 2, day: 29 });
		for (const bad of [
			'2023-02-29',
			'2025-04-31',
			'2025-00-01',
			'2025-13-01',
			'2025-1-01',
			' 2025-01-01',
			'1969-12-31',
		])
			expect(parseReviewDate(bad), bad).toBeNull();
		for (const bad of [null, undefined, 20250101, {}, ['2025-01-01']])
			expect(parseReviewDate(bad)).toBeNull();
	});

	it('counts days and weekdays without a time zone', () => {
		expect(dayNumber({ year: 1970, month: 1, day: 1 })).toBe(0);
		expect(dayNumber({ year: 2026, month: 10, day: 25 })).toBe(20_751);
		expect(weekday({ year: 1970, month: 1, day: 1 })).toBe(4); // Thursday
		expect(weekday({ year: 2026, month: 10, day: 25 })).toBe(0); // a Sunday
		fc.assert(
			fc.property(fc.integer({ min: 0, max: 47_481 }), (n) => {
				const d = dateOfDayNumber(n);
				expect(dayNumber(d)).toBe(n);
				expect(parseReviewDate(isoDate(d))).toEqual(d);
			}),
		);
	});

	it('prints dates the way each store does (US English, as the requester screenshots)', () => {
		expect(formatReviewDate('play-store', '2018-11-06')).toBe('11/6/18');
		expect(formatReviewDate('play-store', '2009-01-31')).toBe('1/31/09');
		expect(formatReviewDate('play-store', '2000-12-01')).toBe('12/1/00');
		expect(formatReviewDate('app-store', '2021-09-24')).toBe('09/24/2021');
		expect(formatReviewDate('app-store', '2021-01-05')).toBe('01/05/2021');
		expect(formatReviewDate('app-store', '2021-02-30')).toBe('');
		expect(formatReviewDate('play-store', 'yesterday')).toBe('');
	});

	it('never throws and always prints a valid date in both forms (property)', () => {
		fc.assert(
			fc.property(fc.anything(), (v) => {
				const play = formatReviewDate('play-store', v);
				const app = formatReviewDate('app-store', v);
				if (parseReviewDate(v)) {
					expect(play).toMatch(/^\d{1,2}\/\d{1,2}\/\d{2}$/);
					expect(app).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
				} else expect([play, app]).toEqual(['', '']);
			}),
		);
	});
});

describe('iPhone review ages', () => {
	it('prints the weekday under a week (the reference screenshot, default) and the relative form otherwise', () => {
		expect(weekdayBeforeAnchor(0)).toBe('Sun'); // 2026-10-25 is a Sunday
		expect([1, 2, 3, 4, 5, 6, 7].map(weekdayBeforeAnchor)).toEqual([
			'Sat',
			'Fri',
			'Thu',
			'Wed',
			'Tue',
			'Mon',
			'Sun',
		]);
		expect(formatReviewAge(2, 'day', false)).toBe('Fri');
		expect(formatReviewAge(3, 'hour', true)).toBe('edited Sun');
		expect(formatReviewAge(0, 'minute', false)).toBe('Sun');
		expect(formatReviewAge(1, 'week', false)).toBe('1w ago');
		expect(formatReviewAge(1, 'year', true)).toBe('edited 1y ago');
		expect(formatReviewAge(2, 'day', false, 'relative')).toBe('2d ago');
		expect(formatReviewAge(0, 'hour', true, 'relative')).toBe('edited just now');
		expect(formatReviewAge(10, 'minute', false, 'relative')).toBe('Just now');
		expect(reviewAgeDays(2, 'week')).toBe(14);
		expect(reviewAgeDays(Number.NaN, 'day')).toBe(0);
	});

	it('never throws; a weekday exactly when the age is under 7 days (property)', () => {
		fc.assert(
			fc.property(
				fc.double(),
				fc.constantFrom('minute', 'hour', 'day', 'week', 'month', 'year', 'bogus'),
				fc.boolean(),
				(v, u, edited) => {
					const s = formatReviewAge(v, u as never, edited);
					const name = s.replace(/^edited /, '');
					expect((IOS_WEEKDAYS as readonly string[]).includes(name)).toBe(reviewAgeDays(v, u) < 7);
					expect(s.startsWith('edited ')).toBe(edited);
				},
			),
		);
	});
});

describe('ratings', () => {
	it('clamps to whole stars 1–5', () => {
		expect([0, 1, 2.4, 2.6, 5, 9, -3].map(clampRating)).toEqual([1, 1, 2, 3, 5, 5, 1]);
		expect(clampRating(Number.NaN)).toBe(5);
		expect(clampRating('3')).toBe(5);
	});

	it('draws a J-shaped distribution like real stores, deterministically', () => {
		const N = 20_000;
		const counts = [0, 0, 0, 0, 0];
		for (let s = 0; s < N; s++) {
			const r = randomRating(s);
			expect(r).toBe(randomRating(s));
			counts[r - 1]!++;
		}
		const total = Object.values(SOCIAL_RATING_WEIGHTS).reduce((a, b) => a + b, 0);
		for (const k of [1, 2, 3, 4, 5] as const)
			expect(counts[k - 1]! / N).toBeCloseTo(SOCIAL_RATING_WEIGHTS[k] / total, 1);
		// J shape: 5★ most, then 4★ / 1★ above the middle stars
		expect(counts[4]).toBeGreaterThan(counts[3]!);
		expect(counts[0]).toBeGreaterThan(counts[2]!);
		expect(counts[0]).toBeGreaterThan(counts[1]!);
	});
});

describe('review randomizer', () => {
	const anchor = dayNumber(parseReviewDate(SOCIAL_REVIEW_DATE_ANCHOR)!);

	it('draws dates within two years before the fixed anchor, recent ones likelier', () => {
		let recent = 0;
		for (let s = 0; s < 4000; s++) {
			const iso = randomReviewDate(s);
			expect(iso).toBe(randomReviewDate(s));
			const d = parseReviewDate(iso);
			expect(d, iso).not.toBeNull();
			const ago = anchor - dayNumber(d!);
			expect(ago).toBeGreaterThanOrEqual(0);
			expect(ago).toBeLessThanOrEqual(730);
			if (ago <= 182) recent++;
		}
		expect(recent / 4000).toBeGreaterThan(0.45);
	});

	it('turns a review age into the iPhone units', () => {
		expect(reviewAge(0, 5)).toEqual({ timeValue: 5, timeUnit: 'hour' });
		expect(reviewAge(0, 99)).toEqual({ timeValue: 23, timeUnit: 'hour' });
		expect(reviewAge(1)).toEqual({ timeValue: 1, timeUnit: 'day' });
		expect(reviewAge(6)).toEqual({ timeValue: 6, timeUnit: 'day' });
		expect(reviewAge(7)).toEqual({ timeValue: 1, timeUnit: 'week' });
		expect(reviewAge(29)).toEqual({ timeValue: 4, timeUnit: 'week' });
		expect(reviewAge(30)).toEqual({ timeValue: 1, timeUnit: 'month' });
		expect(reviewAge(364)).toEqual({ timeValue: 12, timeUnit: 'month' });
		expect(reviewAge(365)).toEqual({ timeValue: 1, timeUnit: 'year' });
		expect(reviewAge(730)).toEqual({ timeValue: 2, timeUnit: 'year' });
		expect(reviewAge(Number.NaN, 1)).toEqual({ timeValue: 1, timeUnit: 'hour' });
	});

	it('gives store reviews a rating, a date and the age that goes with it', () => {
		for (const v of SOCIAL_REVIEW_VARIANTS)
			for (let s = 0; s < 300; s++) {
				const st = randomStats(v, s);
				expect(socialCommentParamsSchema.safeParse({ ...socialDefaults(v), ...st }).success).toBe(true);
				const ago = anchor - dayNumber(parseReviewDate(st.date)!);
				const age = reviewAge(ago, st.timeUnit === 'hour' ? st.timeValue : 1);
				expect(age, `${v} ${s}`).toEqual({ timeValue: st.timeValue, timeUnit: st.timeUnit });
			}
	});

	it('keeps the comment stats it drew before store reviews existed', () => {
		// the review values come from their own stream: the TikTok / X numbers of a seed are unchanged
		expect(randomStats('x-post', 1)).toMatchObject({ rating: expect.any(Number), date: expect.any(String) });
		const a = randomStats('tiktok-comment', 7);
		const { rating: _r, date: _d, ...rest } = a;
		expect(rest).toEqual({
			timeValue: a.timeValue,
			timeUnit: a.timeUnit,
			likes: a.likes,
			replies: a.replies,
			reposts: a.reposts,
			views: a.views,
		});
	});

	it('picks titles that suit the rating', () => {
		const titles = new Set<string>();
		for (let s = 0; s < 200; s++) {
			const t = randomReviewTitle(5, s);
			expect(socialCommentParamsSchema.shape.title.safeParse(t).success).toBe(true);
			titles.add(t);
		}
		expect(titles.size).toBeGreaterThan(6);
		expect(randomReviewTitle(1, 3)).not.toBe(randomReviewTitle(5, 3));
		expect(socialCommentParamsSchema.shape.title.safeParse(randomReviewTitle(Number.NaN, 1)).success).toBe(
			true,
		);
	});

	it('fills a store review: rating, date, a title for the rating; a given date gives the age and vice versa', () => {
		const r = fillSocialParams({ variant: 'app-store-review-ios' }, 11);
		if (!r.ok) throw new Error(r.error);
		expect(r.filled).toEqual(
			expect.arrayContaining(['rating', 'date', 'title', 'edited', 'timeValue', 'timeUnit']),
		);
		// about one review in eight is "edited"; a given flag is kept
		let edited = 0;
		for (let s = 0; s < 2000; s++) {
			const f = fillSocialParams({ variant: 'app-store-review-ios' }, s);
			if (f.ok && f.params.edited) edited++;
		}
		expect(edited / 2000).toBeGreaterThan(0.08);
		expect(edited / 2000).toBeLessThan(0.16);
		const kept = fillSocialParams({ variant: 'app-store-review-ios', edited: false }, 1);
		expect(kept.ok && kept.params.edited).toBe(false);
		const byDate = fillSocialParams({ variant: 'app-store-review-ios', date: '2026-10-20' }, 3);
		if (!byDate.ok) throw new Error(byDate.error);
		expect(byDate.params).toMatchObject({ date: '2026-10-20', timeValue: 5, timeUnit: 'day' });
		const byAge = fillSocialParams({ variant: 'app-store-review-ios', timeValue: 2, timeUnit: 'week' }, 3);
		if (!byAge.ok) throw new Error(byAge.error);
		expect(byAge.params).toMatchObject({ date: '2026-10-11', timeValue: 2, timeUnit: 'week' });
		// a 1-star review gets a 1-star title
		const one = fillSocialParams({ variant: 'app-store-review', rating: 1 }, 9);
		if (!one.ok) throw new Error(one.error);
		expect([...Array(50).keys()].map((s) => randomReviewTitle(1, s))).toContain(one.params.title);
		// given values are kept
		const given = fillSocialParams(
			{ variant: 'play-store-review', rating: 2, date: '2019-03-04', title: '' },
			1,
		);
		if (!given.ok) throw new Error(given.error);
		expect(given.params).toMatchObject({ rating: 2, date: '2019-03-04', title: '' });
		// invalid review values are refused, never thrown
		expect(fillSocialParams({ rating: 6 }, 1).ok).toBe(false);
		expect(fillSocialParams({ date: '2023-02-29' }, 1).ok).toBe(false);
	});

	it('always fills to params that parse, for every variant (property)', () => {
		fc.assert(
			fc.property(
				fc.constantFrom(...SOCIAL_REVIEW_VARIANTS),
				fc.option(fc.integer({ min: 1, max: 5 }), { nil: undefined }),
				fc.option(
					fc.date({
						min: new Date('1970-01-01T00:00:00Z'),
						max: new Date('2099-12-31T00:00:00Z'),
						noInvalidDate: true,
					}),
					{ nil: undefined },
				),
				fc.integer(),
				(variant, rating, date, seed) => {
					const partial = {
						variant,
						...(rating === undefined ? {} : { rating }),
						...(date === undefined ? {} : { date: date.toISOString().slice(0, 10) }),
					};
					const r = fillSocialParams(partial, seed);
					expect(r.ok).toBe(true);
					if (r.ok) expect(socialCommentParamsSchema.safeParse(r.params).success).toBe(true);
				},
			),
		);
	});
});

describe('store review text and counts', () => {
	it('leaves @mentions and #hashtags plain (the stores do not link them)', () => {
		for (const v of SOCIAL_REVIEW_VARIANTS)
			expect(tokenizeComment('thanks @luna #fyp ==great==', v).every((s) => s.role === 'plain')).toBe(true);
		expect(tokenizeComment('thanks @luna', 'x-post').some((s) => s.role === 'mention')).toBe(true);
	});
	it('has no replies row and formats any count without throwing', () => {
		for (const v of SOCIAL_REVIEW_VARIANTS) {
			expect(formatRepliesLabel(v, 12)).toBe('');
			expect(formatCount(v, 1234567)).toBe('1,234,567');
		}
	});
});

describe('star fill (the "likes tick up" extra on store reviews)', () => {
	it('fills the stars up to the rating one after the other', () => {
		expect(socialStarFill(4, 1)).toEqual([1, 1, 1, 1, 0]);
		expect(socialStarFill(4, 0)).toEqual([0, 0, 0, 0, 0]);
		expect(socialStarFill(4, 0.5)).toEqual([1, 1, 0, 0, 0]);
		expect(socialStarFill(4, 0.625)).toEqual([1, 1, 0.5, 0, 0]);
		expect(socialStarFill(5, Number.NaN)).toEqual([0, 0, 0, 0, 0]);
		expect(socialStarFill(Number.NaN, 1)).toEqual([0, 0, 0, 0, 0]);
		fc.assert(
			fc.property(fc.integer({ min: 1, max: 5 }), fc.double({ min: 0, max: 1, noNaN: true }), (rating, p) => {
				const f = socialStarFill(rating, p);
				expect(f).toHaveLength(SOCIAL_STAR_COUNT);
				for (let i = 0; i < SOCIAL_STAR_COUNT; i++) {
					expect(f[i]).toBeGreaterThanOrEqual(0);
					expect(f[i]).toBeLessThanOrEqual(1);
					if (i > 0) expect(f[i]).toBeLessThanOrEqual(f[i - 1]!); // one by one, in order
					if (i >= rating) expect(f[i]).toBe(0);
				}
				expect(f.reduce((a, b) => a + b, 0)).toBeCloseTo(p * rating, 9);
			}),
		);
	});

	it('runs on store reviews through the like tick and shows as the stars filled so far', () => {
		for (const v of SOCIAL_REVIEW_VARIANTS) {
			expect(socialLikesTick({ variant: v, likeTick: true })).toBe(true);
			expect(socialLikesTick({ variant: v, likeTick: false })).toBe(false);
		}
		const p = { variant: 'play-store-review' as const, likes: 1393, rating: 4 };
		expect(socialTickText(p, 0)).toBe('0.00/4 stars');
		expect(socialTickText(p, 0.5)).toBe('2.00/4 stars');
		expect(socialTickText(p, 1)).toBe('4.00/4 stars');
		expect(socialTickText({ ...p, variant: 'tiktok-comment' }, 1)).toBe('1,393');
	});
});

describe('bulk import of store reviews', () => {
	const real = mgRegistry.get('social-comment', 1)!;
	const rate = { num: 30, den: 1 };
	const plan = (csv: string, preset?: string) => {
		const t = parseTable(csv);
		if (!t.ok) throw new Error(mgImportText(t.message));
		const p = planMgImport(t.table, mgImportTemplateOf(real)!, { rate, ...(preset ? { preset } : {}) });
		if (!p.ok) throw new Error(mgImportText(p.message));
		return p.plan;
	};

	it('maps Rating / Stars, Title, Date (ISO or as spreadsheets write it), Edited and the review text', () => {
		const p = plan(
			'User,Stars,Review title,Review date,Review,Edited\n' +
				'Luna Park,5,Love it,2025-09-24,Works great,no\n' +
				'Jake,2,Meh,2025/9/4 10:30,Crashes a lot,yes\n' +
				'Ana,6,Bad,2025-02-30,x,\n' +
				'Bo,4,Ok,9/24/2025,y,',
			'app-store-review-ios',
		);
		expect(p.rows[0]!.params).toEqual({
			displayName: 'Luna Park',
			rating: 5,
			title: 'Love it',
			date: '2025-09-24',
			text: 'Works great',
			edited: false,
		});
		expect(p.rows[1]!.params).toMatchObject({ rating: 2, date: '2025-09-04', edited: true });
		expect(p.rows[2]!.errors.map(mgImportText).join(' ')).toMatch(/above the maximum 5/);
		expect(p.rows[2]!.errors.map(mgImportText).join(' ')).toMatch(/"2025-02-30" is not a date/);
		// month-first / day-first dates are ambiguous: refused with the expected form
		expect(p.rows[3]!.errors.map(mgImportText).join(' ')).toMatch(
			/"9\/24\/2025" is not a date \(year-month-day/,
		);
		// the param names themselves match too
		expect(plan('Rating,Title,Date,Edited,Truncate\n3,Fine,2024-02-29,true,no').rows[0]!.params).toEqual({
			rating: 3,
			title: 'Fine',
			date: '2024-02-29',
			edited: true,
			truncate: false,
		});
	});

	it('reads date cells (property: never throws; ISO dates read back)', () => {
		fc.assert(fc.property(fc.string(), (s) => void cellIsoDate(s)));
		fc.assert(
			fc.property(
				fc.date({ min: new Date('1970-01-01'), max: new Date('2099-12-31'), noInvalidDate: true }),
				(d) => {
					const iso = d.toISOString().slice(0, 10);
					expect(cellIsoDate(iso)).toBe(iso);
					expect(cellIsoDate(`${iso}T08:00:00Z`)).toBe(iso);
				},
			),
		);
		expect(cellIsoDate('2025.9.4')).toBe('2025-09-04');
		expect(cellIsoDate('2025-9/4')).toBeNull();
		expect(cellIsoDate('24.09.2025')).toBeNull();
	});

	it('Add another on a review gives a new reviewer, rating, date and title, and keeps the text', () => {
		expect(SOCIAL_REROLL_PARAMS).toEqual(expect.arrayContaining(['rating', 'date', 'title', 'edited']));
		const ids = createCounterIdSource(1);
		const ctx = {
			ids,
			now: () => '2026-10-25T00:00:00Z',
			revision: 0,
			registries: defaultRegistries(mgRegistry),
		};
		const doc = createEmptyProject({ ids, name: 'R', preset: 'hd-1080p-30' });
		const add = applyTransaction(
			doc,
			{
				label: 'Add',
				origin: 'user',
				commands: [
					{
						type: 'clip.addMotionGraphic',
						at: 0,
						duration: 150,
						track: 'V2',
						template: { id: 'social-comment', version: 1 },
						params: { variant: 'app-store-review', title: 'Great so far', text: 'Love it', rating: 5 },
						fill: { seed: 5 },
						ref: '$c',
					},
				],
			},
			ctx,
		);
		if (!add.result.ok) throw new Error(JSON.stringify(add.result));
		const dup = applyTransaction(
			add.document,
			{
				label: 'Add Another',
				origin: 'user',
				commands: [{ type: 'clip.duplicateMotionGraphic', clipId: add.result.refs.$c!, seed: 77 }],
			},
			{ ...ctx, revision: 1 },
		);
		if (!dup.result.ok) throw new Error(JSON.stringify(dup.result));
		const r = dup.result.results[0] as { params: Record<string, unknown>; rerolled: string[] };
		expect(r.params).toMatchObject({ variant: 'app-store-review', text: 'Love it' });
		expect(r.rerolled).toEqual(expect.arrayContaining(['rating', 'date', 'title', 'displayName']));
		expect(socialCommentParamsSchema.safeParse(r.params).success).toBe(true);
	});
});
