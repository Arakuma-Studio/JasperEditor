// WP0.1 (spec 12 Phase 0): Sequence ▸ Loudness Normalization ▸ Analyze reported a result even when storing the analysis
// was refused (read-only project, sequence gone): the dialog showed numbers the project never kept.
import { createCounterIdSource, createEmptyProject } from '@jasper/project';
import { describe, expect, it } from 'vitest';
import { analyzeSequenceLoudness } from '../src/audio/engine-ops.ts';

const loudness = {
	integratedLufs: -20,
	lra: 3,
	truePeakDbtp: -2,
	samplePeakDb: -2.2,
	maxMomentaryLufs: -18,
	maxShortTermLufs: -19,
	durationSec: 10,
};

function fakes(ok: boolean) {
	const doc = createEmptyProject({ ids: createCounterIdSource(1), name: 'T', preset: 'hd-1080p-30' });
	const applied: unknown[] = [];
	const session = {
		revision: 3,
		getCommitted: () => doc,
		apply: (tx: unknown) => {
			applied.push(tx);
			return ok
				? { ok: true, revision: 4, results: [{}] }
				: { ok: false, revision: 3, errors: [{ code: 'E_READ_ONLY', message: 'The project is read-only' }] };
		},
	};
	const engine = {
		analyzeAudio: async () => ({ state: 'succeeded', result: { sampleRate: 48000, loudness, mixHash: 'h1' } }),
	};
	return { session: session as never, engine: engine as never, applied, seqId: Object.keys(doc.sequences)[0]! };
}

describe('analyzeSequenceLoudness', () => {
	it('stores the analysis (one step) and returns it', async () => {
		const f = fakes(true);
		const r = await analyzeSequenceLoudness(f.session, f.engine, f.seqId);
		expect(r.loudness.integratedLufs).toBe(-20);
		expect(f.applied).toHaveLength(1);
	});

	it('a refused store is an error, not a silent success', async () => {
		const f = fakes(false);
		await expect(analyzeSequenceLoudness(f.session, f.engine, f.seqId)).rejects.toThrow('read-only');
	});
});
