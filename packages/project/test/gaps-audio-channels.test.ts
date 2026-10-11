import { describe, expect, it } from 'vitest';
import {
	checkInvariants,
	matrixOfRouting,
	repairDocument,
	routingFromMatrix,
	sourceChannels,
} from '../src/index.ts';
import { Harness, videoAsset } from './helpers.ts';

const quad = () => {
	const a = videoAsset({ seconds: 5 });
	const s = a.probe.streams[1] as { channels: number; channelLayout: string };
	s.channels = 4;
	s.channelLayout = '4.0';
	return a;
};

describe('audio channels', () => {
	it('matrix ⇄ routing round trip, with silent clip channels', () => {
		const a = quad();
		expect(sourceChannels(a).map((r) => r.label)).toEqual([
			'Channel 1',
			'Channel 2',
			'Channel 3',
			'Channel 4',
		]);
		const r = routingFromMatrix(a, 'mono', 4, [[0, 0], [1, 0], [2, 0], null]);
		expect(r).toEqual({
			clips: [
				{ streamIndex: 1, map: [0] },
				{ streamIndex: 1, map: [1] },
				{ streamIndex: 1, map: [2] },
				{ streamIndex: 1, map: [0], mute: [0] },
			],
		});
		expect(matrixOfRouting(a, (r as { clips: never[] }).clips)).toEqual([[0, 0], [1, 0], [2, 0], null]);
		expect('error' in routingFromMatrix(a, 'stereo', 1, [[0, 0], [0, 0], null, null])).toBe(true);
	});

	it('clip.setAudioChannels routes linked clips (undoable) and refuses what the media lacks', () => {
		const h = new Harness();
		const m = (h.ok([{ type: 'media.register', asset: quad() }]).results[0] as { mediaId: string }).mediaId;
		h.ok([{ type: 'clip.place', source: { mediaId: m }, at: 0 }]);
		const a1 = h.clips('A1')[0]!;
		h.ok([{ type: 'clip.setAudioChannels', clipIds: [a1.id], channels: [{ streamIndex: 1, map: [2, 3] }] }]);
		expect((h.clips('A1')[0] as { channels: unknown }).channels).toEqual({ streamIndex: 1, map: [2, 3] });
		expect(
			h.tx([{ type: 'clip.setAudioChannels', clipIds: [a1.id], channels: [{ streamIndex: 1, map: [7, 0] }] }])
				.ok,
		).toBe(false);
		expect(
			h.tx([{ type: 'clip.setAudioChannels', clipIds: [a1.id], channels: [{ streamIndex: 0, map: [0] }] }])
				.ok,
		).toBe(false);
		expect(
			h.tx([
				{ type: 'clip.setAudioChannels', clipIds: [a1.id], channels: [{ streamIndex: 1, map: [0, 1, 2] }] },
			]).ok,
		).toBe(false);
	});

	it('a routed Project item places one clip per routed clip', () => {
		const h = new Harness();
		const m = (h.ok([{ type: 'media.register', asset: quad() }]).results[0] as { mediaId: string }).mediaId;
		const item = Object.values(h.doc.items).find((i) => i.kind === 'media')!;
		h.ok([
			{
				type: 'item.setAudioChannels',
				itemIds: [item.id],
				clips: [
					{ streamIndex: 1, map: [0] },
					{ streamIndex: 1, map: [1] },
					{ streamIndex: 1, map: [2, 3] },
				],
			},
		]);
		h.ok([{ type: 'clip.place', source: { projectItemId: item.id }, at: 0 }]);
		const audio = Object.values(h.seq.clips).filter((c) => c.kind === 'audio') as unknown as {
			channels: { map: number[] };
		}[];
		expect(audio.map((c) => c.channels.map).sort()).toEqual([[0], [1], [2, 3]]);
		h.ok([{ type: 'clip.place', source: { mediaId: m }, at: 300 }]);
		expect(Object.values(h.seq.clips).filter((c) => c.kind === 'audio')).toHaveLength(6);
		expect(checkInvariants(h.doc)).toEqual([]);
	});

	it('repairs routings outside the media', () => {
		const h = new Harness();
		const m = h.registerVideo({ seconds: 4 });
		h.ok([{ type: 'clip.place', source: { mediaId: m }, at: 0 }]);
		const broken = structuredClone(h.doc);
		const seq = Object.values(broken.sequences)[0]!;
		const a = Object.values(seq.clips).find((c) => c.kind === 'audio') as unknown as {
			channels: { map: number[] };
		};
		a.channels.map = [5, 6];
		expect(checkInvariants(broken).some((i) => i.invariant === 'INV-CHANNELS')).toBe(true);
		const { document, report } = repairDocument(broken, h.ids);
		expect(report.some((r) => r.action === 'reset-channels')).toBe(true);
		expect(checkInvariants(document).filter((i) => i.invariant === 'INV-CHANNELS')).toEqual([]);
	});
});
