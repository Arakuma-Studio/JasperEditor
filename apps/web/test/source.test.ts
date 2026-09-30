import { EngineClient } from '@jasper/engine-client';
import {
	applyTransaction,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	FLICKS_PER_SECOND,
} from '@jasper/project';
import { EditorSession, TransportStore } from '@jasper/session';
import { beforeEach, describe, expect, it } from 'vitest';
import { createCommandContext, registerAllCommands, runCommand } from '../src/commands/index.ts';
import { setSourceTransport } from '../src/panels/program/transport-registry.ts';
import {
	closeSource,
	openInSource,
	performSourceEdit,
	setSourceMarks,
	sourceMonitorState,
} from '../src/panels/source/source-state.ts';

function makeSession() {
	const ids = createCounterIdSource(1);
	const doc = createEmptyProject({ ids, name: 'S', preset: 'hd-1080p-30' });
	const ctx = { ids, now: () => 't', registries: defaultRegistries() };
	const { document, result } = applyTransaction(
		doc,
		{
			label: 'import',
			origin: 'user',
			commands: [
				{
					type: 'media.register',
					ref: '$m',
					itemRef: '$item',
					asset: {
						kind: 'video',
						fingerprint: 'q1:test',
						originalName: 'clip.mp4',
						sizeBytes: 1,
						container: 'mp4',
						probe: {
							durationFlicks: 10 * FLICKS_PER_SECOND,
							startTimecode: null,
							streams: [
								{
									index: 0,
									type: 'video',
									codec: 'h264',
									width: 1920,
									height: 1080,
									pixelAspect: { num: 1, den: 1 },
									frameRate: { num: 30, den: 1 },
									pixelFormat: 'yuv420p',
									bitDepth: 8,
									color: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', range: 'tv' },
									browserDecodable: true,
								},
								{
									index: 1,
									type: 'audio',
									codec: 'aac',
									sampleRate: 48000,
									channels: 2,
									channelLayout: 'stereo',
								},
							],
							rotationDegrees: 0,
							hasAlpha: false,
							variableFrameRate: false,
						},
						locators: [{ type: 'engine-store', engineId: 'e', key: 'mk_1' }],
					},
				},
			],
		},
		{ ...ctx, revision: 0 },
	);
	expect(result.ok).toBe(true);
	const itemId = result.ok ? result.refs.$item! : '';
	const session = new EditorSession({ projectId: document.projectId, document, ctx });
	return { session, itemId };
}

describe('Source monitor state (S03:SRC-001…004)', () => {
	beforeEach(() =>
		sourceMonitorState.setState({
			itemId: null,
			recent: [],
			fps: 30,
			durationFrames: 300,
			markIn: null,
			markOut: null,
		}),
	);

	it('opens media items and keeps a recent list', () => {
		const { session, itemId } = makeSession();
		expect(openInSource(session, 'itm_nope')).toBe(false);
		expect(openInSource(session, itemId)).toBe(true);
		expect(sourceMonitorState.getState()).toMatchObject({ itemId, recent: [itemId] });
		closeSource();
		expect(sourceMonitorState.getState().itemId).toBeNull();
	});

	it('stores marks on the item through item.setMarks (undoable)', () => {
		const { session, itemId } = makeSession();
		openInSource(session, itemId);
		expect(setSourceMarks(session, { in: 30 }, 'Mark In')).toBe(true);
		sourceMonitorState.setState({ markIn: 30 });
		expect(setSourceMarks(session, { out: 90 }, 'Mark Out')).toBe(true);
		const item = session.getCommitted().items[itemId] as {
			marks: { in: { flicks: number }; out: { flicks: number } };
		};
		expect(item.marks.in.flicks).toBe(FLICKS_PER_SECOND);
		expect(item.marks.out.flicks).toBe(3 * FLICKS_PER_SECOND);
		expect(session.getState().history.entries.map((e) => e.label)).toEqual(['Mark In', 'Mark Out']);
		session.undo();
		expect((session.getCommitted().items[itemId] as { marks: { out: unknown } }).marks.out).toBeNull();
	});

	it('Insert / Overwrite place the marked range at the sequence playhead (AC-SRC-1 logic)', () => {
		const { session, itemId } = makeSession();
		openInSource(session, itemId);
		sourceMonitorState.setState({ markIn: null });
		setSourceMarks(session, { in: 30 });
		sourceMonitorState.setState({ markIn: 30 });
		setSourceMarks(session, { out: 90 });
		session.transport.seek(15);
		const r = performSourceEdit(session, 'overwrite');
		expect(r.ok).toBe(true);
		const seq = Object.values(session.getCommitted().sequences)[0]!;
		const placed = r.clipIds!.map((id) => seq.clips[id]!);
		expect(placed.map((c) => c.kind).sort()).toEqual(['audio', 'video']);
		for (const c of placed) {
			expect(c.start).toBe(15);
			expect(c.duration).toBe(60);
			expect(c.sourceIn).toBe(FLICKS_PER_SECOND);
		}
		expect(session.transport.getState().frame).toBe(75);
		const ins = performSourceEdit(session, 'insert');
		expect(ins.ok).toBe(true);
		expect(session.getState().history.entries.at(-1)!.label).toBe('Insert');
	});

	it('with the Source monitor focused, I/O and Shift+I act on the source item, not the sequence', async () => {
		registerAllCommands();
		const { session, itemId } = makeSession();
		openInSource(session, itemId);
		const t = new TransportStore();
		setSourceTransport(t);
		try {
			const ctx = createCommandContext({
				engine: new EngineClient({ baseUrl: '' }),
				session,
				focus: { panel: 'source', instanceId: 's' },
			});
			t.seek(30);
			expect((await runCommand('timeline.markIn', ctx)).ran).toBe(true);
			sourceMonitorState.setState({ markIn: 30 }); // mirrored by <SourceMonitor> from the document
			t.seek(89);
			expect((await runCommand('timeline.markOut', ctx)).ran).toBe(true);
			const item = session.getCommitted().items[itemId] as {
				marks: { in: { flicks: number }; out: { flicks: number } };
			};
			expect(item.marks.in.flicks).toBe(FLICKS_PER_SECOND);
			expect(item.marks.out.flicks).toBe(3 * FLICKS_PER_SECOND);
			const seq = Object.values(session.getCommitted().sequences)[0]!;
			expect([seq.inPoint, seq.outPoint]).toEqual([null, null]);
			t.seek(200);
			await runCommand('timeline.goToIn', ctx);
			expect(t.getState().frame).toBe(30);
		} finally {
			setSourceTransport(null);
		}
	});

	it('refuses when nothing is open', () => {
		const { session } = makeSession();
		expect(performSourceEdit(session, 'insert').ok).toBe(false);
	});
});
