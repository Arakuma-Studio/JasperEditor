import { describe, expect, it } from 'vitest';
import {
	ALLOWED_SEQUENCE_RATES,
	contentSpanFlicks,
	createCounterIdSource,
	createEmptyProject,
	createRandomIdSource,
	createSeededIdSource,
	FLICKS_PER_SECOND,
	flicksPerFrame,
	flicksToFrames,
	formatTimecode,
	framesToFlicks,
	isValidId,
	mapFrameBetweenRates,
	nearestAllowedRate,
	parseTimecode,
	parseTimecodeEntry,
	RATES,
	secondsToFlicks,
	secondsToFrames,
} from '../src/index.ts';

const FUZZ = process.env.FUZZ === '1';

describe('ids (S01:ID-001)', () => {
	it('generates prefixed 16-char Crockford ids', () => {
		const rnd = createRandomIdSource();
		const id = rnd.next('clp');
		expect(id).toMatch(/^clp_[0-9A-HJKMNP-TV-Z]{16}$/);
		expect(isValidId(id, 'clp')).toBe(true);
		expect(isValidId(id, 'trk')).toBe(false);
		const set = new Set(Array.from({ length: 1000 }, () => rnd.next('fx')));
		expect(set.size).toBe(1000);
	});
	it('seeded ids are deterministic', () => {
		const a = createSeededIdSource(42);
		const b = createSeededIdSource(42);
		expect([a.next('seq'), a.next('trk')]).toEqual([b.next('seq'), b.next('trk')]);
		expect(createCounterIdSource().next('clp')).toBe('clp_0000000000000001');
	});
});

describe('flicks (S01:TIME-001…007)', () => {
	it('F(r) is an integer for every allowed sequence rate', () => {
		for (const r of ALLOWED_SEQUENCE_RATES) expect(Number.isInteger(flicksPerFrame(r))).toBe(true);
		expect(flicksPerFrame(RATES.r29_97)).toBe(23_543_520);
		expect(flicksPerFrame(RATES.r30)).toBe(23_520_000);
	});
	it('converts frames, flicks and seconds', () => {
		for (const r of ALLOWED_SEQUENCE_RATES) {
			for (const f of [0, 1, 29, 1799, 107_892, 2_589_408]) {
				expect(flicksToFrames(framesToFlicks(f, r), r)).toBe(f);
				expect(flicksToFrames(framesToFlicks(f, r) + flicksPerFrame(r) - 1, r, 'floor')).toBe(f);
			}
		}
		expect(secondsToFlicks(2)).toBe(2 * FLICKS_PER_SECOND);
		expect(secondsToFrames(1.02, RATES.r25)).toBe(26);
		expect(contentSpanFlicks(10, RATES.r30, 0.5)).toBe(5 * flicksPerFrame(RATES.r30));
	});
	it('maps frames between rates monotonically (S01:SEQ-006)', () => {
		expect(mapFrameBetweenRates(30, RATES.r30, RATES.r25)).toBe(25);
		expect(mapFrameBetweenRates(1, RATES.r30, RATES.r25)).toBe(1);
		let prev = -1;
		for (let f = 0; f < 500; f++) {
			const m = mapFrameBetweenRates(f, RATES.r30, RATES.r25);
			expect(m).toBeGreaterThanOrEqual(prev);
			prev = m;
		}
	});
	it('rounds media rates to the nearest allowed rate', () => {
		expect(nearestAllowedRate(29.97)).toEqual(RATES.r29_97);
		expect(nearestAllowedRate({ num: 15, den: 1 })).toEqual(RATES.r23_976);
		expect(nearestAllowedRate(59.9)).toEqual(RATES.r59_94);
	});
});

describe('timecode (S02 Appendix A.1)', () => {
	it('AC-01: new 1080p 29.97 project is drop-frame with V1–V3/A1–A3 and frame 1800 = 00;01;00;02', () => {
		const doc = createEmptyProject({ ids: createSeededIdSource(1), name: 'P', preset: 'hd-1080p-29.97' });
		const seq = Object.values(doc.sequences)[0]!;
		expect(seq.settings.frameRate).toEqual({ num: 30000, den: 1001 });
		expect(seq.settings.dropFrame).toBe(true);
		expect(seq.videoTracks).toHaveLength(3);
		expect(seq.audioTracks).toHaveLength(3);
		expect(Object.keys(seq.clips)).toHaveLength(0);
		expect(formatTimecode(1800, seq.settings.frameRate, { dropFrame: true })).toBe('00;01;00;02');
		expect(Object.values(doc.items).filter((i) => i.kind === 'sequence')).toHaveLength(1);
	});
	it('formats non-drop and drop-frame timecode', () => {
		expect(formatTimecode(0, RATES.r30)).toBe('00:00:00:00');
		expect(formatTimecode(45, RATES.r30)).toBe('00:00:01:15');
		expect(formatTimecode(17982, RATES.r29_97, { dropFrame: true })).toBe('00;10;00;00');
		expect(formatTimecode(1799, RATES.r29_97, { dropFrame: true })).toBe('00;00;59;29');
		expect(formatTimecode(3600, RATES.r59_94, { dropFrame: true })).toBe('00;01;00;04');
		expect(formatTimecode(-15, RATES.r25)).toBe('-00:00:00:15');
		expect(formatTimecode(0, RATES.r25, { startFrames: 90000 })).toBe('01:00:00:00');
	});
	it('normalizes invalid drop-frame labels to the next valid frame', () => {
		expect(parseTimecode('00;01;00;00', RATES.r29_97, { dropFrame: true })).toBe(1800);
		expect(parseTimecode('00;01;00;01', RATES.r29_97, { dropFrame: true })).toBe(1800);
	});
	const sweep = (rate: typeof RATES.r29_97) => {
		const total = Math.round((24 * 3600 * rate.num) / rate.den);
		const step = FUZZ ? 1 : 97;
		const check = (f: number) => {
			const tc = formatTimecode(f, rate, { dropFrame: true });
			if (parseTimecode(tc, rate, { dropFrame: true }) !== f) throw new Error(`round trip failed at ${f}: ${tc}`);
		};
		for (let f = 0; f < total; f += step) check(f);
		// Minute boundaries are where drop-frame bugs live: always check them densely.
		const perMin = rate.num === 30000 ? 1798 : 3596;
		for (let m = 1; m < 24 * 60; m++) for (let k = -3; k <= 3; k++) check(Math.max(0, Math.round(m * perMin + Math.floor(m / 10) * (rate.num === 30000 ? 2 : 4)) + k));
		check(total - 1);
	};
	it(`drop-frame round-trips over 24 h at 29.97 (${FUZZ ? 'every frame' : 'sampled'})`, () => sweep(RATES.r29_97));
	it(`drop-frame round-trips over 24 h at 59.94 (${FUZZ ? 'every frame' : 'sampled'})`, () => sweep(RATES.r59_94));
	it('non-drop round-trips', () => {
		for (const r of [RATES.r24, RATES.r25, RATES.r30, RATES.r60, RATES.r23_976]) {
			for (let f = 0; f < 200_000; f += 331) expect(parseTimecode(formatTimecode(f, r), r)).toBe(f);
		}
	});
	it('parses partial entries (S02:TL-205, S05:TY-006)', () => {
		const ctx = { current: 100 };
		const p = (s: string) => parseTimecodeEntry(s, RATES.r30, ctx);
		expect(p('115')).toBe(45);
		expect(p('1510')).toBe(460);
		expect(p('1.')).toBe(30);
		expect(p('1..')).toBe(1800);
		expect(p('#120')).toBe(120);
		expect(p('+15')).toBe(115);
		expect(p('-15')).toBe(85);
		expect(p('-1:00')).toBe(70);
		expect(p('+1.')).toBe(130);
		expect(p('00:00:02:00')).toBe(60);
		expect(p('-10:00')).toBe(0);
		expect(p('abc')).toBeNull();
		expect(p('#x')).toBeNull();
		expect(parseTimecodeEntry('1..', RATES.r29_97, { current: 0, dropFrame: true })).toBe(1800);
	});
});
