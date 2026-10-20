// view_sound_timeline's move lane (wp-note "Phase 6 → WP6.5b", item 11): the measured picture motion (the engine's
// cached `motion-analysis`, `pixelMotion` of the visual data) is drawn in pink over the keyframed motion (yellow) where
// the range was analysed; frames outside the analysed windows are not drawn; without an analysis (null, absent from
// older engines, or hostile data) the picture still draws and says so in `cells.pixelMotion`.
import type { SoundVisualResponse } from '@jasper/api';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { decodePng, encodePng } from '../src/png.ts';
import { drawSoundTimeline, PIXEL_MOTION } from '../src/sound-timeline.ts';

const FRAMES = 120;

function visual(pixel: SoundVisualResponse['pixelMotion'] | 'absent'): SoundVisualResponse {
	const curve = { momentary: new Array(400).fill(-40), shortTerm: new Array(400).fill(-40) };
	const v: SoundVisualResponse = {
		projectId: 'prj_0000000000000001',
		sequenceId: 'seq_1',
		range: { start: 0, end: FRAMES },
		rangeTimecode: { start: '00:00:00:00', end: '00:00:04:00' },
		fps: { num: 30, den: 1 },
		hopSec: 0.01,
		startSec: 0,
		points: 400,
		normalization: { applied: false, gainDb: 0, reason: 'off' },
		curves: { mix: curve, bed: curve, sfx: curve, music: curve, dialogue: curve, ambience: curve },
		waveformPeakDb: new Array(400).fill(-30),
		// keyframed motion: a move over frames 10–20 only
		motion: { startFrame: 0, speed: Array.from({ length: FRAMES }, (_, i) => (i >= 10 && i < 20 ? 0.2 : 0)) },
		cues: [],
		clips: [],
		speech: [],
		issues: [],
	};
	if (pixel !== 'absent') v.pixelMotion = pixel;
	return v;
}

/** Columns (x) of the move lane holding the measured-motion colour. */
function pinkColumns(v: SoundVisualResponse): {
	xs: number[];
	cells: ReturnType<typeof drawSoundTimeline>['cells'];
} {
	const { image, cells } = drawSoundTimeline(v, { width: 1200 });
	// through a PNG round trip: what the agent receives
	const img = decodePng(encodePng(image));
	const lane = cells.lanes.find((l) => l.name === 'move')!;
	const xs = new Set<number>();
	for (let y = lane.y; y < lane.y + lane.height; y++)
		for (let x = cells.plotX; x < cells.plotX + cells.plotWidth; x++) {
			const o = (y * img.width + x) * 4;
			if (
				img.data[o] === PIXEL_MOTION[0] &&
				img.data[o + 1] === PIXEL_MOTION[1] &&
				img.data[o + 2] === PIXEL_MOTION[2]
			)
				xs.add(x);
		}
	return { xs: [...xs].sort((a, b) => a - b), cells };
}

describe('view_sound_timeline: the measured picture motion', () => {
	it('is drawn where the range was analysed: a pink curve peaking where the picture moves', () => {
		// measured: the box moves over frames 30–60, faster than the keyframed move
		const speed = Array.from({ length: FRAMES }, (_, i) => (i >= 30 && i < 60 ? 0.3 : 0.01));
		const { xs, cells } = pinkColumns(visual({ startFrame: 0, speed }));
		expect(cells.pixelMotion).toBe('measured');
		expect(xs.length).toBeGreaterThan(cells.plotWidth * 0.9);
		// the curve is high (near the lane top) over the move and low elsewhere
		const { image } = drawSoundTimeline(visual({ startFrame: 0, speed }), { width: 1200 });
		const lane = cells.lanes.find((l) => l.name === 'move')!;
		const topPink = (frame: number) => {
			const x = Math.round(cells.plotX + (frame + 0.5) * cells.pxPerFrame);
			for (let y = lane.y; y < lane.y + lane.height; y++) {
				const o = (y * image.width + x) * 4;
				if (image.data[o] === PIXEL_MOTION[0] && image.data[o + 1] === PIXEL_MOTION[1]) return y - lane.y;
			}
			return null;
		};
		expect(topPink(45)!).toBeLessThan(4);
		expect(topPink(90)!).toBeGreaterThan(lane.height - 5);
		expect(cells.lanes.find((l) => l.name === 'move')!.what).toContain('measured');
	});

	it('only over the analysed frames (null elsewhere): partly analysed', () => {
		const speed = Array.from({ length: FRAMES }, (_, i) => (i < 60 ? 0.2 : null));
		const { xs, cells } = pinkColumns(visual({ startFrame: 0, speed }));
		expect(cells.pixelMotion).toBe('partly analysed');
		const half = cells.plotX + 60 * cells.pxPerFrame;
		expect(xs.length).toBeGreaterThan(0);
		expect(Math.max(...xs)).toBeLessThanOrEqual(Math.ceil(half) + 1);
	});

	it('not analysed (null or absent): no pink, the keyframed curve still drawn, no failure', () => {
		for (const p of [null, 'absent'] as const) {
			const { xs, cells } = pinkColumns(visual(p));
			expect(xs).toEqual([]);
			expect(cells.pixelMotion).toBe('not analysed');
		}
	});

	it('hostile pixelMotion never throws', () => {
		fc.assert(
			fc.property(fc.anything(), (junk) => {
				const v = { ...visual('absent'), pixelMotion: junk } as unknown as SoundVisualResponse;
				const { cells } = drawSoundTimeline(v, { width: 600 });
				expect(['measured', 'partly analysed', 'not analysed']).toContain(cells.pixelMotion);
			}),
			{ numRuns: 200 },
		);
		const v = visual({ startFrame: 0, speed: [Number.NaN, Number.POSITIVE_INFINITY, -5, 1e308, null] });
		expect(() => drawSoundTimeline(v)).not.toThrow();
	});
});
