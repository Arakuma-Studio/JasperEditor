import { describe, expect, it } from 'vitest';

import { laserHead, muzzleTiming } from '../src/registry/fx/sapphire-render-lightning/render-light.ts';
import {
	julianDay,
	lunarPhaseDeg,
	nightSkyMatrix,
} from '../src/registry/fx/sapphire-render-lightning/render-sky.ts';

describe('S_LaserBeam and S_MuzzleFlash timing', () => {
	it('Use Time flies the beam head from the start over Duration (+ Length)', () => {
		const p = { useTime: true, startTime: 10, flightDuration: 20, length: 0.5, position: 0.3 };
		expect(laserHead(p, { frame: 10 })).toBe(0);
		expect(laserHead(p, { frame: 30 })).toBeCloseTo(1.5);
		expect(laserHead({ ...p, useTime: false }, { frame: 30 })).toBe(0.3);
	});

	it('Repeat flashes every Gap Time frames inside Duration; Repeat+Fade fades over Fade Time', () => {
		const p = { timeMode: 'repeat', startTime: 2, flashDuration: 10, gapTime: 3, fadeTime: 2 };
		expect([1, 2, 3, 4, 5, 11, 12].map((f) => muzzleTiming(p, f).vis)).toEqual([0, 1, 0, 0, 1, 1, 0]);
		const f = { ...p, timeMode: 'repeatFade' };
		expect([2, 3, 4].map((x) => muzzleTiming(f, x).vis)).toEqual([1, 0.5, 0]);
		expect(muzzleTiming({ timeMode: 'always' }, 7).vis).toBe(1);
		expect(muzzleTiming(p, 8).index).toBe(2);
	});
});

describe('astronomy', () => {
	it('Julian day of the J2000 epoch and the lunar phase of a known full moon', () => {
		expect(julianDay(2000, 1, 1, 12)).toBeCloseTo(2451545.0, 6);
		// full moon 2020-03-09 17:48 UTC; new moon 2020-03-24 09:28 UTC (mean phase within ~10°)
		const full = lunarPhaseDeg(julianDay(2020, 3, 9, 17.8));
		expect(Math.abs(full - 180)).toBeLessThan(12);
		const nw = lunarPhaseDeg(julianDay(2020, 3, 24, 9.47));
		expect(Math.min(nw, 360 - nw)).toBeLessThan(12);
	});

	it('the sky matrix points a camera at altitude = latitude, azimuth 0 to the celestial pole', () => {
		for (const lat of [42.3, -20, 60]) {
			const m = nightSkyMatrix({ latitude: lat, altitude: lat, azimuth: 0, hour: 3, minute: 17 });
			const f = m.slice(6, 9);
			// the north celestial pole sits at altitude = latitude due north (below the horizon south of the equator)
			expect(f[2]).toBeCloseTo(1, 6);
			const cols = [m.slice(0, 3), m.slice(3, 6), f];
			for (const c of cols) expect(Math.hypot(c[0]!, c[1]!, c[2]!)).toBeCloseTo(1, 9);
		}
	});

	it('the sky turns by ~15° of right ascension per hour (sidereal rotation)', () => {
		const ra = (minute: number) => {
			const f = nightSkyMatrix({ latitude: 42.3, altitude: 0, azimuth: 180, minute }).slice(6, 9);
			return (Math.atan2(f[1]!, f[0]!) * 180) / Math.PI;
		};
		let d = ra(60) - ra(0);
		d = ((d + 540) % 360) - 180;
		expect(Math.abs(d)).toBeCloseTo(15.04, 1);
	});
});
