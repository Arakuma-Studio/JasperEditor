// Ported from FilmCraft crates/audio-dsp/src/smooth.rs tests.
import { describe, expect, it } from 'vitest';
import { Smoothed } from '../src/index.ts';

describe('Smoothed', () => {
	it('ramps linearly and lands exactly', () => {
		const s = new Smoothed(0, 4);
		s.set(1);
		const v = Array.from({ length: 6 }, () => s.tick());
		expect(v).toEqual([0.25, 0.5, 0.75, 1, 1, 1]);
		expect(s.isSmoothing()).toBe(false);
	});

	it('retarget mid-ramp is continuous', () => {
		const s = new Smoothed(0, 10);
		s.set(1);
		for (let i = 0; i < 5; i++) s.tick();
		const mid = s.value();
		s.set(0);
		const n = s.tick();
		expect(Math.abs(n - mid)).toBeLessThanOrEqual(0.1 + 1e-6);
	});

	it('zero ramp is immediate', () => {
		const s = new Smoothed(0, 0);
		s.set(3);
		expect(s.value()).toBe(3);
	});

	it('withMs, snap and setImmediate', () => {
		const s = Smoothed.withMs(0, 48000, 1);
		s.set(1);
		expect(s.isSmoothing()).toBe(true);
		for (let i = 0; i < 47; i++) s.tick();
		expect(s.tick()).toBe(1);
		s.set(2);
		s.snap();
		expect(s.value()).toBe(2);
		s.setImmediate(-1);
		expect(s.value()).toBe(-1);
		expect(s.target()).toBe(-1);
	});
});
