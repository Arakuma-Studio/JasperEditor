// The editor catalogue must resolve to a renderer for every offered preset (S11:TXA-002/003).
import { TEXT_ANIMATION_EASES, TEXT_ANIMATION_SPECS } from '@jasper/project';
import { describe, expect, it } from 'vitest';
import { EASE_NAMES } from '../src/runtime/index.ts';
import { textAnimationImpl } from '../src/text/index.ts';

describe('text animation catalogue', () => {
	it('every offered preset resolves and an unknown version does not', () => {
		for (const spec of TEXT_ANIMATION_SPECS)
			expect(textAnimationImpl({ preset: spec.id, version: spec.version }), spec.id).toBeDefined();
		expect(textAnimationImpl({ preset: 'fade', version: 999 })).toBeUndefined();
	});

	it('every offered ease has a runtime implementation', () => {
		for (const ease of TEXT_ANIMATION_EASES) expect(EASE_NAMES).toContain(ease);
	});
});
