import { describe, expect, it } from 'vitest';
import { TRANSITION_SPECS } from '../src/index.ts';
import { PREMIERE_TRANSITIONS } from '../src/registry/transitions/premiere-transitions.ts';

describe('transition lookup identifiers', () => {
	it('keeps labels unique across the whole registry (MCP resolves types by label) and ids unique', () => {
		const labels = TRANSITION_SPECS.map((s) => s.label.toLowerCase());
		expect(new Set(labels).size).toBe(labels.length);
		const ids = PREMIERE_TRANSITIONS.map((s) => s.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const id of ids) expect(id).toMatch(/^jasper\.[a-z0-9-]+$/);
	});
});
