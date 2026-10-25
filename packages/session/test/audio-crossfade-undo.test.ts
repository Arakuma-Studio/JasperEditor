// Premiere port: Custom Fade and Custom Start edits are undoable session entries (undo restores the transition as it
// was, redo re-applies it); a refused edit adds no entry and leaves the document alone.
import {
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	type MediaAsset,
	type Sequence,
} from '@jasper/project';
import { describe, expect, it } from 'vitest';
import { EditorSession } from '../src/index.ts';

let fp = 0;
function audioAsset(): Omit<MediaAsset, 'id'> {
	fp++;
	return {
		kind: 'audio',
		fingerprint: `q1:${fp.toString(16).padStart(64, '0')}`,
		originalName: `a-${fp}.wav`,
		sizeBytes: 1000,
		container: 'wav',
		probe: {
			durationFlicks: 10 * 705_600_000,
			startTimecode: null,
			streams: [
				{
					index: 0,
					type: 'audio',
					codec: 'pcm_s16le',
					sampleRate: 48000,
					channels: 2,
					channelLayout: 'stereo',
				},
			],
			rotationDegrees: 0,
			hasAlpha: false,
			variableFrameRate: false,
		},
		locators: [{ type: 'engine-store', engineId: 'local', key: `mk_${fp}` }],
		derivation: null,
		importedAt: '2026-10-25T00:00:00.000Z',
	} as Omit<MediaAsset, 'id'>;
}

function setup() {
	const ids = createCounterIdSource(3);
	const doc = createEmptyProject({ ids, name: 'X', preset: 'hd-1080p-30' });
	const s = new EditorSession({
		projectId: doc.projectId,
		document: doc,
		ctx: { ids, now: () => '2026-10-25T00:00:00.000Z', registries: defaultRegistries() },
	});
	const seqId = Object.keys(doc.sequences)[0]!;
	const run = (label: string, commands: unknown[]) =>
		s.apply({ label, origin: 'user', sequenceId: seqId, commands: commands as never });
	const ok = (commands: unknown[]) => {
		const r = run('setup', commands);
		if (!r.ok) throw new Error(JSON.stringify(r.errors));
		return r;
	};
	const m = ok([
		{ type: 'media.register', asset: audioAsset() },
		{ type: 'media.register', asset: audioAsset() },
	]).results as { mediaId: string }[];
	ok([
		{
			type: 'clip.place',
			source: { mediaId: m[0]!.mediaId },
			at: 0,
			sourceRange: { in: { sourceFrames: 30 }, out: { sourceFrames: 130 } },
		},
		{
			type: 'clip.place',
			source: { mediaId: m[1]!.mediaId },
			at: 100,
			sourceRange: { in: { sourceFrames: 30 }, out: { sourceFrames: 130 } },
		},
	]);
	const seq = () => s.getCommitted().sequences[seqId] as Sequence;
	return { s, run, seq };
}

describe('Custom Fade / Custom Start undo and redo', () => {
	it('add, update params and cut offset, undo each, redo each', () => {
		const { s, run, seq } = setup();
		const add = run('Add Custom Fade', [
			{
				type: 'transition.add',
				trackId: 'A1',
				at: 100,
				effectId: 'jasper.custom-fade',
				duration: 20,
				cutOffset: 5,
			},
		]);
		expect(add.ok).toBe(true);
		const id = (add.ok ? add.results[0] : null) as { transitionId: string };
		const t = () => seq().transitions[id.transitionId];
		const afterAdd = t();
		expect(afterAdd).toMatchObject({ cutPosition: 0.25, effectId: 'jasper.custom-fade' });
		expect(
			run('Fade Value', [
				{
					type: 'transition.update',
					transitionId: id.transitionId,
					params: { fadeShape: 'linear', fadeValue: 12 },
				},
			]).ok,
		).toBe(true);
		const afterParams = t();
		expect(
			run('Alignment', [{ type: 'transition.update', transitionId: id.transitionId, alignment: 'center' }])
				.ok,
		).toBe(true);
		expect(t()!.cutPosition).toBeUndefined();
		// a refused edit records nothing
		const n = s.getState().history.entries.length;
		const refused = run('Bad', [
			{ type: 'transition.update', transitionId: id.transitionId, params: { symmetry: 'lopsided' } },
		]);
		expect(refused.ok).toBe(false);
		expect(s.getState().history.entries.length).toBe(n);
		expect(s.undo().ok).toBe(true);
		expect(t()).toEqual(afterParams);
		expect(s.undo().ok).toBe(true);
		expect(t()).toEqual(afterAdd);
		expect(s.undo().ok).toBe(true);
		expect(t()).toBeUndefined();
		expect(s.redo().ok).toBe(true);
		expect(t()).toEqual(afterAdd);
		expect(s.redo().ok).toBe(true);
		expect(t()).toEqual(afterParams);
		expect(s.redo().ok).toBe(true);
		expect(t()!.cutPosition).toBeUndefined();
	});
});
