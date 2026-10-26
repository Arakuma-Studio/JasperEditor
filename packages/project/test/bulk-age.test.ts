// Ages in one cell for the motion-graphic bulk import (`parseAgeCell`, `ui.import.age`; docs/wp-notes/
// social-comments.md "Bulk import", App QA N4): "3h", "2 weeks", "10 months", "1y", "5 min", "just now" in a `Time` /
// `Age` / `Ago` / `Posted` column → a count param and a unit param; the separate-columns form keeps working.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
	AGE_UNITS,
	type AgeUnit,
	type MgImportTemplate,
	mgImportText,
	parseAgeCell,
	parseTable,
	planMgImport,
} from '../src/index.ts';

const UNITS = ['minute', 'hour', 'day', 'week', 'month', 'year'] as const;
const schema = z.strictObject({
	text: z.string().max(400),
	timeValue: z.number().int().min(0).max(9999),
	timeUnit: z.enum(UNITS),
	likes: z.number().int().min(0),
});
const template = (age: unknown = { value: 'timeValue', unit: 'timeUnit', columns: ['Time', 'Age'] }) =>
	({
		id: 'card',
		version: 1,
		name: 'Card',
		paramsSchema: z.toJSONSchema(schema, { unrepresentable: 'any', io: 'input' }),
		defaults: { text: 'Hi', timeValue: 1, timeUnit: 'day', likes: 0 },
		ui: {
			params: { text: { label: 'Comment' }, timeValue: { label: 'Posted' }, timeUnit: { label: 'Unit' } },
			import: { aliases: { Ago: 'timeValue', 'Time unit': 'timeUnit' }, ...(age ? { age } : {}) },
		},
	}) as MgImportTemplate;
const rate = { num: 30, den: 1 };

function table(csv: string) {
	const t = parseTable(csv);
	if (!t.ok) throw new Error(mgImportText(t.message));
	return t.table;
}

function plan(csv: string, t = template()) {
	const r = planMgImport(table(csv), t, { rate });
	if (!r.ok) throw new Error(mgImportText(r.message));
	return r.plan;
}

describe('parseAgeCell', () => {
	it('reads platform and typed spellings', () => {
		const cases: [string, number, AgeUnit | null][] = [
			['3h', 3, 'hour'],
			['3 h', 3, 'hour'],
			['3hrs', 3, 'hour'],
			['3 hours ago', 3, 'hour'],
			['2 weeks', 2, 'week'],
			['2w', 2, 'week'],
			['10 months', 10, 'month'],
			['10mo', 10, 'month'],
			['1y', 1, 'year'],
			['1 Year Ago', 1, 'year'],
			['5 min', 5, 'minute'],
			['5m', 5, 'minute'],
			['5 min.', 5, 'minute'],
			['45s', 45, 'second'],
			['4d', 4, 'day'],
			['an hour ago', 1, 'hour'],
			['a day ago', 1, 'day'],
			['yesterday', 1, 'day'],
			['last week', 1, 'week'],
			['just now', 0, null],
			['Now', 0, null],
			['  JUST   NOW ', 0, null],
		];
		for (const [text, value, unit] of cases) expect(parseAgeCell(text), text).toEqual({ value, unit });
	});

	it('is null for what is not an age (a bare number has no unit)', () => {
		for (const text of [
			'',
			'3',
			'1.5h',
			'soon',
			'h',
			'3 parsecs',
			'-3h',
			'3h 20m',
			'x'.repeat(200),
			'1234567890h',
		])
			expect(parseAgeCell(text), text).toBeNull();
	});

	it('never throws and round-trips every spelling (fast-check)', () => {
		fc.assert(
			fc.property(fc.string({ maxLength: 60 }), (s) => {
				const r = parseAgeCell(s);
				if (r) {
					expect(Number.isSafeInteger(r.value) && r.value >= 0).toBe(true);
					expect(r.unit === null || AGE_UNITS.includes(r.unit)).toBe(true);
				}
			}),
			{ numRuns: 2000 },
		);
		const SPELLINGS: Record<AgeUnit, string[]> = {
			second: ['s', 'sec', 'secs', 'second', 'seconds'],
			minute: ['m', 'min', 'mins', 'minute', 'minutes'],
			hour: ['h', 'hr', 'hrs', 'hour', 'hours'],
			day: ['d', 'day', 'days'],
			week: ['w', 'wk', 'wks', 'week', 'weeks'],
			month: ['mo', 'mos', 'mon', 'mth', 'month', 'months'],
			year: ['y', 'yr', 'yrs', 'year', 'years'],
		};
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: 999_999_999 }),
				fc.constantFrom(...AGE_UNITS),
				fc.nat(),
				fc.boolean(),
				fc.boolean(),
				fc.boolean(),
				(value, unit, pick, space, ago, upper) => {
					const words = SPELLINGS[unit];
					let text = `${value}${space ? ' ' : ''}${words[pick % words.length]}${ago ? ' ago' : ''}`;
					if (upper) text = text.toUpperCase();
					expect(parseAgeCell(text)).toEqual({ value, unit });
				},
			),
			{ numRuns: 1000 },
		);
	});
});

describe('age columns in the import plan', () => {
	it('one Time / Age / Ago / Posted cell fills the count and the unit', () => {
		for (const header of ['Time', 'Age', 'Ago', 'Posted', 'timeValue', 'time_value']) {
			const p = plan(`Comment,${header}\nA,3h\nB,2 weeks\nC,10 months ago\nD,1y\nE,5 min\nF,just now`);
			expect(p.columns[1]).toMatchObject({ kind: 'param', param: 'timeValue' });
			expect(p.rows.map((r) => r.params)).toEqual([
				{ text: 'A', timeValue: 3, timeUnit: 'hour' },
				{ text: 'B', timeValue: 2, timeUnit: 'week' },
				{ text: 'C', timeValue: 10, timeUnit: 'month' },
				{ text: 'D', timeValue: 1, timeUnit: 'year' },
				{ text: 'E', timeValue: 5, timeUnit: 'minute' },
				{ text: 'F', timeValue: 0 },
			]);
			expect(p.rows.every((r) => r.errors.length === 0)).toBe(true);
			expect(p.rows[0]!.sources).toEqual({ text: 0, timeValue: 1, timeUnit: 1 });
		}
	});

	it('keeps the separate-columns form (a bare count plus a unit column)', () => {
		const p = plan('Comment,Ago,Time unit\nA,3,day\nB,2 weeks,\nC,4,');
		expect(p.rows.map((r) => r.params)).toEqual([
			{ text: 'A', timeValue: 3, timeUnit: 'day' },
			{ text: 'B', timeValue: 2, timeUnit: 'week' },
			{ text: 'C', timeValue: 4 },
		]);
	});

	it('a unit column wins over the unit of an age cell (warning)', () => {
		const p = plan('Comment,Time,Unit\nA,3h,day\nB,3h,hour');
		expect(p.rows[0]!.params).toEqual({ text: 'A', timeValue: 3, timeUnit: 'day' });
		expect(p.rows[0]!.warnings.map(mgImportText)).toEqual([
			'Time: The unit of "3h" is not used: the row already sets timeUnit',
		]);
		expect(p.rows[1]!.warnings).toEqual([]);
	});

	it('reports cells that are not ages, units the template does not offer and counts out of range', () => {
		const p = plan('Comment,Time\nA,soon\nB,45s\nC,12000h\nD,1.5h');
		expect(p.rows.map((r) => r.errors.map(mgImportText))).toEqual([
			['Time: "soon" is not an age (3h, 2 weeks, 10 months, 1y, 5 min, just now)'],
			['Time: "45s": the unit second is not offered (use minute, hour, day, week, month, year)'],
			['Time: 12000 is above the maximum 9999'],
			['Time: "1.5h" is not an age (3h, 2 weeks, 10 months, 1y, 5 min, just now)'],
		]);
		expect(p.rows.every((r) => !('timeValue' in r.params))).toBe(true);
	});

	it('without the hint (or with a broken one) the column is what it was: Time unknown, Posted a count', () => {
		for (const age of [
			undefined,
			{ value: 'nope', unit: 'timeUnit' },
			{ value: 'timeValue', unit: 'timeValue' },
		]) {
			const p = plan('Comment,Time,Posted\nA,3h,3h', template(age ?? null));
			expect(p.columns[1]).toMatchObject({ kind: 'ignored' });
			expect(p.rows[0]!.errors.map(mgImportText)).toEqual(['Posted: "3h" is not a number']);
		}
	});

	it('the planner never throws on arbitrary age cells (fast-check)', () => {
		fc.assert(
			fc.property(
				fc.array(fc.tuple(fc.string({ maxLength: 30 }), fc.string({ maxLength: 12 })), {
					minLength: 1,
					maxLength: 8,
				}),
				(rows) => {
					const r = planMgImport(
						{ ...table('x'), records: [['Time', 'Unit'], ...rows.map((x) => [...x])] },
						template(),
						{
							rate,
						},
					);
					expect(r.ok).toBe(true);
					if (r.ok)
						for (const row of r.plan.rows) {
							const v = row.params.timeValue;
							if (v !== undefined)
								expect(Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 9999).toBe(true);
							const u = row.params.timeUnit;
							if (u !== undefined) expect(UNITS).toContain(u);
						}
				},
			),
			{ numRuns: 300 },
		);
	});
});
