// Proposal ghosts, the pure part (spec 12 §2.7 "Review"): which entities become ghost clips, removal washes, ghost
// tracks and ghost cues (attributed to their items), where they are drawn (rows of new tracks, x at the frame,
// culling), video-lane reachability, the keyboard order, the why-line and the accessible names.
import type { ProjectDocument } from '@jasper/project';
import { type EditorSession, proposalsFor, type ReviewItem } from '@jasper/session';
import { describe, expect, it } from 'vitest';
import { computeLayout } from '../src/panels/timeline/model/layout.ts';
import {
	buildGhostModel,
	type GhostModel,
	ghostLaneExtent,
	ghostTrackRows,
	neighbourItem,
	setupOwners,
	whyLines,
} from '../src/proposals/ghosts.ts';
import { proposalFixture } from './proposal-helpers.ts';

function model(session: EditorSession, seqId: string, agent = true) {
	const st = proposalsFor(session).getState();
	return buildGhostModel({
		preview: st.preview!,
		committed: st.preview!.base,
		sequenceId: seqId,
		items: st.items,
		agent,
	});
}

describe('buildGhostModel', () => {
	it('turns the preview into ghost clips, a ghost track, removal washes and ghost cues, per item', async () => {
		const f = await proposalFixture();
		const m = model(f.session, f.seqId);
		expect(m.tracks).toHaveLength(1);
		expect(m.tracks[0]).toMatchObject({ itemId: 'trk', region: 'audio', name: 'SFX 1' });
		expect(m.tracks[0]!.label).toBe(`A${f.seq().audioTracks.length + 1}`);
		const created = m.clips.filter((c) => c.change === 'created');
		expect(created.map((c) => [c.itemId, c.start, c.newTrack])).toEqual([
			['hit', 30, true],
			['boom', 200, true],
		]);
		// the moved bed: a wash where it is, the ghost where it goes
		const moved = m.clips.find((c) => c.itemId === 'move')!;
		expect(moved).toMatchObject({ change: 'changed', clipId: f.bed.id, start: 400, newTrack: false });
		expect(m.removals).toEqual([
			expect.objectContaining({ itemId: 'move', clipId: f.bed.id, start: 0, change: 'changed' }),
		]);
		// the moved cue is drawn under a ghost id (the cue itself stays on the seam)
		expect(m.cues).toEqual([
			expect.objectContaining({
				itemId: 'cue',
				change: 'changed',
				cue: expect.objectContaining({ id: `${f.cueId}~ghost`, frame: 70 }),
			}),
		]);
		// by where each starts (the moved bed's wash starts at 0)
		expect(m.items.map((x) => x.id)).toEqual(['trk', 'move', 'hit', 'cue', 'boom']);
		expect(m.byItem.hit).toMatchObject({ start: 30, clips: 1, state: 'pending' });
		expect(m.agent).toBe(true);
	});

	it('follows decisions: rejected items stay drawn, applied ones are gone', async () => {
		const f = await proposalFixture();
		await f.c.setItemDecision(['boom'], 'reject');
		await f.c.setItemDecision(['hit'], 'accept');
		f.flush();
		let m = model(f.session, f.seqId);
		expect(m.byItem.boom!.state).toBe('rejected');
		expect(m.byItem.hit!.state).toBe('accepted');
		expect(m.byItem.trk!.state).toBe('accepted');
		const r = await f.c.apply({ trusted: true });
		expect(r.ok).toBe(true);
		f.flush();
		m = model(f.session, f.seqId);
		expect(m.byItem.hit).toBeUndefined();
		expect(m.byItem.trk).toBeUndefined();
		expect(m.byItem.boom!.state).toBe('rejected');
		// the rejected one is now drawn on the track the apply created (no ghost track any more)
		expect(m.clips.find((c) => c.itemId === 'boom')!.newTrack).toBe(false);
	});

	it('never throws on a preview of another sequence or a missing one', async () => {
		const f = await proposalFixture();
		const st = f.c.getState();
		const empty = buildGhostModel({
			preview: st.preview!,
			committed: st.preview!.base,
			sequenceId: 'seq_missing',
			items: st.items,
			agent: false,
		});
		expect(empty.items).toEqual([]);
		const broken = buildGhostModel({
			preview: {
				...st.preview!,
				result: {
					...st.preview!.result,
					items: { x: { created: ['clp_nope'], changed: [], deleted: ['trk_nope'] } },
				},
			},
			committed: {} as ProjectDocument,
			sequenceId: f.seqId,
			items: [],
			agent: false,
		});
		expect(broken.clips).toEqual([]);
	});
});

describe('setup items (WP3.2)', () => {
	it('are folded under the first item that needs them: their ghosts are drawn as that item', async () => {
		expect(
			[
				...setupOwners([
					{ id: 'bin', requires: [], setup: true },
					{ id: 'snd', requires: ['bin'], setup: true },
					{ id: 'cue', requires: [], setup: true },
					{ id: 'sfx:1', requires: ['snd', 'cue'], setup: false },
					{ id: 'sfx:2', requires: ['snd'], setup: false },
					{ id: 'lonely', requires: [], setup: true },
				]),
			].sort(),
		).toEqual([
			['bin', 'sfx:1'],
			['cue', 'sfx:1'],
			['snd', 'sfx:1'],
		]);
		const f = await proposalFixture();
		const p = f.engine.create({
			feature: 'sound-design',
			title: 'Plan',
			sequenceId: f.seqId,
			items: [
				{
					id: 'cue:1',
					label: 'Cue',
					group: 'setup',
					meta: { setup: true },
					commands: [
						{ type: 'soundCue.add', cues: [{ frame: 80, kind: 'land', weight: 'hero', source: 'agent' }] },
					],
				},
				{
					id: 'sfx:001',
					label: 'Thud on the land',
					group: 'hero',
					requires: ['cue:1'],
					commands: [{ type: 'clip.place', source: { mediaId: f.mediaId }, at: 80, tracks: { audio: 'A2' } }],
				},
			],
		});
		await f.c.setActive(p.id);
		f.flush();
		expect(f.c.getState().items.map((it) => [it.id, it.setup])).toEqual([
			['cue:1', true],
			['sfx:001', false],
		]);
		const m = model(f.session, f.seqId);
		expect(m.cues.map((q) => q.itemId)).toEqual(['sfx:001']);
		expect(m.items.map((x) => x.id)).toEqual(['sfx:001']);
		expect(m.byItem['sfx:001']).toMatchObject({ cues: 1, clips: 1 });
	});
});

describe('ghost geometry', () => {
	it('new video tracks get lanes above the top video row inside the scroll range', () => {
		const videoTracks = [{ id: 'v1' }, { id: 'v2' }, { id: 'v3' }];
		const audioTracks = [{ id: 'a1' }];
		const tracks: GhostModel['tracks'] = [
			{ itemId: 'i1', trackId: 'v4', region: 'video', index: 3, label: 'V4', name: 'Titles' },
			{ itemId: 'i1', trackId: 'v5', region: 'video', index: 4, label: 'V5', name: 'FX' },
		];
		const m = { tracks } as unknown as GhostModel;
		const extent = ghostLaneExtent(m);
		const at = (scrollYVideo: number, lanes: boolean) =>
			computeLayout({
				height: 160,
				dividerRatio: 0.5,
				videoTracks,
				audioTracks,
				heights: {},
				scrollYVideo,
				scrollYAudio: 0,
				...(lanes ? { extraVideoPx: extent.videoPx } : {}),
			});
		const plain = at(0, false);
		const shown = at(0, true);
		expect(shown.video.maxScroll).toBeGreaterThan(plain.video.maxScroll);
		const top = at(1e6, true);
		const rows = ghostTrackRows(m, top);
		expect(rows.map((r) => r.trackId)).toEqual(['v4', 'v5']);
		// Both new lanes can be reached above the existing video tracks.
		for (const row of rows) {
			expect(row.y).toBeGreaterThanOrEqual(top.video.top);
			expect(row.y + row.height).toBeLessThanOrEqual(top.video.rows[0]!.y);
		}
		// a roomy Timeline: nothing moves, the lanes fit above the tracks without scrolling
		const tall = computeLayout({
			height: 600,
			dividerRatio: 0.5,
			videoTracks,
			audioTracks,
			heights: {},
			scrollYVideo: 0,
			scrollYAudio: 0,
			extraVideoPx: extent.videoPx,
		});
		expect(tall.video.maxScroll).toBe(0);
		expect(Math.min(...ghostTrackRows(m, tall).map((r) => r.y))).toBeGreaterThanOrEqual(0);
	});

	it('orders items by time for the keyboard', async () => {
		const f = await proposalFixture();
		const m = model(f.session, f.seqId);
		expect(neighbourItem(m, null, 1, 50)).toBe('cue');
		expect(neighbourItem(m, 'cue', 1)).toBe('boom');
		expect(neighbourItem(m, 'boom', 1)).toBe('boom');
		expect(neighbourItem(m, 'hit', -1)).toBe('move');
		expect(neighbourItem(m, null, 'last')).toBe('boom');
		expect(neighbourItem(m, null, 'first')).toBe('trk');
		expect(neighbourItem({ items: [] }, null, 1)).toBeNull();
	});
});

describe('ghost paint, glyphs, why-line', () => {
	it('why-line: the creator reason, computed facts, meta facts, and why it is stale', async () => {
		const f = await proposalFixture();
		const m = model(f.session, f.seqId);
		const item = f.c.getState().items.find((it) => it.id === 'hit')!;
		const preview = f.c.getState().preview!.result.document.sequences[f.seqId];
		const w = whyLines(item, m, f.seq(), preview);
		expect(w.why).toBe('Cut from Shot A to Shot B');
		for (const fact of ['SFX 1', '00:00:01:00', '4.00 s', '+0.0 dB']) expect(w.facts[0]).toContain(fact);
		expect(w.facts).toContain('support · Impacts');
		expect(w.problem).toBeNull();
		const stale: ReviewItem = {
			...item,
			state: 'stale',
			reason: 'clp_x changed since the proposal was made',
		};
		expect(whyLines(stale, m, f.seq(), preview).problem).toBe('clp_x changed since the proposal was made');
		const hostile = { ...item, meta: { why: 42, facts: [1, '', 'usable fact'] } };
		const h = whyLines(hostile as never, m, f.seq(), preview);
		expect(h.why).toBeNull();
		expect(h.facts.at(-1)).toBe('usable fact');
	});
});
