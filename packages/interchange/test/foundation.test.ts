import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { fileUrlToPath, pathToFileUrl, relativePath, resolvePath } from '../src/paths.ts';
import {
	flicksToFrames,
	flicksToRationalSeconds,
	flicksToTicks,
	formatTc,
	framesToFlicks,
	parseTc,
	rateFromFloat,
	rateFromTimebase,
	rationalSecondsToFlicks,
	ticksToFlicks,
	timebaseOf,
} from '../src/time.ts';
import { child, childText, parseXml, text, XmlError, XmlWriter } from '../src/xml.ts';
import { ALL_RATES, arbProject, BASIC } from './support/arbitraries.ts';

describe('time', () => {
	it('frames, ticks and rational seconds are exact at every broadcast rate', () => {
		for (const { rate } of ALL_RATES) {
			for (const f of [0, 1, 1799, 107892, 2_589_408]) {
				const t = framesToFlicks(f, rate);
				expect(flicksToFrames(t, rate)).toBe(f);
				const tk = flicksToTicks(t);
				expect(ticksToFlicks(tk)).toEqual({ flicks: t, exact: true });
				const [n, d] = flicksToRationalSeconds(t);
				expect(rationalSecondsToFlicks(n, d)).toEqual({ flicks: t, exact: true });
			}
		}
		// Premiere: one frame at 23.976 is 10 594 584 000 ticks.
		expect(flicksToTicks(framesToFlicks(1, { num: 24000, den: 1001 }))).toBe('10594584000');
		expect(ticksToFlicks('914457600000000')!.flicks).toBe(705_600_000 * 3600);
	});
	it('timebase and float rates snap to exact rationals', () => {
		expect(rateFromTimebase(24, true)).toEqual({ num: 24000, den: 1001 });
		expect(rateFromTimebase(60, true)).toEqual({ num: 60000, den: 1001 });
		expect(timebaseOf({ num: 30000, den: 1001 })).toEqual({ timebase: 30, ntsc: true });
		expect(rateFromFloat(23.976023976023978)).toEqual({ num: 24000, den: 1001 });
		expect(rateFromFloat(29.97)).toEqual({ num: 30000, den: 1001 });
		expect(rateFromFloat(25)).toEqual({ num: 25, den: 1 });
	});
	it('drop-frame timecode round-trips', () => {
		const r = { num: 30000, den: 1001 };
		expect(formatTc(1800, r, true)).toBe('00;01;00;02');
		expect(parseTc('00;01;00;02', r)).toBe(1800);
		const r60 = { num: 60000, den: 1001 };
		fc.assert(
			fc.property(fc.integer({ min: 0, max: 5_000_000 }), (f) => parseTc(formatTc(f, r60, true), r60) === f),
		);
	});
});

describe('paths', () => {
	it('file URLs round-trip', () => {
		expect(fileUrlToPath('file://localhost/Users/me/My%20Clip.mov')).toBe('/Users/me/My Clip.mov');
		expect(fileUrlToPath('file:///C:/Media/a.mxf')).toBe('C:/Media/a.mxf');
		expect(pathToFileUrl('C:\\Media\\a b.mxf')).toBe('file:///C:/Media/a%20b.mxf');
		for (const p of ['/a/b c/ü.mov', 'C:/x/y.mp4', '/r/%/#?.mov'])
			for (const lh of [true, false]) expect(fileUrlToPath(pathToFileUrl(p, lh))).toBe(p);
		expect(resolvePath('media/a.mov', '/proj')).toBe('/proj/media/a.mov');
		expect(resolvePath('../a.mov', '/proj/x/')).toBe('/proj/a.mov');
		expect(relativePath('/proj/a.mov', '/proj/edl')).toBe('../a.mov');
	});
});

describe('xml', () => {
	it('parses and writes', () => {
		const w = new XmlWriter({ doctype: 'xmeml' });
		w.open('xmeml', [['version', 4]])
			.text('name', 'A & <B> "c"')
			.open('x')
			.empty('y', [['a', 'q"\n']])
			.close()
			.close();
		const doc = parseXml(w.finish());
		expect(doc.name).toBe('xmeml');
		expect(childText(doc, 'name')).toBe('A & <B> "c"');
		expect(child(child(doc, 'x'), 'y')!.attrs.a).toBe('q" ');
		expect(text(parseXml('<a><![CDATA[x<y]]>&#x41;&#66;</a>'))).toBe('x<yAB');
	});
	it('never throws anything but XmlError on garbage', () => {
		fc.assert(
			fc.property(fc.string({ maxLength: 200 }), (s) => {
				try {
					parseXml(`<a>${s}`);
				} catch (e) {
					expect(e).toBeInstanceOf(XmlError);
				}
			}),
		);
		expect(() => parseXml('<a>'.repeat(10000))).toThrow(XmlError);
	});
});

describe('arbitraries', () => {
	it('generate valid projects', () => {
		fc.assert(
			fc.property(
				arbProject({
					...BASIC,
					transform: true,
					transitions: true,
					links: true,
					nested: true,
					generators: true,
				}),
				(p) => {
					for (const s of Object.values(p.sequences))
						for (const t of [...s.video, ...s.audio])
							for (let i = 1; i < t.clips.length; i++)
								expect(t.clips[i]!.start).toBeGreaterThanOrEqual(
									t.clips[i - 1]!.start + t.clips[i - 1]!.duration,
								);
				},
			),
			{ numRuns: 50 },
		);
	});
});
