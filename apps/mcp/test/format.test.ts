// The compact timeline table agents read (`get_timeline`). Regression (verify workstream): a time-remapped clip
// showed its source as sourceIn + duration (e.g. "0–11 s" for 6 s of media slowed down) instead of the media its
// frames actually show.
import {
	applyTransaction,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	FLICKS_PER_SECOND,
	type MediaAsset,
	type ProjectDocument,
} from '@jasper/project';
import { describe, expect, it } from 'vitest';
import { timelineTable } from '../src/format.ts';

const video = (seconds: number): Omit<MediaAsset, 'id'> =>
	({
		kind: 'video',
		fingerprint: `q1:${'7'.repeat(64)}`,
		originalName: 'six.mp4',
		sizeBytes: 1000,
		container: 'mov,mp4',
		probe: {
			durationFlicks: seconds * FLICKS_PER_SECOND,
			startTimecode: null,
			streams: [
				{
					index: 0,
					type: 'video',
					codec: 'h264',
					width: 1280,
					height: 720,
					pixelAspect: { num: 1, den: 1 },
					frameRate: { num: 30, den: 1 },
					pixelFormat: 'yuv420p',
					bitDepth: 8,
					color: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'tv' },
					browserDecodable: true,
				},
			],
			rotationDegrees: 0,
			hasAlpha: false,
			variableFrameRate: false,
		},
		locators: [{ type: 'engine-store', engineId: 'local', key: 'mk_six' }],
		derivation: null,
		importedAt: '2026-10-09T00:00:00.000Z',
	}) as Omit<MediaAsset, 'id'>;

describe('timelineTable', () => {
	it('a time-remapped clip shows the media its frames show, not sourceIn + duration', () => {
		const ids = createCounterIdSource(3);
		let doc: ProjectDocument = createEmptyProject({ ids, name: 'T', preset: 'hd-1080p-30' });
		const seqId = Object.keys(doc.sequences)[0]!;
		let revision = 0;
		const tx = (commands: unknown[]) => {
			const r = applyTransaction(
				doc,
				{ protocol: 'jasper.tx/1', origin: 'user', label: 't', sequenceId: seqId, commands } as never,
				{ ids, now: () => 'n', revision, registries: defaultRegistries() },
			);
			if (!r.result.ok) throw new Error(JSON.stringify(r.result.errors));
			doc = r.document;
			revision++;
			return r.result;
		};
		const m = tx([{ type: 'media.register', asset: video(6), ref: '$m' }]).refs.$m!;
		const c = tx([
			{ type: 'clip.place', source: { mediaId: m }, at: 0, video: true, audio: false, ref: '$c' },
		]).refs.$c!;
		tx([{ type: 'timeRemap.enable', clipIds: [c], enabled: true }]);
		tx([{ type: 'timeRemap.setSpeed', clipId: c, at: 30, speedPercent: 50 }]);
		const seq = doc.sequences[seqId]!;
		expect(seq.clips[c]!.duration).toBe(360); // the one segment at 50 %: 6 s of media over 12 s
		const row = timelineTable(doc, seq)
			.split('\n')
			.find((l) => l.includes(c))!;
		expect(row).toContain('(time remapped)');
		const [, a, b] = /(\d+(?:\.\d+)?)–(\d+(?:\.\d+)?) s \(time remapped\)/.exec(row)!;
		expect(Number(a)).toBe(0);
		expect(Number(b)).toBeGreaterThan(5.9);
		expect(Number(b)).toBeLessThanOrEqual(6);
	});
});
