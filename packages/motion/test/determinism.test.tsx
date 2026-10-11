import { getTextAnimationSpec } from '@jasper/project';
import { describe, it } from 'vitest';
import { TEXT_ANIMATION_IMPLS } from '../src/text/index.ts';
import { checkTextAnimation } from './determinism-harness.tsx';

describe('every registered text animator (S11:ANM-013)', { timeout: 120_000 }, () => {
	const impls = Object.entries(TEXT_ANIMATION_IMPLS);
	for (const [key, impl] of impls) {
		const [id, version] = key.split('@') as [string, string];
		it(`${key} is order-independent, rests outside its window and keeps the build contract`, () => {
			const spec = getTextAnimationSpec(id, Number(version));
			checkTextAnimation(impl, spec);
		});
	}
});
