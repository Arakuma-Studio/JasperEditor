import { EngineClient } from '@jasper/engine-client';
import type { Clip } from '@jasper/project';
import { TransportStore } from '@jasper/session';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createCommandContext, registerAllCommands, runCommand } from '../src/commands/index.ts';
import {
	FitClipDialog,
	INSERT_TIME_DIALOG,
	InsertTimeDialog,
	rememberedFitChoice,
	rememberFitChoice,
	SpeedDurationDialog,
	SubclipDialog,
} from '../src/edit-ux/dialogs.tsx';
import { setSourceTransport } from '../src/panels/program/transport-registry.ts';
import { openInSource, sourceMonitorState } from '../src/panels/source/source-state.ts';
import { setupTimeline, videoAsset } from './timeline-helpers.ts';

beforeAll(() => registerAllCommands());
beforeEach(() => rememberFitChoice(null));
afterEach(() => {
	cleanup();
	sourceMonitorState.setState({ itemId: null });
	setSourceTransport(null);
});
const engine = new EngineClient({ fetch: (async () => new Response('{}')) as unknown as typeof fetch });

function harness() {
	const t = setupTimeline();
	const r = t.apply([{ type: 'media.register', asset: videoAsset(20) }]);
	const mediaId = (r.results[0] as { mediaId: string }).mediaId;
	const itemId = Object.values(t.session.getCommitted().items).find((i) => i.kind === 'media')!.id;
	const dialogs: { kind: string; props: Record<string, unknown> }[] = [];
	const ctx = (panel: 'timeline' | 'source' = 'timeline') =>
		createCommandContext({
			engine,
			session: t.session,
			focus: { panel, instanceId: 'x' },
			openDialog: (kind, props) => dialogs.push({ kind, props: props ?? {} }),
		});
	return { ...t, mediaId, itemId, ctx, dialogs };
}

describe('Insert Time dialog', () => {
	it('Sequence ▸ Insert Time… opens at the playhead and inserts the time on every track in one entry', async () => {
		const h = harness();
		h.apply([
			{
				type: 'clip.place',
				source: { mediaId: h.mediaId },
				at: 0,
				sourceRange: { in: { seconds: 0 }, out: { seconds: 4 } },
			},
			{ type: 'marker.add', frame: 90 },
		]);
		const before = h.session.getCommitted();
		h.session.transport.seek(60);
		await runCommand('timeline.insertTime', h.ctx());
		const opened = h.dialogs.find((d) => d.kind === INSERT_TIME_DIALOG)!;
		expect(opened.props.at).toBe(60);
		render(
			<InsertTimeDialog {...(opened.props as Parameters<typeof InsertTimeDialog>[0])} close={() => {}} />,
		);
		fireEvent.change(screen.getByTestId('insert-time-duration'), { target: { value: '00:00:00:24' } });
		fireEvent.click(screen.getByText('OK'));
		expect(h.spans('V1')).toEqual([
			[0, 60],
			[84, 144],
		]);
		expect(h.spans('A1')).toEqual(h.spans('V1'));
		expect(h.seq().markers[0]!.frame).toBe(114);
		expect(h.history().at(-1)).toBe('Insert Time');
		h.session.undo();
		expect(h.session.getCommitted()).toEqual(before);
	});
});

describe('Speed/Duration dialog', () => {
	it('halving speed ripples linked video and audio in one entry', () => {
		const h = harness();
		h.apply([
			{
				type: 'clip.place',
				source: { mediaId: h.mediaId },
				at: 0,
				sourceRange: { in: { seconds: 0 }, out: { seconds: 2 } },
			},
			{
				type: 'clip.place',
				source: { mediaId: h.mediaId },
				at: 60,
				sourceRange: { in: { seconds: 5 }, out: { seconds: 7 } },
			},
		]);
		const [v, ,] = h.clipsOn('V1');
		const a = h.clipsOn('A1')[0]!;
		render(
			<SpeedDurationDialog
				session={h.session}
				sequenceId={h.seqId}
				clipIds={[v!.id, a.id]}
				close={() => {}}
			/>,
		);
		fireEvent.change(screen.getByTestId('speed-percent'), { target: { value: '50' } });
		fireEvent.click(screen.getByText('Ripple Edit, Shifting Trailing Clips'));
		fireEvent.click(screen.getByText('OK'));
		expect(h.spans('V1')).toEqual([
			[0, 120],
			[120, 180],
		]);
		expect(h.spans('A1')).toEqual(h.spans('V1'));
		expect((h.seq().clips[v!.id] as Clip).speed.rate).toBe(0.5);
		expect(h.history().at(-1)).toBe('Speed/Duration');
	});
});

describe('Fit Clip', () => {
	function fourPoints(h: ReturnType<typeof harness>) {
		h.apply([
			{ type: 'item.setMarks', itemId: h.itemId, in: { seconds: 1 }, out: { seconds: 3 } },
			{ type: 'sequence.setInOut', in: 100, out: 130 },
		]);
		openInSource(h.session, h.itemId);
	}
	it('Insert with four mismatched points opens Fit Clip; Change Clip Speed fits; Always remembers', async () => {
		const h = harness();
		fourPoints(h);
		await runCommand('timeline.overwriteFromSource', h.ctx());
		expect(h.dialogs.map((d) => d.kind)).toEqual(['editux.fitClip']);
		const props = h.dialogs[0]!.props as { apply(f: string): { ok: boolean } };
		render(<FitClipDialog {...(props as unknown as Parameters<typeof FitClipDialog>[0])} close={() => {}} />);
		fireEvent.click(screen.getByText('Always use this choice'));
		fireEvent.click(screen.getByText('OK'));
		const v = h.clipsOn('V1')[0]!;
		expect([v.start, v.duration, v.speed.rate]).toEqual([100, 30, 2]);
		expect(rememberedFitChoice()).toBe('change-speed');
		h.apply([{ type: 'sequence.setInOut', in: 200, out: 230 }]);
		await runCommand('timeline.overwriteFromSource', h.ctx());
		expect(h.dialogs).toHaveLength(1);
		expect(h.clipsOn('V1').map((c) => c.start)).toEqual([100, 200]);
		await runCommand('source.clearFitChoice', h.ctx());
		expect(rememberedFitChoice()).toBeNull();
	});
});

describe('subclips and Mark Split', () => {
	it('makes a named, trim-restricted subclip from Source monitor marks', async () => {
		const h = harness();
		h.apply([{ type: 'item.setMarks', itemId: h.itemId, in: { seconds: 2 }, out: { seconds: 4 } }]);
		openInSource(h.session, h.itemId);
		await runCommand('project.makeSubclip', h.ctx('source'));
		const d = h.dialogs.at(-1)!;
		expect(d.kind).toBe('editux.subclip');
		render(
			<SubclipDialog {...(d.props as unknown as Parameters<typeof SubclipDialog>[0])} close={() => {}} />,
		);
		fireEvent.change(screen.getByTestId('subclip-name'), { target: { value: 'Take A' } });
		fireEvent.click(screen.getByText('Restrict Trims To Subclip Boundaries'));
		fireEvent.click(screen.getByText('OK'));
		const sub = Object.values(h.session.getCommitted().items).find((i) => i.kind === 'subclip')!;
		expect(sub).toMatchObject({
			name: 'Take A',
			restrictTrims: true,
			range: { in: 1_411_200_000, out: 2_822_400_000 },
		});
		expect(h.session.getState().selection.project.items).toEqual([sub.id]);
	});

	it('Mark Split sets the audio In at the Source playhead and is used by Insert', async () => {
		const h = harness();
		openInSource(h.session, h.itemId);
		const t = new TransportStore();
		setSourceTransport(t);
		sourceMonitorState.setState({ fps: 30 });
		h.apply([{ type: 'item.setMarks', itemId: h.itemId, in: { seconds: 2 }, out: { seconds: 4 } }]);
		t.seek(45);
		await runCommand('source.markSplitAudioIn', h.ctx('source'));
		const it = h.session.getCommitted().items[h.itemId] as {
			marks: { split?: { audioIn?: { flicks: number } } };
		};
		expect(it.marks.split?.audioIn?.flicks).toBe(1_058_400_000);
		h.session.transport.seek(200);
		await runCommand('timeline.insertFromSource', h.ctx());
		expect(h.spans('V1')).toEqual([[215, 275]]);
		expect(h.spans('A1')).toEqual([[200, 275]]);
	});
});
