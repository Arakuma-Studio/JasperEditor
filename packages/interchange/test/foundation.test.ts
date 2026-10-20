import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { fileUrlToPath, pathToFileUrl, relativePath, resolvePath } from '../src/paths.ts';
import {
	flicksToFrames,
	flicksToRationalSeconds,
	flicksToTicks,
	framesToFlicks,
	rateFromFloat,
	rateFromTimebase,
	rationalSecondsToFlicks,
	ticksToFlicks,
	timebaseOf,
} from '../src/time.ts';
import { child, childText, parseXml, text, XmlError, XmlWriter } from '../src/xml.ts';

describe('time', () => {
	it('converts independent frame, Premiere tick and rational-second examples exactly', () => {
		const rate = { num: 24000, den: 1001 };
		expect(framesToFlicks(1, rate)).toBe(29_429_400);
		expect(flicksToFrames(29_429_400, rate)).toBe(1);
		expect(flicksToTicks(29_429_400)).toBe('10594584000');
		expect(ticksToFlicks('914457600000000')).toEqual({ flicks: 2_540_160_000_000, exact: true });
		expect(rationalSecondsToFlicks(1001n, 24000n)).toEqual({ flicks: 29_429_400, exact: true });
		expect(flicksToRationalSeconds(29_429_400)).toEqual([1001n, 24000n]);
	});
	it('timebase and float rates snap to exact rationals', () => {
		expect(rateFromTimebase(24, true)).toEqual({ num: 24000, den: 1001 });
		expect(rateFromTimebase(60, true)).toEqual({ num: 60000, den: 1001 });
		expect(timebaseOf({ num: 30000, den: 1001 })).toEqual({ timebase: 30, ntsc: true });
		expect(rateFromFloat(23.976023976023978)).toEqual({ num: 24000, den: 1001 });
		expect(rateFromFloat(29.97)).toEqual({ num: 30000, den: 1001 });
		expect(rateFromFloat(25)).toEqual({ num: 25, den: 1 });
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
