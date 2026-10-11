import { EngineClient } from '@jasper/engine-client';
import {
	buildRenderSnapshot,
	type Clip,
	isMulticamClip,
	type MulticamClip,
	type RenderSnapshot,
} from '@jasper/project';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
	type CommandCtx,
	createCommandContext,
	DEFAULT_KEYMAP,
	registerAllCommands,
	runCommand,
	type ToastRequest,
} from '../src/commands/index.ts';
import { buildMulticamViewDoc, gridLayout } from '../src/multicam/logic.ts';
import { pressCamera, stopRecording } from '../src/multicam/recorder.ts';
import { multicamRecorderStore, multicamViewStore } from '../src/multicam/state.ts';
import { makeSession, videoAsset } from './timeline-helpers.ts';

const engine = new EngineClient({ fetch: (async () => new Response('{}')) as unknown as typeof fetch });
beforeAll(() => registerAllCommands());
beforeEach(() => {
	multicamViewStore.setState({
		view: false,
		showPreview: true,
		topDown: false,
		audioFollowsVideo: true,
		layout: 'auto',
		page: 0,
	});
	multicamRecorderStore.setState({ recording: false, sequenceId: null, trackId: null, cuts: [] });
});

function harness(cameras = 3) {
	const { session, seqId } = makeSession();
	const toasts: ToastRequest[] = [];
	const apply = (commands: unknown[]) => {
		const r = session.apply({ label: 't', origin: 'user', sequenceId: seqId, commands: commands as never[] });
		if (!r.ok) throw new Error(JSON.stringify(r.errors));
		return r;
	};
	const items: string[] = [];
	for (let i = 0; i < cameras; i++) {
		const r = apply([{ type: 'media.register', asset: videoAsset(20) }]);
		items.push((r.results[0] as { itemId: string }).itemId);
	}
	const mc = apply([{ type: 'multicam.create', itemIds: items, method: 'in', audio: 'switch' }]);
	const source = (mc.results[0] as { sequenceId: string }).sequenceId;
	apply([{ type: 'clip.place', source: { sequenceId: source }, at: 0, sequenceId: seqId }]);
	const ctx: CommandCtx = createCommandContext({
		engine,
		session,
		focus: { panel: 'program', instanceId: 'p' },
		toast: (r) => toasts.push(r),
	});
	const seq = () => session.getCommitted().sequences[seqId]!;
	const v1 = () =>
		Object.values(seq().clips)
			.filter((c): c is MulticamClip => c.kind === 'nest-video' && isMulticamClip(c as Clip))
			.sort((a, b) => a.start - b.start)
			.map((c) => [c.start, c.start + c.duration, cameraOf(c)]);
	const angles = () => session.getCommitted().sequences[source]!.multicam!.angles;
	const cameraOf = (c: MulticamClip) => angles().findIndex((a) => a.id === c.multicam.angle) + 1;
	const toast = (_k: string, m: string) => toasts.push({ kind: 'info', message: m });
	return { session, seqId, source, ctx, toasts, v1, angles, toast, items };
}

describe('camera keys and live recording', () => {
	it('stopped: keys 1–9 switch the clip at the playhead; Ctrl+N cuts there — one undo step each', async () => {
		const h = harness();
		h.session.transport.seek(50);
		const r = await runCommand('multicam.selectCamera2', h.ctx);
		expect(r.ran).toBe(true);
		expect(h.v1()).toEqual([[0, 600, 2]]);
		h.session.transport.seek(100);
		await runCommand('multicam.cutToCamera3', h.ctx);
		expect(h.v1()).toEqual([
			[0, 100, 2],
			[100, 600, 3],
		]);
		h.session.undo();
		expect(h.v1()).toEqual([[0, 600, 2]]);
	});

	it('playing: presses record cuts into one gesture, shown live and committed on stop as one History entry', () => {
		const h = harness();
		const before = h.session.getState().history.entries.length;
		h.session.transport.seek(10);
		h.session.transport.play(1);
		const install = (async () => {
			const { installMulticamRecorder } = await import('../src/multicam/recorder.ts');
			return installMulticamRecorder(h.session);
		})();
		return install.then((uninstall) => {
			for (const [f, n] of [
				[30, 2],
				[60, 3],
				[90, 1],
				[120, 2],
			] as const) {
				h.session.transport.seek(f);
				h.session.transport.play(1);
				expect(pressCamera(h.session, n, 'select', h.toast)).toBe(true);
			}
			expect(multicamRecorderStore.getState().recording).toBe(true);
			const drawn = h.session.getDrawn().sequences[h.seqId]!;
			expect(Object.values(drawn.clips).filter((c) => c.kind === 'nest-video')).toHaveLength(5);
			expect(h.session.getState().history.entries.length).toBe(before);
			h.session.transport.pause();
			expect(multicamRecorderStore.getState().recording).toBe(false);
			expect(h.v1()).toEqual([
				[0, 30, 1],
				[30, 60, 2],
				[60, 90, 3],
				[90, 120, 1],
				[120, 600, 2],
			]);
			const entries = h.session.getState().history.entries;
			expect(entries.length).toBe(before + 1);
			expect(entries.at(-1)!.label).toBe('Record Multi-Camera');
			h.session.undo();
			expect(h.v1()).toEqual([[0, 600, 1]]);
			uninstall();
		});
	});

	it('a pass with no cuts commits nothing; a missing camera is refused', () => {
		const h = harness(2);
		h.session.transport.seek(5);
		expect(pressCamera(h.session, 7, 'select', h.toast)).toBe(false);
		expect(stopRecording(h.session)).toBeNull();
		expect(h.toasts.at(-1)!.message).toMatch(/no camera 7/);
	});
});

describe('Multi-Camera view document', () => {
	it('lays out the shown cameras in a grid next to the program, frame-synced in one sequence', () => {
		const h = harness(5);
		const doc = h.session.getCommitted();
		const mv = buildMulticamViewDoc(doc, h.seqId, 0, {
			showPreview: true,
			topDown: false,
			layout: 'auto',
			page: 0,
		})!;
		expect(mv.width).toBe(3840);
		expect(mv.layout).toMatchObject({ cols: 3, rows: 3, pages: 1, count: 5 });
		expect(mv.cells.map((c) => c.camera)).toEqual([1, 2, 3, 4, 5]);
		expect(mv.program).toEqual({ x: 1920, y: 0, width: 1920, height: 1080 });
		const snap: RenderSnapshot = buildRenderSnapshot(mv.doc, mv.sequenceId, {
			resolveMedia: () => null,
			resolveFont: () => null,
		});
		const layers = snap.videoTracks.flatMap((t) => t.clips);
		expect(layers).toHaveLength(6);
		const cellMedia = layers
			.filter((l) => l.name !== 'Program')
			.map((l) =>
				(l.source as { nest: { snapshot: RenderSnapshot } }).nest.snapshot.videoTracks.flatMap(
					(t) => t.clips,
				),
			)
			.map((cs) => (cs[0]!.source as { mediaId: string }).mediaId);
		expect(new Set(cellMedia).size).toBe(5);
		expect(snap.audioClips.length).toBeGreaterThan(0);
		const p2 = buildMulticamViewDoc(doc, h.seqId, 0, {
			showPreview: false,
			topDown: false,
			layout: 2,
			page: 1,
		})!;
		expect(p2.width).toBe(1920);
		expect(p2.layout).toMatchObject({ page: 1, pages: 2, first: 4, count: 1 });
		expect(p2.cells.map((c) => c.camera)).toEqual([5]);
		expect(gridLayout(17, 'auto', 0)).toMatchObject({ cols: 4, pages: 2, count: 16 });
	});

	it('camera keys pick page-relative cameras on later pages', () => {
		const h = harness(5);
		multicamViewStore.setState({ layout: 2, page: 1 });
		h.session.transport.seek(10);
		expect(pressCamera(h.session, 1, 'select', h.toast)).toBe(true);
		expect(h.v1()).toEqual([[0, 600, 5]]);
	});
});

describe('commands and keymap', () => {
	it('Enable / Flatten / switch camera through the commands, Premiere default keys bound', async () => {
		const h = harness();
		const clip = Object.values(h.session.getCommitted().sequences[h.seqId]!.clips).find(
			(c) => c.kind === 'nest-video',
		)!;
		h.session.select('timeline', [clip.id], 'replace');
		expect((await runCommand('multicam.switchCamera', h.ctx, { camera: 3 })).ran).toBe(true);
		expect(h.v1()).toEqual([[0, 600, 3]]);
		await runCommand('multicam.enable', h.ctx);
		const c2 = h.session.getCommitted().sequences[h.seqId]!.clips[clip.id] as MulticamClip;
		expect(c2.multicam.enabled).toBe(false);
		await runCommand('multicam.enable', h.ctx);
		await runCommand('multicam.flatten', h.ctx);
		const kinds = Object.values(h.session.getCommitted().sequences[h.seqId]!.clips)
			.map((c) => c.kind)
			.sort();
		expect(kinds).toEqual(['audio', 'video']);
		const keys = (cmd: string) => DEFAULT_KEYMAP.filter((b) => b.command === cmd).map((b) => b.key);
		expect(keys('multicam.selectCamera1')).toEqual(['Digit1']);
		expect(keys('multicam.cutToCamera9')).toEqual(['Ctrl+Digit9']);
		expect(keys('program.toggleMulticamView')).toEqual(['Shift+Digit0']);
		expect((await runCommand('program.toggleMulticamView', h.ctx)).ran).toBe(true);
		expect(multicamViewStore.getState().view).toBe(true);
	});

	it('Merge Clips and Create Multi-Camera need Project panel selections', async () => {
		const h = harness(2);
		h.session.select('project', [], 'replace');
		expect((await runCommand('clip.createMulticam', h.ctx)).reason).toBe('disabled');
		h.session.select('project', h.items, 'replace');
		const opened: string[] = [];
		const ctx = createCommandContext({
			engine,
			session: h.session,
			focus: { panel: 'project', instanceId: 'x' },
			toast: () => {},
			openDialog: (kind) => opened.push(kind),
		});
		expect((await runCommand('clip.createMulticam', ctx)).ran).toBe(true);
		expect(opened).toEqual(['multicam.create']);
		// two cameras = two videos: Merge Clips takes one video only
		expect((await runCommand('clip.mergeClips', ctx)).reason).toBe('disabled');
	});
});
