// A successful loudness analysis must be stored as one undoable edit. A refused store must surface as failure.
// Spec 12 Phase 0; docs/wp-notes/sound-design.md, WP0.1.
import { createCounterIdSource, createEmptyProject, defaultRegistries } from '@jasper/project';
import { EditorSession } from '@jasper/session';
import { describe, expect, it } from 'vitest';
import { analyzeSequenceLoudness } from '../src/audio/engine-ops.ts';

const engine = {
	analyzeAudio: async () => ({
		state: 'succeeded',
		result: {
			sampleRate: 48000,
			mixHash: 'mix-before-analysis',
			loudness: {
				integratedLufs: -20,
				lra: 3,
				truePeakDbtp: -2,
				samplePeakDb: -2.2,
				durationSec: 10,
				maxMomentaryLufs: -18,
				maxShortTermLufs: -19,
			},
		},
	}),
};

function fixture(readOnly = false) {
	const ids = createCounterIdSource(1);
	const document = createEmptyProject({ ids, name: 'T', preset: 'hd-1080p-30' });
	const session = new EditorSession({
		projectId: document.projectId,
		document,
		readOnly,
		ctx: { ids, now: () => '2026-10-17T00:00:00.000Z', registries: defaultRegistries() },
	});
	return { session, document, seqId: Object.keys(document.sequences)[0]! };
}

describe('analyzeSequenceLoudness', () => {
	it('stores the analysis in one undoable edit', async () => {
		const { session, document, seqId } = fixture();
		await analyzeSequenceLoudness(session, engine as never, seqId);
		expect(session.getCommitted().sequences[seqId]!.master.loudness?.analysis).toMatchObject({
			integratedLufs: -20,
			truePeakDbtp: -2,
			lra: 3,
			mixHash: 'mix-before-analysis',
		});
		expect(session.getState().history.entries).toHaveLength(1);
		session.undo();
		expect(session.getCommitted()).toEqual(document);
	});

	it('a read-only store fails without changing the document', async () => {
		const { session, document, seqId } = fixture(true);
		await expect(analyzeSequenceLoudness(session, engine as never, seqId)).rejects.toThrow('read-only');
		expect(session.getCommitted()).toEqual(document);
		expect(session.getState().history.entries).toHaveLength(0);
	});
});
