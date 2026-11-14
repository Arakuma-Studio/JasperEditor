// Cut commands that move their edges off speech (docs/wp-notes/transcript-cleanup.md "Cut edges outside speech"):
// text-based cuts snap when given levels; range / trim / split cuts only with `snapToSilence`. Undo / redo,
// refusals and the invariants (the harness checks them after every transaction).
import { describe, expect, it } from 'vitest';
import type { CleanupVoice } from '../src/cleanup/detector.ts';
import { cutLevelWindows } from '../src/commands/cut-snap.ts';
import { FLICKS_PER_SECOND } from '../src/time.ts';
import { Harness, videoAsset } from './helpers.ts';

const S = (x: number) => Math.round(x * FLICKS_PER_SECOND);
const q = (db: number) => Math.round((db + 120) * 2);

/** "uno" 1.0–1.5 and "dos" 2.0–2.5, each with a 0.2 s decay after it, "tres" 3.0–3.5; floor −60, speech −10 dBFS. */
function setup() {
	const n = 1000;
	const v = {
		classes: new Uint8Array(n),
		level: new Uint8Array(n).fill(q(-60)),
		voicing: new Uint8Array(n).fill(20),
		flatness: new Uint8Array(n).fill(100),
		frameCount: n,
		levels: { floorDb: -60, speechDb: -10, speechThresholdDb: -45, breathFloorDb: -55 },
	};
	for (const [a, b] of [
		[100, 150],
		[200, 250],
		[300, 350],
	] as const) {
		for (let k = a; k < b; k++) {
			v.level[k] = q(-16);
			v.classes[k] = 2;
		}
		if (b < 300) for (let k = b; k < b + 20; k++) v.level[k] = q(-16 - (k - b + 1) * 2);
	}
	const voice = v as CleanupVoice;
	const H = new Harness({ preset: 'hd-1080p-30' });
	const r0 = H.ok([{ type: 'media.register', asset: videoAsset({ seconds: 10 }) }]);
	const mediaId = (r0.results[0] as { mediaId: string }).mediaId;
	H.ok([{ type: 'clip.place', source: { mediaId }, at: 0, tracks: { video: 'V1', audio: ['A1'] }, mode: 'overwrite' }]);
	H.ok([
		{
			type: 'transcript.create',
			mediaId,
			language: 'es',
			origin: 'manual',
			words: [
				{ text: 'uno', start: S(1), end: S(1.5), confidence: 0.9 },
				{ text: 'dos', start: S(2), end: S(2.5), confidence: 0.9 },
				{ text: 'tres', start: S(3), end: S(3.5), confidence: 0.9 },
			],
		},
	]);
	const levels = (frames: number[]) => cutLevelWindows(H.seq, frames, () => voice);
	return { H, levels };
}

const starts = (H: Harness) =>
	Object.values(H.seq.clips)
		.map((c) => [c.kind, c.start, c.duration] as const)
		.sort((a, b) => a[0].localeCompare(b[0]) || a[1] - b[1]);

describe('cut commands off speech', () => {
	it('range.extract with snapToSilence keeps the decay of the word before the cut; exact without it', () => {
		const { H, levels } = setup();
		const before = H.doc;
		const saved = JSON.stringify(before);
		// 1.5 s (frame 45): right where "uno" ends, inside its decay (quiet from 1.62 s)
		const cut = [{ type: 'range.extract', from: 45, to: 60, snapToSilence: true, levels: levels([45, 60]) }];
		const r = H.ok(cut);
		expect(r.results[0]).toMatchObject({ from: 49, to: 60, snapped: { clean: true } });
		// picture and sound cut together: both tracks lost frames 49–60
		const after = starts(H);
		expect(after).toEqual([
			['audio', 0, 49],
			['audio', 49, 240],
			['video', 0, 49],
			['video', 49, 240],
		]);
		// undo: the previous document is untouched; redo: the same command gives the same timeline
		expect(JSON.stringify(before)).toBe(saved);
		H.doc = before;
		H.ok(cut);
		expect(starts(H)).toEqual(after);
		H.doc = before;
		expect(H.ok([{ type: 'range.extract', from: 45, to: 60 }]).results[0]).toMatchObject({ from: 45, to: 60 });
	});

	it('transcript.extract snaps by default when given levels: the next word keeps its onset, the removed word goes with its decay', () => {
		const { H, levels } = setup();
		const before = H.doc;
		// "dos" (word 1): frames 60–75; the out edge leaves 50 ms of silence before its onset, the in edge takes its
		// decay (quiet from 2.62 s)
		const r = H.ok([{ type: 'transcript.extract', fromWord: 1, toWord: 1, levels: levels([60, 75]) }]);
		expect(r.results[0]).toMatchObject({ from: 58, to: 79, snapped: { clean: true } });
		H.doc = before;
		expect(H.ok([{ type: 'transcript.extract', fromWord: 1, toWord: 1 }]).results[0]).toMatchObject({
			from: 60,
			to: 75,
		});
	});

	it('clip.trim and clip.split with snapToSilence move to the quiet frame', () => {
		const { H, levels } = setup();
		const before = H.doc;
		const a = Object.values(H.seq.clips).find((c) => c.kind === 'audio')!;
		H.ok([{ type: 'clip.split', at: 46, scope: 'all-unlocked', snapToSilence: true, levels: levels([46]) }]);
		expect(starts(H).filter((c) => c[0] === 'audio')).toEqual([
			['audio', 0, 49],
			['audio', 49, 251],
		]);
		H.doc = before;
		const r = H.ok([
			{ type: 'clip.trim', clipId: a.id, edge: 'out', deltaFrames: 46 - 300, snapToSilence: true, levels: levels([46]) },
		]);
		expect(r.results[0]).toBeDefined();
		expect(starts(H)).toEqual([
			['audio', 0, 49],
			['video', 0, 49],
		]);
	});

	it('refuses malformed levels and warns when snapping has none', () => {
		const { H, levels } = setup();
		const bad = levels([45]).map((w) => ({ ...w, level: '!!!' }));
		expect(H.tx([{ type: 'range.extract', from: 45, to: 60, snapToSilence: true, levels: bad }])).toMatchObject({
			ok: false,
			errors: [{ code: 'E_INVALID_PARAM' }],
		});
		const r = H.ok([{ type: 'range.extract', from: 45, to: 60, snapToSilence: true }]);
		expect(r.results[0]).toMatchObject({ from: 45, to: 60 });
		expect(r.warnings).toEqual([expect.objectContaining({ code: 'W_NO_LEVELS' })]);
	});
});
