// Program monitor layer menu (wp-clipboard-2, S03:XF-050/051/038): Reset Motion / Reset Crop, Fit to Frame /
// Fill Frame / Set to Native (crop- and rotation-aware, centred), Anchor ▸ (the image stays put), Arrange ▸
// (another video track at the same time, tracks created above the top, never over content), Reveal in Timeline /
// Project. The geometry and the arrange planner are tested as pure functions, the commands against sessions.
import { EngineClient } from '@jasper/engine-client';
import {
	type Clip,
	createEmptyProject,
	createSeededIdSource,
	defaultRegistries,
	layerMatrix,
	layerQuad,
	type MediaAsset,
	visibleRect,
} from '@jasper/project';
import { EditorSession } from '@jasper/session';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
	type CommandCtx,
	createCommandContext,
	getCommand,
	isCommandEnabled,
	registerAllCommands,
	runCommand,
	type ToastRequest,
} from '../src/commands/index.ts';
import { programLayerMenu } from '../src/panels/program/layer-menu.ts';
import {
	ANCHOR_POINTS,
	anchorPatch,
	fitPatch,
	type LayerState,
	layerStateAt,
	planArrange,
	projectItemOf,
} from '../src/panels/program/layer-ops.ts';
import { registerProjectPanel } from '../src/panels/project/instances.ts';
import { MENUBAR } from '../src/shell/menus/model.ts';
import { PanelServices } from '../src/state/panel-services.ts';
import { videoAsset } from './timeline-helpers.ts';

const engine = new EngineClient({ fetch: (async () => new Response('{}')) as unknown as typeof fetch });
const FRAME = { width: 1920, height: 1080 };

beforeAll(() => registerAllCommands());

function project(seed: number) {
	const ids = createSeededIdSource(seed);
	const doc = createEmptyProject({ ids, name: `P${seed}`, preset: 'hd-1080p-30' });
	const session = new EditorSession({
		projectId: doc.projectId,
		document: doc,
		ctx: { ids, now: () => '2026-10-01T00:00:00.000Z', registries: defaultRegistries() },
		coalesceWindowMs: 0,
	});
	const seqId = Object.keys(doc.sequences)[0]!;
	session.openSequence(seqId);
	const toasts: ToastRequest[] = [];
	const services = new PanelServices();
	const ctxFor = (panel: CommandCtx['focus']['panel'] = 'program') =>
		createCommandContext({
			engine,
			session,
			services,
			focus: { panel, instanceId: panel ?? 'x' },
			toast: (r) => toasts.push(r),
		});
	const apply = (commands: unknown[]) => {
		const r = session.apply({ label: 'setup', origin: 'user', commands: commands as never });
		if (!r.ok) throw new Error(JSON.stringify(r.errors));
		return r;
	};
	const seq = () => session.getCommitted().sequences[seqId]!;
	const clip = <K extends Clip['kind']>(id: string) => seq().clips[id] as Extract<Clip, { kind: K }>;
	const history = () => session.getState().history.entries.map((e) => e.label);
	const run = (id: string, args?: unknown) => runCommand(id, ctxFor(), args);
	return { session, seqId, ctxFor, apply, seq, clip, toasts, history, run, services };
}

const solid = (at: number, duration: number, track: string, ref: string) => ({
	type: 'clip.addSolid',
	at,
	duration,
	track,
	color: [1, 0, 0, 1],
	ref,
});

/** A 1280×720 video asset (with audio). */
function asset720(): Omit<MediaAsset, 'id'> {
	const a = videoAsset(10);
	const vs = a.probe.streams[0] as { width: number; height: number };
	vs.width = 1280;
	vs.height = 720;
	return a;
}

function state(
	partial: Partial<LayerState['values']>,
	box = { width: 1280, height: 720 },
	crop: LayerState['crop'] = null,
) {
	return {
		values: {
			position: [960, 540],
			anchor: [box.width / 2, box.height / 2],
			scale: 100,
			scaleWidth: 100,
			uniformScale: true,
			rotation: 0,
			flipH: false,
			flipV: false,
			...partial,
		},
		box,
		crop,
		frame: 0,
	} as LayerState;
}

const close = (a: number[], b: number[]) => {
	for (const [i, v] of a.entries()) expect(v).toBeCloseTo(b[i]!, 3);
};

describe('Fit / Fill / Set to Native (XF-051)', () => {
	it('fits the visible rect inside the frame, centred', () => {
		expect(fitPatch(state({ scale: 40, position: [100, 100] }), FRAME, 'fit')).toEqual({
			scale: 150,
			scaleWidth: 150,
			position: [960, 540],
		});
		// Left half cropped away: the visible 640×720 rect is fitted and centred.
		const cropped = state({}, undefined, { left: 50, top: 0, right: 0, bottom: 0 });
		const p = fitPatch(cropped, FRAME, 'fit')!;
		expect(p.scale).toBe(150);
		const m = layerMatrix({ ...cropped.values, ...p } as LayerState['values']);
		const quad = layerQuad(m, visibleRect(cropped.box, cropped.crop!));
		const xs = quad.map((q) => q[0]);
		const ys = quad.map((q) => q[1]);
		close([(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2], [960, 540]);
		close([Math.max(...ys) - Math.min(...ys)], [1080]);
	});

	it('uses the rotated bounds, fills by the larger ratio, and Set to Native only sets 100%', () => {
		const rotated = state({ rotation: 90 }, FRAME);
		expect(fitPatch(rotated, FRAME, 'fit')!.scale).toBe(56.25);
		expect(fitPatch(rotated, FRAME, 'fill')!.scale).toBeCloseTo(177.7778, 3);
		expect(fitPatch(state({}), FRAME, 'fill')!.scale).toBe(150);
		expect(fitPatch(state({ scale: 30 }), FRAME, 'native')).toEqual({ scale: 100, scaleWidth: 100 });
		expect(
			fitPatch(state({}, undefined, { left: 60, top: 0, right: 40, bottom: 0 }), FRAME, 'fit'),
		).toBeNull();
	});
});

describe('Anchor ▸ (XF-038)', () => {
	it('moves the anchor to each grid point of the visible rect without moving a pixel', () => {
		const s = state(
			{ rotation: 30, scale: 80, scaleWidth: 60, uniformScale: false, flipH: true, position: [700, 400] },
			undefined,
			{ left: 10, top: 20, right: 0, bottom: 5 },
		);
		const rect = visibleRect(s.box, s.crop!);
		const before = layerQuad(layerMatrix(s.values), rect);
		for (const p of ANCHOR_POINTS) {
			const patch = anchorPatch(s, p.id)!;
			const after = layerQuad(layerMatrix({ ...s.values, ...patch }), rect);
			for (const [i, q] of after.entries()) close(q, before[i]!);
		}
		expect(anchorPatch(s, 'top-left')!.anchor).toEqual([128, 144]);
		expect(anchorPatch(state({}), 'center')).toBeNull(); // already centred
	});
});

describe('Arrange ▸ planner (XF-050)', () => {
	it('moves above / below the next overlapping layer, creates tracks only above, skips locked tracks', () => {
		const p = project(40);
		const r = p.apply([
			solid(0, 100, 'V1', '$a'),
			solid(0, 100, 'V2', '$b'),
			solid(50, 100, 'V3', '$c'),
			solid(200, 100, 'V1', '$d'),
			solid(200, 100, 'V2', '$e'),
			solid(400, 100, 'V3', '$f'),
			solid(400, 100, 'V2', '$g'),
			solid(800, 50, 'V2', '$lone'),
		]);
		const seq = p.seq();
		// A (V1) under B (V2) and C (V3): forward and front both land on a new V4.
		expect(planArrange(seq, [r.refs.$a!], 'forward')).toEqual({
			moves: [{ clipId: r.refs.$a, deltaTracks: 3 }],
			newTracks: 1,
		});
		expect(planArrange(seq, [r.refs.$a!], 'front').moves[0]!.deltaTracks).toBe(3);
		// D (V1) under E (V2), V3 free there.
		expect(planArrange(seq, [r.refs.$d!], 'forward')).toEqual({
			moves: [{ clipId: r.refs.$d, deltaTracks: 2 }],
			newTracks: 0,
		});
		// F (V3) over G (V2): V1 is free below.
		expect(planArrange(seq, [r.refs.$f!], 'backward').moves).toEqual([
			{ clipId: r.refs.$f, deltaTracks: -2 },
		]);
		expect(planArrange(seq, [r.refs.$f!], 'back').moves).toEqual([{ clipId: r.refs.$f, deltaTracks: -2 }]);
		// C (V3) over B (V2) and A (V1): no free track below, nothing is created under V1.
		expect(planArrange(seq, [r.refs.$c!], 'backward')).toMatchObject({
			moves: [],
			reason: /No free video track/,
		});
		expect(planArrange(seq, [r.refs.$lone!], 'front')).toMatchObject({
			moves: [],
			reason: /Already in front/,
		});
		expect(planArrange(seq, [r.refs.$lone!], 'back')).toMatchObject({ moves: [], reason: /Already behind/ });
		// A locked V3 is skipped: D goes to a new V4.
		p.apply([{ type: 'track.update', trackId: 'V3', patch: { locked: true } }]);
		expect(planArrange(p.seq(), [r.refs.$d!], 'forward').moves).toEqual([
			{ clipId: r.refs.$d, deltaTracks: 3 },
		]);
	});
});

describe('layer commands (XF-050)', () => {
	function withVideo(seed: number) {
		const p = project(seed);
		const reg = p.apply([{ type: 'media.register', asset: asset720(), itemRef: '$item' }]);
		const mediaId = (reg.results[0] as { mediaId: string }).mediaId;
		const placed = p.apply([
			{
				type: 'clip.place',
				source: { mediaId },
				at: 0,
				sourceRange: { in: { seconds: 0 }, out: { seconds: 4 } },
			},
		]);
		const ids = (placed.results[0] as { clipIds: string[] }).clipIds;
		const video = ids.find((id) => p.seq().clips[id]!.kind === 'video')!;
		const audio = ids.find((id) => p.seq().clips[id]!.kind === 'audio')!;
		return { ...p, video, audio, item: reg.refs.$item! };
	}

	it('Fit to Frame / Fill Frame / Set to Native: one step each, keyed at the playhead when animated', async () => {
		const p = withVideo(41);
		p.apply([
			{ type: 'param.set', target: ['clip', p.video, 'transform', 'scale'], value: 40 },
			{ type: 'param.set', target: ['clip', p.video, 'transform', 'position'], value: [100, 100] },
		]);
		p.session.select('timeline', [p.video]);
		await p.run('motion.fit');
		const t = () => p.clip<'video'>(p.video).transform;
		expect([t().scale.value, t().position.value]).toEqual([150, [960, 540]]);
		await p.run('motion.fill');
		expect(t().scale.value).toBe(150); // 16:9 into 16:9: fit = fill
		await p.run('motion.native');
		expect(t().scale.value).toBe(100);
		expect(p.history().slice(-3)).toEqual(['Fit to Frame', 'Fill Frame', 'Set to Native (100%)']);
		p.session.undo();
		expect(t().scale.value).toBe(150);
		// Animated scale: a key at the playhead.
		p.apply([
			{ type: 'keyframe.add', target: ['clip', p.video, 'transform', 'scale'], at: { frames: 0 }, value: 50 },
			{
				type: 'keyframe.add',
				target: ['clip', p.video, 'transform', 'scale'],
				at: { frames: 20 },
				value: 80,
			},
		]);
		p.session.transport.seek(10);
		await p.run('motion.native');
		expect(t().scale.keyframes.map((k) => k.value)).toEqual([50, 100, 80]);
	});

	it('Reset Motion and Reset Crop reuse Remove Attributes; Reset Crop needs a crop', async () => {
		const p = project(42);
		const r = p.apply([solid(0, 60, 'V1', '$s')]);
		const s = r.refs.$s!;
		p.apply([{ type: 'param.set', target: ['clip', s, 'transform', 'rotation'], value: 45 }]);
		p.session.select('timeline', [s]);
		expect(isCommandEnabled(getCommand('motion.resetCrop')!, p.ctxFor())).toBe(false);
		expect(getCommand('motion.resetCrop')!.disabledReason!(p.ctxFor())).toBe(
			'The selected layers are not cropped',
		);
		await p.run('motion.reset');
		expect(p.clip<'solid'>(s).transform.rotation.value).toBe(0);
		p.apply([{ type: 'effect.add', target: { clipId: s }, effectId: 'jasper.crop', params: { left: 20 } }]);
		expect(isCommandEnabled(getCommand('motion.resetCrop')!, p.ctxFor())).toBe(true);
		await p.run('motion.resetCrop');
		expect(p.clip<'solid'>(s).effects).toEqual([]);
		expect(p.history().slice(-3)).toEqual(['Reset Motion', 'setup', 'Reset Crop']);
	});

	it('Anchor ▸ Top Left keeps the layer where it is', async () => {
		const p = project(43);
		const r = p.apply([solid(0, 60, 'V1', '$s')]);
		p.session.select('timeline', [r.refs.$s!]);
		await p.run('motion.anchor', { point: 'top-left' });
		const t = p.clip<'solid'>(r.refs.$s!).transform;
		expect([t.anchor.value, t.position.value]).toEqual([
			[0, 0],
			[0, 0],
		]);
		expect(p.history().at(-1)).toBe('Anchor to Top Left');
		const st = layerStateAt(p.session.getCommitted(), p.seq(), p.seq().clips[r.refs.$s!]!, 0)!;
		expect(st.values.anchor).toEqual([0, 0]);
		expect((await p.run('motion.anchor', { point: 'nowhere' })).reason).toBe('invalid-args');
	});

	it('Arrange ▸ Bring Forward moves the video to a new track and leaves its linked audio alone', async () => {
		const p = withVideo(44);
		const r = p.apply([solid(0, 60, 'V2', '$over')]);
		p.session.select('timeline', [p.video, p.audio]);
		const audioTrack = p.seq().clips[p.audio]!.trackId;
		const tracks = p.seq().videoTracks.length;
		await p.run('arrange.bringForward');
		expect(p.seq().clips[p.video]!.trackId).toBe(p.seq().videoTracks[2]!.id);
		expect(p.seq().clips[p.video]!.start).toBe(0);
		expect(p.seq().clips[p.audio]!.trackId).toBe(audioTrack);
		expect(p.seq().videoTracks).toHaveLength(tracks);
		expect(p.history().at(-1)).toBe('Bring Forward');
		await p.run('arrange.sendToBack');
		expect(p.seq().clips[p.video]!.trackId).toBe(p.seq().videoTracks[0]!.id);
		// Alone at its time: Bring to Front is disabled with the reason.
		p.session.select('timeline', [r.refs.$over!]);
		p.apply([{ type: 'clip.move', clipIds: [r.refs.$over!], deltaFrames: 500 }]);
		expect(isCommandEnabled(getCommand('arrange.bringToFront')!, p.ctxFor())).toBe(false);
		expect(getCommand('arrange.bringToFront')!.disabledReason!(p.ctxFor())).toMatch(/Already in front/);
	});

	it('Bring to Front above the top track creates a video track (S02:TL-266)', async () => {
		const p = project(45);
		const r = p.apply([solid(0, 60, 'V1', '$a'), solid(0, 60, 'V3', '$top')]);
		p.session.select('timeline', [r.refs.$a!]);
		await p.run('arrange.bringToFront');
		expect(p.seq().videoTracks).toHaveLength(4);
		expect(p.seq().clips[r.refs.$a!]!.trackId).toBe(p.seq().videoTracks[3]!.id);
		p.session.undo();
		expect(p.seq().videoTracks).toHaveLength(3);
	});

	it('Reveal in Project selects the item, focuses the panel and reveals it; Reveal in Timeline focuses the Timeline', async () => {
		const p = withVideo(46);
		const focus = vi.fn();
		p.services.register('shell', 'shell', { focusPanel: focus } as never);
		const reveal = vi.fn();
		const off = registerProjectPanel({
			instanceId: 'prj',
			getBinId: () => null,
			setView: () => undefined,
			toggleView: () => undefined,
			zoom: () => undefined,
			toggleHoverScrub: () => undefined,
			newBin: () => undefined,
			newSequence: () => undefined,
			renameSelection: () => undefined,
			deleteSelection: () => undefined,
			openSelection: () => undefined,
			importIntoBin: () => undefined,
			reveal,
		});
		try {
			p.session.select('timeline', [p.video]);
			expect(projectItemOf(p.session.getCommitted(), p.seq().clips[p.video]!)).toBe(p.item);
			await p.run('clip.revealInProject');
			expect(p.session.getState().selection.project.items).toEqual([p.item]);
			expect(focus).toHaveBeenCalledWith('project');
			expect(reveal).toHaveBeenCalledWith(p.item);
			await p.run('clip.revealInTimeline');
			expect(focus).toHaveBeenLastCalledWith('timeline');
			// A text clip has no project item.
			const t = p.apply([
				{ type: 'clip.addText', at: 300, duration: 30, track: 'V2', content: { text: 'T' }, ref: '$t' },
			]);
			p.session.select('timeline', [t.refs.$t!]);
			expect(isCommandEnabled(getCommand('clip.revealInProject')!, p.ctxFor())).toBe(false);
			expect(getCommand('clip.revealInProject')!.disabledReason!(p.ctxFor())).toMatch(/no project item/);
		} finally {
			off();
		}
	});
});

describe('menus (XF-050 placement)', () => {
	it('the Program menu lists every XF-050 entry with Anchor ▸ and Arrange ▸ submenus (no Agent ▸, D-18)', () => {
		const p = project(47);
		const r = p.apply([solid(0, 60, 'V1', '$s')]);
		p.session.select('timeline', [r.refs.$s!]);
		const run = vi.fn();
		const items = programLayerMenu(p.ctxFor(), p.seq().clips[r.refs.$s!]!, run);
		const labels = items.map((i) => (i.kind === 'separator' ? '—' : i.label));
		expect(labels).toEqual([
			'Cut',
			'Copy',
			'Paste',
			'Paste Attributes…',
			'—',
			'Duplicate',
			'Delete',
			'Enable',
			'—',
			'Reset Motion',
			'Reset Crop',
			'Fit to Frame',
			'Fill Frame',
			'Set to Native (100%)',
			'Anchor',
			'Arrange',
			'—',
			'Reveal in Timeline',
			'Reveal in Project',
		]);
		const anchor = items.find((i) => i.kind === 'submenu' && i.label === 'Anchor');
		if (anchor?.kind !== 'submenu') throw new Error('no Anchor submenu');
		expect(anchor.items.map((i) => (i.kind === 'item' ? i.label : ''))).toEqual([
			'Anchor to Center',
			'Top Left',
			'Top',
			'Top Right',
			'Left',
			'Right',
			'Bottom Left',
			'Bottom',
			'Bottom Right',
		]);
		const br = anchor.items.at(-1)!;
		if (br.kind === 'item') br.run();
		expect(run).toHaveBeenCalledWith('motion.anchor', { point: 'bottom-right' });
		const arrange = items.find((i) => i.kind === 'submenu' && i.label === 'Arrange');
		if (arrange?.kind !== 'submenu') throw new Error('no Arrange submenu');
		expect(arrange.items.map((i) => (i.kind === 'item' ? [i.label, i.shortcut, i.disabled] : []))).toEqual([
			['Bring to Front', 'Ctrl+Shift+]', true],
			['Bring Forward', 'Ctrl+]', true],
			['Send Backward', 'Ctrl+[', true],
			['Send to Back', 'Ctrl+Shift+[', true],
		]);
		const disabled = items
			.filter((i) => i.kind === 'item' && i.disabled)
			.map((i) => (i as { label: string }).label);
		expect(disabled).toEqual(['Reset Crop', 'Reveal in Project']);
	});

	it('the menubar has Clip ▸ Transform (with Anchor ▸) and Graphics ▸ Arrange', () => {
		const sub = (menu: string, label: string) =>
			MENUBAR.find((m) => m.id === menu)!.items.find((i) => i.type === 'submenu' && i.label === label) as {
				items: { type: string; command?: string; args?: unknown }[];
			};
		const transform = sub('clip', 'Transform');
		expect(transform.items.filter((i) => i.type === 'command').map((i) => i.command)).toEqual([
			'motion.reset',
			'motion.resetCrop',
			'motion.fit',
			'motion.fill',
			'motion.native',
		]);
		expect(sub('graphics', 'Arrange').items.map((i) => i.command)).toEqual([
			'arrange.bringToFront',
			'arrange.bringForward',
			'arrange.sendBackward',
			'arrange.sendToBack',
		]);
	});
});
