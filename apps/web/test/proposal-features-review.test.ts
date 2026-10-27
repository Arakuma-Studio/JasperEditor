// Generic Review vocabulary and ghosts for the workflow features (spec 15 EA-002): groups from the producer's declared
// `meta.group` in the feature's order with translated labels, feature sentences through the registry (sound design's
// own unchanged), ghosts for adjustment clips, keyframe ranges on clips, transitions and text clips; the "cut" stale
// text; Refresh proposal through the session (and its refusal without a producer).
import { CROSS_DISSOLVE, type Proposal } from '@jasper/project';
import { proposalsFor, type ReviewItem } from '@jasper/session';
import { describe, expect, it } from 'vitest';
import { FakeEngine } from '../../../packages/session/test/fake-proposals-engine.ts';
import { computeLayout } from '../src/panels/timeline/model/layout.ts';
import { buildGhostModel, layoutGhosts, whyLines } from '../src/proposals/ghosts.ts';
import { approvalNeeds, buildReviewModel } from '../src/proposals/review.ts';
import { describeProblem } from '../src/proposals/stale-text.ts';
import { makeSession } from './timeline-helpers.ts';

function item(id: string, o: Partial<ReviewItem> = {}): ReviewItem {
	return {
		id,
		label: o.label ?? id,
		group: o.group ?? '',
		requires: o.requires ?? [],
		setup: o.setup ?? false,
		state: o.state ?? 'pending',
		engineState: o.engineState ?? 'pending',
		alternatives: 1,
		selectedAlternative: 0,
		alternativeLabels: [o.label ?? id],
		meta: o.meta,
		selected: o.selected ?? true,
	};
}

describe('review vocabulary per feature', () => {
	it('groups edit-automation items by meta.group in the declared order, with their labels', () => {
		const items = [
			item('ken', { meta: { group: 'ken-burns', frame: 10 } }),
			item('kit2', { meta: { group: 'cut-kits', frame: 90 } }),
			item('kit1', { meta: { group: 'cut-kits', frame: 30 } }),
			item('zoom', { meta: { group: 'punch-ins', frame: 50 } }),
			item('odd', { group: 'custom-pass', meta: { frame: 5 } }),
			item('trk', { group: 'tracks' }),
			item('none'),
			// a sound role means nothing here: grouped by its group
			item('role', { group: 'reactions', meta: { role: 'hero', frame: 70 } }),
		];
		const m = buildReviewModel(items, null, 'edit-automation');
		expect(m.groups.map((g) => [g.id, g.label, g.rows.map((r) => r.item.id)])).toEqual([
			['cut-kits', 'Cut kits', ['kit1', 'kit2']],
			['punch-ins', 'Punch-ins', ['zoom']],
			['ken-burns', 'Ken Burns', ['ken']],
			['reactions', 'Reactions', ['role']],
			['custom-pass', 'Custom-pass', ['odd']],
			['other', 'Other', ['none']],
			['tracks', 'Tracks', ['trk']],
		]);
	});

	it('a hostile group never throws', () => {
		const items = [item('x', { meta: { group: { evil: true } } }), item('y', { meta: 'nope' as never })];
		expect(buildReviewModel(items, null, 'edit-automation').groups.map((g) => g.id)).toEqual(['other']);
	});

	it('names an agent grant of Project Settings ▸ Agent Proposals in the Apply confirmation', () => {
		const p = {
			items: [
				{
					id: 'g',
					label: 'grant',
					group: '',
					requires: [],
					state: 'pending',
					commands: [{ type: 'project.updateSettings', settings: { agentProposals: { subtitles: true } } }],
				},
			],
		} as unknown as Proposal;
		expect(approvalNeeds(p, ['g'])).toEqual([{ kind: 'agentProposals', features: ['subtitles'] }]);
	});

	it('says where a cut went', () => {
		const seq = { settings: { frameRate: { num: 30, den: 1 }, dropFrame: false, startTimecodeFrames: 0 } };
		expect(
			describeProblem(
				{ type: 'anchor', id: 'cut@t@60', entity: 'cut', change: 'frame', at: 60, to: 50 },
				seq as never,
			),
		).toBe('Cut at 00:00:02:00 moved to 00:00:01:20');
		expect(
			describeProblem(
				{ type: 'anchor', id: 'cut@t@60', entity: 'cut', change: 'deleted', at: 60 },
				seq as never,
			),
		).toBe('Cut at 00:00:02:00 is gone');
	});
});

/** V1: two solids meeting at 60; a 4-item edit-automation proposal under review. */
async function fixture() {
	const { session, seqId } = makeSession();
	const setup = session.apply({
		label: 'setup',
		origin: 'user',
		sequenceId: seqId,
		commands: [
			{ type: 'clip.addSolid', at: 0, duration: 60, track: 'V1', color: [1, 0, 0, 1], ref: '$a' },
			{ type: 'clip.addSolid', at: 60, duration: 60, track: 'V1', color: [0, 0, 1, 1], ref: '$b' },
		] as never[],
	});
	if (!setup.ok) throw new Error(JSON.stringify(setup.errors));
	const a = setup.refs.$a!;
	const engine = new FakeEngine(() => session);
	const timers: (() => void)[] = [];
	const c = proposalsFor(session, { engine, setTimer: (fn) => timers.push(fn), clearTimer: () => undefined });
	c.connect(engine.subscribe);
	const p = engine.create({
		feature: 'edit-automation',
		title: 'Decorate Cuts',
		sequenceId: seqId,
		items: [
			{
				id: 'kit',
				label: 'Kit at the cut',
				meta: { group: 'cut-kits', frame: 60 },
				commands: [
					{
						type: 'clip.addAdjustmentBatch',
						trackId: 'V2',
						items: [
							{
								start: 50,
								length: 20,
								effects: [
									{
										effectId: 'jasper.gaussian-blur',
										keyframes: {
											radius: [
												{ frame: 0, value: 0 },
												{ frame: 10, value: 40 },
												{ frame: 20, value: 0 },
											],
										},
									},
								],
							},
						],
					},
				],
			},
			{
				id: 'zoom',
				label: 'Punch-in',
				meta: { group: 'punch-ins', frame: 30 },
				commands: [
					{
						type: 'keyframe.addBatch',
						targets: [
							{
								clipId: a,
								path: ['opacity'],
								keys: [
									{ at: { frames: 30 }, value: 100 },
									{ at: { frames: 37 }, value: 50 },
								],
							},
						],
					},
				],
			},
			{
				id: 'dissolve',
				label: 'Dissolve',
				meta: { group: 'slides', frame: 60 },
				commands: [{ type: 'transition.add', trackId: 'V1', at: 60, effectId: CROSS_DISSOLVE, duration: 10 }],
			},
			{
				id: 'title',
				label: 'Title',
				meta: { group: 'reactions', frame: 0 },
				commands: [
					{
						type: 'clip.addText',
						at: 0,
						duration: 30,
						track: 'V3',
						content: { text: 'Hi', style: { sizePx: 96 } },
					},
				],
			},
		],
	});
	await c.setActive(p.id);
	while (timers.length) timers.shift()!();
	return { session, seqId, c, engine, p, a };
}

describe('ghosts of the workflow features', () => {
	it('draws the adjustment clip, the keyframe range, the transition and the text clip, per item', async () => {
		const f = await fixture();
		const st = f.c.getState();
		expect(st.items.map((i) => i.state)).toEqual(['pending', 'pending', 'pending', 'pending']);
		const m = buildGhostModel({
			preview: st.preview!,
			committed: st.preview!.base,
			sequenceId: f.seqId,
			items: st.items,
			agent: true,
		});
		const kit = m.clips.find((x) => x.itemId === 'kit')!;
		expect(kit).toMatchObject({ kind: 'adjustment', start: 50, duration: 20, change: 'created' });
		// keys of the created clip: its whole span of keys
		expect(m.keys.find((k) => k.itemId === 'kit')).toMatchObject({ start: 50, end: 69, count: 3 });
		expect(m.keys.find((k) => k.itemId === 'kit')!.frames).toEqual([50, 60, 69]);
		// keys added to an existing clip: where they are
		const zoom = m.keys.find((k) => k.itemId === 'zoom')!;
		expect(zoom).toMatchObject({ clipId: f.a, start: 30, end: 37, frames: [30, 37], count: 2 });
		// the keyed clip is also drawn as changed (wash + ghost, like any changed clip); the key band is extra
		expect(m.byItem.zoom).toMatchObject({ keys: 1, clips: 1, removals: 1 });
		const tr = m.transitions.find((x) => x.itemId === 'dissolve')!;
		expect(tr).toMatchObject({ start: 55, duration: 10, change: 'created', name: 'Cross Dissolve' });
		expect(m.byItem.dissolve!.transitions).toBe(1);
		expect(m.clips.find((x) => x.itemId === 'title')).toMatchObject({ kind: 'text', start: 0, duration: 30 });
		// why-lines name them
		const seq = f.session.getCommitted().sequences[f.seqId]!;
		const zoomItem = st.items.find((i) => i.id === 'zoom')!;
		expect(whyLines(zoomItem, m, seq, st.preview!.result.document.sequences[f.seqId]).facts).toContain(
			`2 keyframes on ${seq.clips[f.a]!.name} from 00:00:01:00 to 00:00:01:07`,
		);
		const disItem = st.items.find((i) => i.id === 'dissolve')!;
		expect(whyLines(disItem, m, seq, undefined).facts[0]).toBe(
			'Cross Dissolve on V1 at 00:00:01:25 (10 frames)',
		);
		// laid out on their rows
		const layout = computeLayout({
			height: 600,
			dividerRatio: 0.5,
			videoTracks: seq.videoTracks,
			audioTracks: seq.audioTracks,
			heights: {},
			scrollYVideo: 0,
			scrollYAudio: 0,
		});
		const placed = layoutGhosts(m, layout, { scrollFrame: 0, pxPerFrame: 2, width: 1000 });
		expect(placed.transitions.map((x) => x.transitionId)).toEqual([tr.transitionId]);
		expect(placed.keys.find((k) => k.itemId === 'zoom')!.xs).toEqual([61, 75]);
		// the review groups them by their declared groups
		expect(buildReviewModel(st.items, m, 'edit-automation').groups.map((g) => g.id)).toEqual([
			'cut-kits',
			'punch-ins',
			'reactions',
			'slides',
		]);
	});
});
