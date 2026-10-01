// Determinism suite (S11:ANM-013): every registered text animator (TEXT_ANIMATION_IMPLS) and anime template
// (ANIME_TEMPLATE_IMPLS) visited in order, reversed, shuffled and with revisits (fast-check, fixed seeds) equals a
// fresh build / fresh mount per frame. Presets and templates join automatically by being registered.
import { getTextAnimationSpec } from '@jasper/project';
import { describe, expect, it } from 'vitest';
import { TEXT_ANIMATION_IMPLS } from '../src/text/index.ts';
import { checkTextAnimation } from './determinism-harness.tsx';

const failuresOf = (reports: { failures: string[] }[]) => reports.flatMap((r) => r.failures);

describe('every registered text animator (S11:ANM-013)', { timeout: 120_000 }, () => {
	const impls = Object.entries(TEXT_ANIMATION_IMPLS);
	for (const [key, impl] of impls) {
		const [id, version] = key.split('@') as [string, string];
		it(`${key} is order-independent, rests outside its window and keeps the build contract`, () => {
			const spec = getTextAnimationSpec(id, Number(version));
			expect(failuresOf(checkTextAnimation(impl, spec))).toEqual([]);
		});
	}
});
