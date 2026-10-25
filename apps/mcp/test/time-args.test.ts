// Friendly time arguments (apps/mcp/src/arguments.ts; social-comments §7.10): "3s", "1.5s", "250ms", "00:03",
// "1:02:03" next to frames, {frames}, {seconds} and timecode. Property tests: the parser never throws, its forms
// round-trip, and no string is both a friendly time and a timecode.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { normalizeTimeArg, parseFriendlyTime, TimeArgSchema } from '../src/arguments.ts';

const TIMECODE = /^-?\d{1,3}[:;]\d{1,2}[:;]\d{1,2}[:;.]\d{1,3}$/;
const two = (n: number) => String(n).padStart(2, '0');

describe('parseFriendlyTime', () => {
	it('reads the documented forms', () => {
		expect(parseFriendlyTime('3s')).toBe(3);
		expect(parseFriendlyTime('1.5s')).toBe(1.5);
		expect(parseFriendlyTime('250ms')).toBe(0.25);
		expect(parseFriendlyTime('00:03')).toBe(3);
		expect(parseFriendlyTime('2:30')).toBe(150);
		expect(parseFriendlyTime('90:00')).toBe(5400);
		expect(parseFriendlyTime('1:02:03')).toBe(3723);
		expect(parseFriendlyTime('-2s')).toBe(-2);
		expect(parseFriendlyTime('-0s')).toBe(0);
		expect(Object.is(parseFriendlyTime('-0:00'), 0)).toBe(true);
	});

	it('rejects ambiguous and malformed strings', () => {
		for (const s of [
			'',
			'3',
			'90',
			'3 s',
			's',
			'.5s',
			'1e3s',
			'3S',
			'3sec',
			'00:60',
			'0:3',
			'1:2:3',
			'1:60:00',
			'00:03.5',
			'1:02:03.5',
			'00:00:01:00',
			'00:00:01;00',
			'+3s',
			'NaNs',
			'Infinitys',
			' 3s',
			'3s ',
		])
			expect(parseFriendlyTime(s), s).toBeNull();
	});

	it('never throws and returns null or a finite number for any string', () => {
		fc.assert(
			fc.property(fc.string({ maxLength: 40 }), (s) => {
				const v = parseFriendlyTime(s);
				expect(v === null || Number.isFinite(v)).toBe(true);
			}),
			{ numRuns: 2000 },
		);
		fc.assert(
			fc.property(fc.stringMatching(/^-?[\d:.;ms]{0,14}$/), (s) => {
				const v = parseFriendlyTime(s);
				expect(v === null || Number.isFinite(v)).toBe(true);
				// a timecode is never also a friendly time (four fields are always timecode)
				if (TIMECODE.test(s)) expect(v).toBeNull();
			}),
			{ numRuns: 3000 },
		);
	});

	it('round-trips clock, second and millisecond forms', () => {
		fc.assert(
			fc.property(fc.nat(999), fc.nat(59), fc.nat(59), (h, m, s) => {
				expect(parseFriendlyTime(`${h}:${two(m)}:${two(s)}`)).toBe(h * 3600 + m * 60 + s);
			}),
		);
		fc.assert(
			fc.property(fc.nat(9999), fc.nat(59), (m, s) => {
				expect(parseFriendlyTime(`${m}:${two(s)}`)).toBe(m * 60 + s);
				expect(parseFriendlyTime(`${two(m)}:${two(s)}`)).toBe(m * 60 + s);
			}),
		);
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: 99_999_999 }),
				fc.integer({ min: 0, max: 999 }),
				(whole, milli) => {
					const text = milli ? `${whole}.${String(milli).padStart(3, '0')}` : String(whole);
					expect(parseFriendlyTime(`${text}s`)).toBeCloseTo(Number(text), 9);
					expect(parseFriendlyTime(`-${text}s`)).toBeCloseTo(-Number(text), 9);
					expect(parseFriendlyTime(`${whole}ms`)).toBeCloseTo(whole / 1000, 12);
				},
			),
		);
	});
});

describe('TimeArgSchema / normalizeTimeArg', () => {
	it('turns friendly strings into {seconds} and keeps the command forms', () => {
		expect(TimeArgSchema.parse('00:03')).toEqual({ seconds: 3 });
		expect(TimeArgSchema.parse('1.5s')).toEqual({ seconds: 1.5 });
		expect(TimeArgSchema.parse(12)).toBe(12);
		expect(TimeArgSchema.parse({ frames: 4 })).toEqual({ frames: 4 });
		expect(TimeArgSchema.parse({ seconds: 2 })).toEqual({ seconds: 2 });
		expect(TimeArgSchema.parse('00:00:01:15')).toBe('00:00:01:15');
		expect(TimeArgSchema.parse('00:00:01;15')).toBe('00:00:01;15');
		expect(TimeArgSchema.safeParse('3').success).toBe(false);
		expect(TimeArgSchema.safeParse('soon').success).toBe(false);
		expect(normalizeTimeArg('250ms')).toEqual({ seconds: 0.25 });
		expect(normalizeTimeArg('00:00:01:00')).toBe('00:00:01:00');
		expect(normalizeTimeArg(7)).toBe(7);
		expect(normalizeTimeArg({ seconds: 1 })).toEqual({ seconds: 1 });
	});

	it('never throws on arbitrary JSON input', () => {
		fc.assert(
			fc.property(fc.jsonValue(), (v) => {
				const r = TimeArgSchema.safeParse(v);
				if (r.success && typeof v === 'string' && !TIMECODE.test(v))
					expect(r.data).toEqual({ seconds: parseFriendlyTime(v) });
				expect(() => normalizeTimeArg(v)).not.toThrow();
			}),
			{ numRuns: 1000 },
		);
	});
});
