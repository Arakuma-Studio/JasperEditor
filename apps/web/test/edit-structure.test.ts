// edit-structure UI commands against a real session: Group / Ungroup and Alt-selection, Add Frame Hold, Insert Frame
// Hold Segment, Join Through Edits, Go to Gap, Make Subsequence, Unnest, Reveal Nested Sequence, Match Frame through
// nests, synthetic New Items, Remove Unused, the nest/individual placement toggle and the Source monitor's sequence
// and synthetic sources.
import { EngineClient } from '@jasper/engine-client';
import { beforeAll, describe, expect, it } from 'vitest';
import {
	type CommandCtx,
	createCommandContext,
	registerAllCommands,
	runCommand,
	type ToastRequest,
} from '../src/commands/index.ts';
import { resolveMatchFrame } from '../src/commands/structure.ts';
import {
	openInSource,
	performSourceEdit,
	sourceMonitorState,
	syntheticPreviewDoc,
} from '../src/panels/source/source-state.ts';
import { itemAvKinds, itemDurationFrames } from '../src/panels/timeline/model/drop.ts';
import { setupTimeline, solid, videoAsset } from './timeline-helpers.ts';

const engine = new EngineClient({ fetch: (async () => new Response('{}')) as unknown as typeof fetch });

beforeAll(() => registerAllCommands());

function harness() {
	const t = setupTimeline({});
	const toasts: ToastRequest[] = [];
	const ctx: CommandCtx = createCommandContext({
		engine,
		session: t.session,
		focus: { panel: 'timeline', instanceId: 'x' },
		toast: (r) => toasts.push(r),
	});
	const run = async (id: string, args?: unknown) => {
		const r = await runCommand(id, ctx, args);
		expect(r.ran, `${id}: ${r.reason}`).toBe(true);
	};
	const movie = (at: number, track = 'V1') => {
		const r = t.apply([{ type: 'media.register', asset: videoAsset(20) }]);
		const mediaId = (r.results[0] as { mediaId: string }).mediaId;
		const p = t.apply([
			{
				type: 'clip.place',
				source: { mediaId },
				at,
				tracks: { video: track },
				sourceRange: { in: { seconds: 0 }, out: { seconds: 10 } },
			},
		]);
		return { mediaId, ids: (p.results[0] as { clipIds: string[] }).clipIds };
	};
	return { ...t, ctx, run, toasts, movie };
}

describe('groups', () => {
	it('groups the selection, selects groups together and Alt-selects one member', async () => {
		const h = harness();
		h.apply([solid(0, 60, 'V1'), solid(30, 60, 'V2')]);
		const [a, b] = [h.clipsOn('V1')[0]!.id, h.clipsOn('V2')[0]!.id];
		h.session.select('timeline', [a, b], 'replace');
		await h.run('timeline.group');
		expect(h.seq().clips[a]!.groupId).not.toBeNull();
		h.session.select('timeline', [a], 'replace');
		expect(h.session.getState().selection.timeline.clips.sort()).toEqual([a, b].sort());
		h.session.select('timeline', [a], 'replace', { groups: false });
		expect(h.session.getState().selection.timeline.clips).toEqual([a]);
		h.session.select('timeline', [a], 'replace');
		await h.run('timeline.ungroup');
		expect(h.seq().clips[a]!.groupId).toBeNull();
	});
});

describe('frame holds, through edits, gaps, subsequences', () => {
	it('adds a frame hold at the playhead and inserts a hold segment', async () => {
		const h = harness();
		h.movie(0);
		h.session.transport.seek(100);
		await h.run('timeline.addFrameHold');
		const held = h.clipsOn('V1').find((c) => c.frameHold)!;
		expect(held.start).toBe(100);
		h.session.select('timeline', [], 'replace');
		h.session.transport.seek(40);
		await h.run('timeline.insertFrameHoldSegment');
		expect(h.clipsOn('V1').map((c) => [c.start, c.duration])).toEqual([
			[0, 40],
			[40, 60],
			[100, 60],
			[160, 200],
		]);
	});

	it('joins through edits, goes to gaps and makes a subsequence', async () => {
		const h = harness();
		const { ids } = h.movie(0);
		h.session.transport.seek(50);
		await h.run('timeline.addEditAllTracks');
		expect(h.clipsOn('V1')).toHaveLength(2);
		h.session.select('timeline', [], 'replace');
		await h.run('timeline.joinThroughEdits');
		expect(h.clipsOn('V1')).toHaveLength(1);
		h.apply([solid(400, 30, 'V1')]);
		h.session.transport.seek(10);
		await h.run('sequence.goToNextGap');
		expect(h.session.transport.getState().frame).toBe(300);
		h.session.transport.seek(350);
		await h.run('sequence.goToPrevGap');
		expect(h.session.transport.getState().frame).toBe(300);
		h.session.select('timeline', ids, 'replace');
		const before = Object.keys(h.session.getCommitted().sequences).length;
		await h.run('sequence.makeSubsequence');
		expect(Object.keys(h.session.getCommitted().sequences)).toHaveLength(before + 1);
	});
});

describe('nests', () => {
	it('unnests, reveals the nested sequence and matches frames through it', async () => {
		const h = harness();
		const { ids, mediaId } = h.movie(30);
		const r = h.apply([{ type: 'clip.nest', clipIds: ids, name: 'N' }]);
		const { sequenceId, clipIds } = r.results[0] as { sequenceId: string; clipIds: string[] };
		const doc = h.session.getCommitted();
		const hit = resolveMatchFrame(doc, h.seq(), 40);
		expect(hit?.clip.kind).toBe('video');
		expect((hit!.clip as { mediaId: string }).mediaId).toBe(mediaId);
		expect(Math.round(hit!.contentFlicks / (705_600_000 / 30))).toBe(10);
		h.session.transport.seek(45);
		await h.run('timeline.revealNested');
		expect(h.session.getState().activeSequenceId).toBe(sequenceId);
		expect(h.session.transport.getState().frame).toBe(15);
		h.session.openSequence(h.seqId);
		h.session.select('timeline', clipIds, 'replace');
		await h.run('clip.unnest');
		expect(h.clipsOn('V1')[0]!.kind).toBe('video');
		expect(h.clipsOn('V1')[0]!.start).toBe(30);
	});

	it('places a sequence from the Source monitor as a nest or as individual clips', () => {
		const h = harness();
		h.movie(0);
		const created = h.apply([{ type: 'sequence.create', name: 'Main 2', ref: '$s' }]);
		const other = created.refs.$s!;
		const item = Object.values(h.session.getCommitted().items).find(
			(i) => i.kind === 'sequence' && i.sequenceId === h.seqId,
		)!;
		expect(itemAvKinds(h.session.getCommitted(), item)).toEqual({ video: true, audio: true });
		expect(itemDurationFrames(h.session.getCommitted(), item, { num: 30, den: 1 })).toBe(300);
		h.session.openSequence(other);
		expect(openInSource(h.session, item.id)).toBe(true);
		h.session.transport.seek(0);
		const r = performSourceEdit(h.session, 'overwrite');
		expect(r.ok).toBe(true);
		const kinds = r.clipIds!.map((id) => h.session.getCommitted().sequences[other]!.clips[id]!.kind).sort();
		expect(kinds).toEqual(['nest-audio', 'nest-video']);
		h.session.setToggles({ insertSequencesAsNests: false });
		h.session.transport.seek(400);
		const r2 = performSourceEdit(h.session, 'overwrite');
		expect(r2.ok).toBe(true);
		const kinds2 = r2.clipIds!.map((id) => h.session.getCommitted().sequences[other]!.clips[id]!.kind).sort();
		expect(kinds2).toEqual(['audio', 'video']);
		sourceMonitorState.setState({ itemId: null });
	});
});

describe('synthetic sources and project operations', () => {
	it('creates New Items, previews them and removes unused ones', async () => {
		const h = harness();
		await h.run('project.newBarsAndTone');
		await h.run('project.newAdjustmentLayer');
		await h.run('project.newBlackVideo');
		await h.run('project.newTransparentVideo');
		const doc = h.session.getCommitted();
		const kinds = Object.values(doc.synthetics)
			.map((s) => s.kind)
			.sort();
		expect(kinds).toEqual(['adjustment', 'bars-and-tone', 'black-video', 'transparent']);
		const bars = Object.values(doc.items).find(
			(i) => i.kind === 'synthetic' && doc.synthetics[i.syntheticId]?.kind === 'bars-and-tone',
		) as Extract<(typeof doc.items)[string], { kind: 'synthetic' }>;
		const preview = syntheticPreviewDoc(doc, bars, h.seq().settings, 30);
		expect(preview).not.toBeNull();
		expect(preview!.videoTracks[0]!.clips[0]!.source).toEqual({ generator: { kind: 'bars' } });
		expect(preview!.audioClips[0]!.generator?.kind).toBe('tone');
		expect(itemDurationFrames(doc, bars, { num: 30, den: 1 })).toBe(30);
		await h.run('edit.removeUnused');
		expect(Object.keys(h.session.getCommitted().synthetics)).toHaveLength(0);
	});

	it('duplicates a sequence item', async () => {
		const h = harness();
		const item = Object.values(h.session.getCommitted().items).find((i) => i.kind === 'sequence')!;
		await h.run('project.duplicateSequence', { itemIds: [item.id] });
		expect(Object.keys(h.session.getCommitted().sequences)).toHaveLength(2);
	});
});
