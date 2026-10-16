// Proposal ghosts, the pure part (spec 12 §2.7 "Review"): which entities become ghost clips, removal washes, ghost
// tracks and ghost cues (attributed to their items), where they are drawn (rows of new tracks, x at the frame,
// culling), the keyboard order, the paint per item state (normal and high contrast), the state glyphs, the why-line
// and the accessible names.
import type { ProjectDocument, Sequence } from '@jasper/project';
import { type EditorSession, proposalsFor, type ReviewItem } from '@jasper/session';
import { describe, expect, it } from 'vitest';
import { computeLayout } from '../src/panels/timeline/model/layout.ts';
import {
	buildGhostModel,
	ghostAriaLabel,
	ghostCueId,
	ghostPaint,
	ghostTrackRows,
	layoutGhosts,
	neighbourItem,
	setupOwners,
	stateGlyph,
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

const layoutOf = (seq: Sequence) =>
	computeLayout({
		height: 400,
		dividerRatio: 0.5,
		videoTracks: seq.videoTracks,
		audioTracks: seq.audioTracks,
		heights: {},
		scrollYVideo: 0,
		scrollYAudio: 0,
	});

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
				cue: expect.objectContaining({ id: ghostCueId(f.cueId), frame: 70 }),
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
	it('places new audio tracks below the last audio row, clips at their frames, and culls what is out of view', async () => {
		const f = await proposalFixture();
		const m = model(f.session, f.seqId);
		const layout = layoutOf(f.seq());
		const rows = ghostTrackRows(m, layout);
		const last = layout.audio.rows.at(-1)!;
		expect(rows).toEqual([expect.objectContaining({ region: 'audio', y: last.y + last.height, height: 40 })]);
		const v = { scrollFrame: 0, pxPerFrame: 2, width: 500 };
		const g = layoutGhosts(m, layout, v);
		const hit = g.clips.find((c) => c.itemId === 'hit')!;
		expect([hit.x, hit.y, hit.w]).toEqual([60, rows[0]!.y, (hit.duration as number) * 2]);
		// the moved bed's ghost at 400 → x 800: out of view; its wash at 0 is drawn on A1
		expect(g.clips.some((c) => c.itemId === 'move')).toBe(false);
		const wash = g.removals[0]!;
		expect([wash.x, wash.y]).toEqual([0, layout.audio.rows[0]!.y]);
		const scrolled = layoutGhosts(m, layout, { ...v, scrollFrame: 300 });
		expect(scrolled.clips.find((c) => c.itemId === 'move')!.x).toBe(200);
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
	it('paints each state: pending dashed, accepted solid ✓, rejected 35 % hatched ✕, stale/invalid warning !', () => {
		const n = { highContrast: false, selected: false };
		expect(ghostPaint('pending', n)).toMatchObject({
			borderStyle: 'dashed',
			borderWidth: 1,
			opacity: 1,
			hatch: false,
		});
		expect(ghostPaint('accepted', n)).toMatchObject({
			borderStyle: 'solid',
			glyphColor: 'var(--pr-success)',
		});
		expect(ghostPaint('rejected', n)).toMatchObject({ opacity: 0.35, hatch: true });
		expect(ghostPaint('stale', n).borderColor).toBe('var(--pr-warning)');
		expect(ghostPaint('invalid', n).borderColor).toBe('var(--pr-warning)');
		expect(ghostPaint('pending', { highContrast: true, selected: false })).toMatchObject({
			borderStyle: 'solid',
			borderWidth: 2,
		});
		expect(ghostPaint('pending', { highContrast: false, selected: true }).borderColor).toBe(
			'var(--pr-focus-ring)',
		);
		expect([
			stateGlyph('accepted', false),
			stateGlyph('rejected', false),
			stateGlyph('stale', false),
		]).toEqual(['✓', '✕', '!']);
		// pending: told by the dashes, and by a glyph when high contrast makes every stroke solid
		expect(stateGlyph('pending', false)).toBeNull();
		expect(stateGlyph('pending', true)).toBe('○');
	});

	it('why-line: the creator reason, computed facts, meta facts, and why it is stale', async () => {
		const f = await proposalFixture();
		const m = model(f.session, f.seqId);
		const item = f.c.getState().items.find((it) => it.id === 'hit')!;
		const preview = f.c.getState().preview!.result.document.sequences[f.seqId];
		const w = whyLines(item, m, f.seq(), preview);
		expect(w.why).toBe('Cut from Shot A to Shot B');
		expect(w.facts[0]).toMatch(/on A\d · SFX 1 \(new\) at 00:00:01:00 \(\d+\.\d\d s, \+0\.0 dB\)/);
		expect(w.facts).toContain('support · Impacts');
		expect(w.problem).toBeNull();
		const stale: ReviewItem = {
			...item,
			state: 'stale',
			reason: 'clp_x changed since the proposal was made',
		};
		expect(whyLines(stale, m, f.seq(), preview).problem).toBe('clp_x changed since the proposal was made');
		const hostile = { ...item, meta: { why: 42, facts: [1, '', 'ok'.repeat(200)] } };
		const h = whyLines(hostile as never, m, f.seq(), preview);
		expect(h.why).toBeNull();
		expect(h.facts.at(-1)!.length).toBe(160);
		expect(ghostAriaLabel(m.byItem.hit!, w.why, f.seq())).toBe(
			'Proposed: Hit on the cut, pending, at 00:00:01:00. Cut from Shot A to Shot B',
		);
	});
});
