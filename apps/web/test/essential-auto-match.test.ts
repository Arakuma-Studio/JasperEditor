// Phase 0 verification (spec 12): Essential Sound ▸ Auto-Match on clips shorter than one 400 ms gating block said
// "The clips are silent" — the panel threw away the command's per-clip reasons (WP0.2 #9 never reached the editor).
import { createCounterIdSource, createEmptyProject } from '@jasper/project';
import { describe, expect, it } from 'vitest';
import { autoMatchLoudness, autoMatchMessage } from '../src/audio-fx/ops.ts';

const SHORT = 'shorter than 400 ms (integrated loudness is undefined)';

function fakes(
	clips: Record<string, { gainDb: number } | { skipped: string }>,
	lufs: Record<string, number | null>,
) {
	const doc = createEmptyProject({ ids: createCounterIdSource(1), name: 'T', preset: 'hd-1080p-30' });
	const session = {
		revision: 1,
		getCommitted: () => doc,
		apply: () => ({
			ok: true,
			revision: 2,
			refs: {},
			created: [],
			changed: [],
			deleted: [],
			warnings: [],
			results: [{ clips }],
		}),
	};
	const engine = {
		analyzeAudio: async () => ({
			state: 'succeeded',
			result: {
				sampleRate: 48000,
				mixHash: 'h',
				clips: Object.fromEntries(Object.entries(lufs).map(([id, v]) => [id, { integratedLufs: v }])),
			},
		}),
	};
	return { session: session as never, engine: engine as never, seqId: Object.keys(doc.sequences)[0]! };
}

describe('Auto-Match outcome', () => {
	it('returns the command’s per-clip result, and a short clip is reported as too short, not silent', async () => {
		const f = fakes({ c1: { skipped: SHORT } }, { c1: null });
		const out = await autoMatchLoudness(f.session, f.engine, f.seqId, ['c1'], -23);
		expect(out).toEqual({ c1: { skipped: SHORT } });
		const m = autoMatchMessage(out, -23);
		expect(m).toMatch(/shorter than 400 ms/);
		expect(m).not.toMatch(/silent/);
	});

	it('words matched, silent and mixed outcomes', () => {
		expect(autoMatchMessage({ a: { gainDb: 3 }, b: { gainDb: -1 } }, -23)).toBe(
			'Matched 2 clips to -23 LUFS',
		);
		expect(autoMatchMessage({ a: { skipped: 'silent' }, b: { skipped: 'silent' } }, -23)).toBe(
			'The clips are silent: nothing was matched',
		);
		expect(autoMatchMessage({ a: { gainDb: 3 }, b: { skipped: SHORT } }, undefined)).toBe(
			'Matched 1 clip to the target; 1 left as they are (shorter than 400 ms, too short to measure)',
		);
		expect(autoMatchMessage({ a: { skipped: 'silent' }, b: { skipped: SHORT } }, -23)).toMatch(
			/^Nothing was matched: silent, shorter than 400 ms/,
		);
	});
});
