import { describe, expect, it } from 'vitest';
import type { EffectSpec } from '../src/index.ts';

import { strobeOn } from '../src/registry/fx/premiere-stylize-distort-generate/stylize-2.ts';
import {
	echoIntensity,
	echoOffsets,
	posterizeTimeFrame,
} from '../src/registry/fx/premiere-stylize-distort-generate/time.ts';
import {
	formatTimecode,
	parseTimecode,
	timecodeText,
} from '../src/registry/fx/premiere-stylize-distort-generate/video.ts';
import { PREMIERE_STYLIZE_DISTORT_GENERATE_EFFECTS as FAMILY } from '../src/registry/fx/premiere-stylize-distort-generate.ts';

const byId = (id: string): EffectSpec => {
	const s = FAMILY.find((e) => e.id === id);
	if (!s) throw new Error(`missing ${id}`);
	return s;
};
const defaults = (s: EffectSpec) => Object.fromEntries(s.params.map((p) => [p.name, p.default]));

describe('time effects (pure hooks)', () => {
	const echo = defaults(byId('jasper.echo'));
	it('Echo: offsets of k × Echo Time, intensities decay', () => {
		expect(echoOffsets(echo, { fps: 30 })).toEqual([-1]);
		expect(echoOffsets({ ...echo, numberOfEchoes: 4, echoTime: -0.1 }, { fps: 30 })).toEqual([
			-3, -6, -9, -12,
		]);
		expect(echoOffsets({ ...echo, numberOfEchoes: 20 }, { fps: 30 })).toHaveLength(8);
		expect(echoOffsets({ ...echo, numberOfEchoes: 0 }, { fps: 30 })).toEqual([]);
		expect(echoIntensity({ ...echo, startingIntensity: 0.8, decay: 0.5 }, 2)).toBeCloseTo(0.2);
	});

	it('Posterize Time holds frames at the posterized rate', () => {
		const p = { frameRate: 10 };
		const frames = Array.from({ length: 9 }, (_, f) => posterizeTimeFrame(p, { frame: f, fps: 30 }));
		expect(frames).toEqual([0, 0, 0, 3, 3, 3, 6, 6, 6]);
		expect(posterizeTimeFrame({ frameRate: 60 }, { frame: 7, fps: 30 })).toBe(7);
		expect(posterizeTimeFrame({ frameRate: 12 }, { frame: 25, fps: 24 })).toBe(24);
	});

	it('Strobe Light fires for Strobe Duration at every Strobe Period (and randomly with probability)', () => {
		const p = { strobeDuration: 0.1, strobePeriod: 1, probability: 0 };
		const on = (frame: number, extra = {}) => strobeOn({ ...p, ...extra }, { frame, fps: 30, seed: 0.3 });
		expect([0, 1, 2, 3, 29, 30, 31, 33].map((f) => on(f))).toEqual([
			true,
			true,
			true,
			false,
			false,
			true,
			true,
			false,
		]);
		expect(on(15, { probability: 100 })).toBe(true);
		const r = Array.from({ length: 200 }, (_, f) => on(f + 300, { probability: 30, strobeDuration: 0 }));
		const n = r.filter(Boolean).length;
		expect(n).toBeGreaterThan(30);
		expect(n).toBeLessThan(90);
		expect(r).toEqual(
			Array.from({ length: 200 }, (_, f) => on(f + 300, { probability: 30, strobeDuration: 0 })),
		);
	});
});

describe('Video bin text', () => {
	it('formats SMPTE (incl. drop-frame), frames and feet+frames', () => {
		expect(formatTimecode(0, '30', 'smpte')).toBe('00:00:00:00');
		expect(formatTimecode(30 * 61 + 5, '30', 'smpte')).toBe('00:01:01:05');
		expect(formatTimecode(25 * 3600, '25', 'smpte')).toBe('01:00:00:00');
		// 29.97 DF: frame 1800 is 00:01:00;02 (frames 0 and 1 of minute 1 are dropped); 17982 = 00:10:00;00.
		expect(formatTimecode(1800, '30df', 'smpte')).toBe('00:01:00;02');
		expect(formatTimecode(17982, '30df', 'smpte')).toBe('00:10:00;00');
		expect(formatTimecode(1234, '30', 'frames')).toBe('001234');
		expect(formatTimecode(35, '24', 'feet35')).toBe('0002+03');
		expect(formatTimecode(85, '24', 'feet16')).toBe('0002+05');
		expect(parseTimecode('01:00:00:00', '25')).toBe(90000);
		expect(parseTimecode('nonsense', '25')).toBe(0);
	});

	it('Timecode text per frame: source, offset, starting timecode, label', () => {
		const p = defaults(byId('jasper.timecode'));
		expect(timecodeText(p, { frame: 45, fps: 30 })).toBe('00:00:01:15');
		expect(timecodeText({ ...p, offset: 15 }, { frame: 45, fps: 30 })).toBe('00:00:02:00');
		expect(timecodeText({ ...p, timeDisplay: '25' }, { frame: 60, fps: 30 })).toBe('00:00:02:00');
		expect(
			timecodeText(
				{ ...p, timecodeSource: 'generate', startingTimecode: '01:00:00:00' },
				{ frame: 1, fps: 30 },
			),
		).toBe('01:00:00:01');
		expect(timecodeText({ ...p, labelText: 'v2' }, { frame: 0, fps: 30 })).toBe('V2 00:00:00:00');
	});
});
