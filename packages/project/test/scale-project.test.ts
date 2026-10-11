import { describe, expect, it } from 'vitest';
import { buildScaleProject, countClips } from '../bench/scale-project.ts';
import {
	checkInvariants,
	createCounterIdSource,
	defaultRegistries,
	loadProject,
	makeEnvelope,
} from '../src/index.ts';

describe('scale project generator', () => {
	it('10 sequences × 25 clips: valid, deterministic, round-trips', () => {
		const doc = buildScaleProject({ sequences: 10 });
		expect(Object.keys(doc.sequences)).toHaveLength(10);
		expect(countClips(doc)).toBe(250);
		const effects = defaultRegistries().effects;
		expect(checkInvariants(doc, { effects })).toEqual([]);
		const json = JSON.stringify(
			makeEnvelope(doc, { revision: 1, savedAt: '2026-10-08T00:00:00.000Z', platform: 'test' }),
		);
		expect(
			JSON.stringify(
				makeEnvelope(buildScaleProject({ sequences: 10 }), {
					revision: 1,
					savedAt: '2026-10-08T00:00:00.000Z',
					platform: 'test',
				}),
			),
		).toBe(json);
		const loaded = loadProject(JSON.parse(json), { ids: createCounterIdSource(1), effects });
		expect(loaded.repairs).toEqual([]);
		expect(loaded.issues).toEqual([]);
		expect(JSON.parse(JSON.stringify(loaded.document))).toEqual(JSON.parse(JSON.stringify(doc)));
		const kinds = new Set(
			Object.values(doc.sequences).flatMap((s) => Object.values(s.clips).map((c) => c.kind)),
		);
		expect([...kinds].sort()).toEqual(['audio', 'shape', 'solid', 'still', 'text', 'video']);
	});
});
