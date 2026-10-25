// Program monitor picking of thin vector strokes: a perfectly horizontal / vertical line (zero-height / zero-width
// path) must be clickable within a few screen pixels at any monitor zoom, not only within its stroke band in layer
// pixels (which is under one screen pixel when the monitor is zoomed out).
import {
	buildRenderSnapshot,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	resolveSceneAt,
} from '@jasper/project';
import { EditorSession } from '@jasper/session';
import { describe, expect, it } from 'vitest';
import { pickLayerAt, SHAPE_HIT_SCREEN_PX } from '../src/shapes/geometry.ts';

function sceneWith(paths: string[], strokeWidth = 2) {
	const ids = createCounterIdSource(1);
	const document = createEmptyProject({ ids, name: 'Lines', preset: 'hd-1080p-30' });
	const session = new EditorSession({
		projectId: document.projectId,
		document,
		ctx: { ids, now: () => 't', registries: defaultRegistries() },
		coalesceWindowMs: 0,
	});
	const seqId = session.getState().activeSequenceId!;
	const clipIds: string[] = [];
	for (const [i, p] of paths.entries()) {
		const r = session.apply({
			label: 'setup',
			origin: 'user',
			commands: [
				{
					type: 'clip.addShape',
					at: 0,
					duration: 30,
					track: `V${i + 1}`,
					ref: '$s',
					shape: {
						type: 'vector',
						contents: [
							{ type: 'path', path: p },
							{ type: 'stroke', color: '#ffffff', width: strokeWidth },
						],
					},
				},
			] as never,
		});
		if (!r.ok) throw new Error(JSON.stringify(r.errors));
		clipIds.push(r.refs.$s!);
	}
	const doc = buildRenderSnapshot(session.getDrawn(), seqId, {
		resolveMedia: () => null,
		resolveFont: () => null,
	});
	const tracks = session.getCommitted().sequences[seqId]!.videoTracks.map((t) => t.id);
	return { scene: resolveSceneAt(doc as never, 0), clipIds, tracks };
}

// Content origin = frame centre (960, 540): a 400 px line through the centre.
const HORIZONTAL = 'M-200 0 L200 0';
const VERTICAL = 'M0 -200 L0 200';

describe('thin line picking (Program monitor)', () => {
	for (const scale of [0.25, 0.5, 1, 2]) {
		it(`picks a horizontal and a vertical line within ${SHAPE_HIT_SCREEN_PX - 1} screen px at ${scale * 100}%`, () => {
			const { scene, clipIds } = sceneWith([HORIZONTAL, VERTICAL]);
			const off = (SHAPE_HIT_SCREEN_PX - 1) / scale; // sequence px
			expect(pickLayerAt(scene, [1060, 540 + off], scale)).toBe(clipIds[0]);
			expect(pickLayerAt(scene, [1060, 540 - off], scale)).toBe(clipIds[0]);
			expect(pickLayerAt(scene, [960 + off, 640], scale)).toBe(clipIds[1]);
			expect(pickLayerAt(scene, [960 - off, 440], scale)).toBe(clipIds[1]);
		});
	}

	it('misses clicks clearly away from the stroke', () => {
		const { scene } = sceneWith([HORIZONTAL]);
		expect(pickLayerAt(scene, [1060, 540 + 40], 0.5)).toBeNull();
		expect(pickLayerAt(scene, [1300, 540], 1)).toBeNull(); // past the line's end
	});

	it('skips locked tracks', () => {
		const { scene, clipIds, tracks } = sceneWith([HORIZONTAL]);
		expect(pickLayerAt(scene, [1060, 540], 1)).toBe(clipIds[0]);
		expect(pickLayerAt(scene, [1060, 540], 1, new Set([tracks[0]!]))).toBeNull();
	});
});
