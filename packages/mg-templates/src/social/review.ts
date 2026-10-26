// Store review cards (design §11): calendar dates, the star rating and the review date formats of Google Play and the
// App Store. Pure, deterministic and locale-independent (no `Intl`, no clock) like format.ts. Rules and sources:
// docs/wp-notes/social-comments.md "Store reviews".

/** Lowest and highest star rating. */
export const SOCIAL_RATING_MIN = 1;
export const SOCIAL_RATING_MAX = 5;

/** Years a review date may have (both stores opened in 2008; the range leaves room on both sides). */
export const SOCIAL_DATE_MIN_YEAR = 1970;
export const SOCIAL_DATE_MAX_YEAR = 2099;

/**
 * The fixed "today" of store reviews (no wall clock: the same params give the same card on every machine and day):
 * random review dates are drawn back from it, and the iPhone card's weekday ages count back from it. The date this
 * feature was built (a Sunday).
 */
export const SOCIAL_REVIEW_DATE_ANCHOR = '2026-10-25';

/** `YYYY-MM-DD`. */
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;

export type CalendarDate = { year: number; month: number; day: number };

const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/** Days in `month` (1–12) of `year`. */
export function daysInMonth(year: number, month: number): number {
	if (month === 2) return isLeap(year) ? 29 : 28;
	return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/**
 * The calendar date of an ISO `YYYY-MM-DD` string, or null when it is not one or not a real date (month 1–12, the
 * day within the month, leap years included, year 1970–2099). Never throws.
 */
export function parseReviewDate(value: unknown): CalendarDate | null {
	if (typeof value !== 'string') return null;
	const m = ISO_DATE.exec(value);
	if (!m) return null;
	const year = Number(m[1]);
	const month = Number(m[2]);
	const day = Number(m[3]);
	if (year < SOCIAL_DATE_MIN_YEAR || year > SOCIAL_DATE_MAX_YEAR) return null;
	if (month < 1 || month > 12) return null;
	if (day < 1 || day > daysInMonth(year, month)) return null;
	return { year, month, day };
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** `YYYY-MM-DD` of a calendar date. */
export function isoDate(d: CalendarDate): string {
	return `${String(d.year).padStart(4, '0')}-${pad2(d.month)}-${pad2(d.day)}`;
}

const DAY_MS = 86_400_000;

/** Days since 1970-01-01 of a calendar date (UTC arithmetic: no time zone, no clock). */
export function dayNumber(d: CalendarDate): number {
	return Math.round(Date.UTC(d.year, d.month - 1, d.day) / DAY_MS);
}

/** The calendar date `days` after 1970-01-01 (UTC arithmetic). */
export function dateOfDayNumber(days: number): CalendarDate {
	const t = new Date(Math.floor(days) * DAY_MS);
	return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
}

/** Day of the week of a calendar date: 0 = Sunday … 6 = Saturday. */
export function weekday(d: CalendarDate): number {
	return (((dayNumber(d) + 4) % 7) + 7) % 7;
}

/**
 * A review date as the card prints it (US English, as the requester's screenshots):
 * - Google Play: `M/D/YY` without leading zeros ("11/6/18");
 * - App Store web / macOS: `MM/DD/YYYY` ("09/24/2021").
 * An invalid date prints as an empty string (the card then shows none). Never throws.
 */
export function formatReviewDate(style: 'play-store' | 'app-store', iso: unknown): string {
	const d = parseReviewDate(iso);
	if (!d) return '';
	if (style === 'play-store') return `${d.month}/${d.day}/${pad2(d.year % 100)}`;
	return `${pad2(d.month)}/${pad2(d.day)}/${d.year}`;
}

/** A rating clamped to 1–5 whole stars (non-numbers read as 5: a missing value never shows an empty card). */
export function clampRating(rating: unknown): number {
	if (typeof rating !== 'number' || !Number.isFinite(rating)) return SOCIAL_RATING_MAX;
	return Math.min(SOCIAL_RATING_MAX, Math.max(SOCIAL_RATING_MIN, Math.round(rating)));
}

/** Days an age spans: minutes and hours are the same day; weeks 7, months 30 and years 365 days. Never negative. */
export function reviewAgeDays(value: number, unit: string): number {
	const v = typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
	switch (unit) {
		case 'day':
			return v;
		case 'week':
			return v * 7;
		case 'month':
			return v * 30;
		case 'year':
			return v * 365;
		default:
			return 0;
	}
}

/** Short English weekday names as the iPhone App Store prints them, Sunday first. */
export const IOS_WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/** The weekday of the day `daysAgo` days before `SOCIAL_REVIEW_DATE_ANCHOR` ("Sun" for 0: the anchor is a Sunday). */
export function weekdayBeforeAnchor(daysAgo: number): string {
	const anchor = parseReviewDate(SOCIAL_REVIEW_DATE_ANCHOR) as CalendarDate;
	const day = dayNumber(anchor) - Math.max(0, Math.floor(Number.isFinite(daysAgo) ? daysAgo : 0));
	return IOS_WEEKDAYS[weekday(dateOfDayNumber(day))]!;
}
