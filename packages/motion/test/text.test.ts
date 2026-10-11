import { TEXT_ANIMATION_SPECS } from '@jasper/project';
import { describe, expect, it } from 'vitest';
import { frameToMs, seekCanonical } from '../src/runtime/index.ts';
import { textAnimationImpl } from '../src/text/index.ts';

describe('text animation catalogue', () => {
	it('every offered preset resolves and an unknown version does not', () => {
		for (const spec of TEXT_ANIMATION_SPECS)
			expect(textAnimationImpl({ preset: spec.id, version: spec.version }), spec.id).toBeDefined();
		expect(textAnimationImpl({ preset: 'fade', version: 999 })).toBeUndefined();
	});
});

// Typing takes 900 ms for 15 units. Keystrokes keep the cursor lit; idle blinking alternates every 250 ms.
it('typewriter@2 blinks while idle in either direction and honors caretBlink', () => {
	const impl = textAnimationImpl({ preset: 'typewriter', version: 2 })!;
	const params = { caret: true, caretBlink: true, blinkRate: 2, delay: 0, typing: 0.6 };
	const states = (side: 'in' | 'out', frames: number[], blink = true) => {
		const ctx = {
			units: 15,
			side,
			durationMs: 1500,
			params: { ...params, caretBlink: blink },
			seed: 7,
			box: { width: 900, height: 200 },
		};
		const built = impl.build(ctx);
		return frames.map((frame) => {
			const ms = frameToMs(side === 'in' ? frame : 59 - frame, 30);
			seekCanonical(built.timeline, ms);
			const shown = built.targets.filter((unit) => unit.reveal >= 1).length;
			return impl.caretVisible!({ ...ctx, fps: 30, ms, shown });
		});
	};
	expect(states('in', [0, 5, 10, 20, 26, 32, 33, 36, 40, 41, 44])).toEqual([
		true,
		true,
		true,
		true,
		true,
		true,
		false,
		false,
		false,
		true,
		true,
	]);
	expect(states('out', [15, 22, 23, 29, 30, 40, 59])).toEqual([true, true, false, false, true, true, true]);
	expect(states('in', [33, 36, 40], false)).toEqual([true, true, true]);
});
