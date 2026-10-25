// keyframe-sides: per-side keyframe interpolation through the interchange formats (docs/wp-notes/keyframe-sides.md).
// FCPXML carries one-sided eases per point (interp easeIn / easeOut); OTIO keeps the JasperEditor keys whole; FCP 7
// has one interpolation per key; AAF / OMF are linear only (reported).
import type { Keyframe } from '@jasper/project';
import { describe, expect, it } from 'vitest';
import { exportFcp7 } from '../src/fcp7.ts';
import { exportFcpxml, importFcpxml } from '../src/fcpxml.ts';
import { exportOtio, importOtio } from '../src/otio.ts';
import { Report } from '../src/report.ts';
import { clip, key, media, project, sequence } from './support/ir.ts';

const R = { num: 25, den: 1 };
const EASY = { influence: 1 / 3, slope: 0 };

function withOpacityKeys(keys: Keyframe<number>[]) {
	const p = project();
	const m = media(p, '/media/a.mov', true, false, R, 400);
	const sid = sequence(p, 'Seq', R);
	const c = clip(p, sid, 'video', 0, m, 0, 200, 0);
	c.opacity = { value: keys[0]!.value, keyframes: keys };
	return { p, sid };
}

const F = 705_600_000 / 25;
const sided = (): Keyframe<number>[] => [
	key(0, 0, 'linear'),
	{ ...key(50 * F, 100, 'linear'), inInterpolation: 'bezier', easeIn: { ...EASY } },
	{ ...key(100 * F, 40, 'bezier'), inInterpolation: 'linear', easeOut: { ...EASY } },
	{ ...key(150 * F, 80, 'linear'), inInterpolation: 'linear' },
];

describe('keyframe-sides interchange', () => {
	it('FCPXML: one-sided eases are written as easeIn / easeOut points and read back per side', () => {
		const { p, sid } = withOpacityKeys(sided());
		const text = exportFcpxml(p, sid, {}, new Report());
		const interps = [...text.matchAll(/<keyframe [^>]*interp="(\w+)"/g)].map((m) => m[1]);
		expect(interps).toEqual(['linear', 'easeIn', 'easeOut', 'linear']);
		const back = importFcpxml(text, {}, new Report());
		const s = back.sequences[back.top[0]!]!;
		const kfs = s.video[0]!.clips[0]!.opacity!.keyframes;
		expect(kfs.map((k) => [k.interpolation, k.inInterpolation])).toEqual([
			['linear', undefined],
			['linear', 'bezier'],
			['bezier', 'linear'],
			['linear', 'linear'],
		]);
		expect(kfs[1]!.easeIn).toEqual(EASY);
		expect(kfs[2]!.easeOut).toEqual(EASY);
	});

	it('FCPXML: documents without per-side keys export exactly as before (ease / linear)', () => {
		const { p, sid } = withOpacityKeys([
			key(0, 0, 'linear'),
			key(50 * F, 100, 'bezier'),
			key(100 * F, 20, 'linear'),
		]);
		const text = exportFcpxml(p, sid, {}, new Report());
		expect(
			[...text.matchAll(/<keyframe [^>]*interp="(\w+)" curve="(\w+)"/g)].map((m) => [m[1], m[2]]),
		).toEqual([
			['linear', 'linear'],
			['ease', 'smooth'],
			['linear', 'linear'],
		]);
	});

	it('OTIO keeps the incoming sides exactly', () => {
		const { p, sid } = withOpacityKeys(sided());
		const back = importOtio(exportOtio(p, sid, {}, new Report()), {}, new Report());
		const kfs = back.sequences[back.top[0]!]!.video[0]!.clips[0]!.opacity!.keyframes;
		expect(kfs.map((k) => k.inInterpolation)).toEqual([undefined, 'bezier', 'linear', 'linear']);
		expect(kfs.map((k) => k.easeIn)).toEqual(sided().map((k) => k.easeIn));
	});

	it('FCP 7: an Ease In key is still written as a curve and the lost sides are reported', () => {
		const { p, sid } = withOpacityKeys(sided());
		const report = new Report();
		const text = exportFcp7(p, sid, {}, report);
		expect(text.match(/<name>FCPCurve<\/name>/g)?.length).toBe(2);
		expect(JSON.stringify(report.entries)).toContain('Separate incoming / outgoing keyframe interpolation');
	});
});
