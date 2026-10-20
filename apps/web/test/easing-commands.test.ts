import { EngineClient } from '@jasper/engine-client';
import { type Command, easesToCubic, type Keyframe, type TransactionResult } from '@jasper/project';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { easeEnv } from '../src/commands/easing.ts';
import {
	type CommandCtx,
	createCommandContext,
	DEFAULT_KEYMAP,
	getCommand,
	isCommandEnabled,
	registerAllCommands,
	resolveBindings,
	runCommand,
	scopeChain,
	type ToastRequest,
} from '../src/commands/index.ts';
import { easeClipboard } from '../src/panels/easing/clipboard.ts';
import { docCommandSupport } from '../src/panels/easing/doc-commands.ts';
import { easeLibrary } from '../src/panels/easing/library.ts';
import { segmentCurve } from '../src/panels/easing/selection.ts';
import { addSolids, clipOf, makeSession } from './inspector-helpers.tsx';

const engine = new EngineClient({ fetch: (async () => new Response('{}')) as unknown as typeof fetch });
beforeAll(() => registerAllCommands());
const realHas = docCommandSupport.has;
beforeEach(() => {
	globalThis.localStorage?.clear();
	easeLibrary.reload();
	easeClipboard.set(null);
});
afterEach(() => {
	docCommandSupport.has = realHas;
	vi.restoreAllMocks();
});

type K = Keyframe<unknown>;

function setup() {
	const session = makeSession();
	const [id] = addSolids(session, [0], 90);
	const clipId = id!;
	const add = (target: string[], frames: number, value: unknown, extra: Record<string, unknown> = {}) => ({
		type: 'keyframe.add',
		target,
		at: { frames },
		value,
		interpolation: 'bezier',
		...extra,
	});
	const r = session.apply({
		label: 'keys',
		origin: 'user',
		commands: [
			add(['clip', clipId, 'opacity'], 0, 0, { easeOut: { influence: 0.5, slope: 0 } }),
			add(['clip', clipId, 'opacity'], 20, 100, { easeIn: { influence: 0.2, slope: 1 } }),
			add(['clip', clipId, 'opacity'], 40, 50),
			add(['clip', clipId, 'transform', 'position'], 0, [100, 100]),
			add(['clip', clipId, 'transform', 'position'], 30, [500, 300]),
		] as never,
	});
	if (!r.ok) throw new Error(JSON.stringify(r.errors));
	const opacity = () =>
		(clipOf(session, clipId) as unknown as { opacity: { keyframes: K[] } }).opacity.keyframes;
	const position = () =>
		(clipOf(session, clipId) as unknown as { transform: { position: { keyframes: K[] } } }).transform.position
			.keyframes;
	const toasts: ToastRequest[] = [];
	const ctx: CommandCtx = createCommandContext({ engine, session, toast: (t) => toasts.push(t) });
	const select = (ids: string[]) => session.selectKeyframes({ clipOrTrackId: clipId, keyframeIds: ids });
	const reason = (id: string) => {
		const c = getCommand(id)!;
		return isCommandEnabled(c, ctx) ? undefined : c.disabledReason?.(ctx);
	};
	return { session, clipId, opacity, position, ctx, toasts, select, reason };
}

const ok = (): TransactionResult =>
	({ ok: true, results: [], warnings: [], created: [] }) as unknown as TransactionResult;

describe('the keyframe selection as the easing commands read it', () => {
	it('two neighbouring keys: one cubic segment, exactly the stored eases', () => {
		const h = setup();
		const [a, b] = h.opacity();
		h.select([a!.id, b!.id]);
		const sel = easeEnv(h.ctx)!.sel;
		expect(sel.blocked).toBeNull();
		expect(sel.properties).toHaveLength(1);
		const p = sel.properties[0]!;
		expect(p.curve).toEqual(easesToCubic(a!.easeOut, b!.easeIn));
		expect(p.segments.map((s) => s.inner)).toEqual([true, false]);
	});

	it('three keys of a number: one multi-point curve through the middle key', () => {
		const h = setup();
		h.select(h.opacity().map((k) => k.id));
		const p = easeEnv(h.ctx)!.sel.properties[0]!;
		expect(p.curve?.kind).toBe('multi');
		if (p.curve?.kind !== 'multi') return;
		expect(p.curve.points.map((q) => [q.x, q.y])).toEqual([
			[0, 0],
			[0.5, 2],
			[1, 1],
		]);
	});

	it('keys of several properties; point properties are spatial', () => {
		const h = setup();
		h.select([h.opacity()[0]!.id, h.position()[0]!.id]);
		const sel = easeEnv(h.ctx)!.sel;
		expect(sel.properties.map((p) => [p.label, p.spatial])).toEqual([
			['Position', true],
			['Opacity', false],
		]);
	});

	it('says why nothing can be eased', () => {
		const h = setup();
		expect(h.reason('ease.easyEase')).toBe('Select keyframes in Effect Controls');
		h.select([h.opacity()[0]!.id]);
		expect(h.reason('ease.easyEase')).toBeUndefined();
		const seq = Object.values(h.session.getCommitted().sequences)[0]!;
		const trackId = seq.clips[h.clipId]!.trackId;
		h.session.apply({
			label: 'lock',
			origin: 'user',
			commands: [{ type: 'track.update', trackId, patch: { locked: true } } as Command],
		});
		expect(h.reason('ease.easyEase')).toBe('The clip’s track is locked');
	});
});

describe('easing commands', () => {
	it('Easy Ease / In / Out set {⅓, 0} on the chosen sides as one undo step', async () => {
		const h = setup();
		const [a, b] = h.opacity();
		h.select([a!.id, b!.id]);
		const before = h.session.getState().history.entries.length;
		expect((await runCommand('ease.easyEaseIn', h.ctx)).ran).toBe(true);
		expect(h.opacity()[1]!.easeIn).toEqual({ influence: 1 / 3, slope: 0 });
		expect(h.opacity()[0]!.easeOut).toEqual({ influence: 0.5, slope: 0 });
		expect((await runCommand('ease.easyEase', h.ctx)).ran).toBe(true);
		expect(h.opacity()[0]!.easeOut).toEqual({ influence: 1 / 3, slope: 0 });
		expect(h.session.getState().history.entries.length).toBe(before + 2);
	});

	it('Apply Ease is disabled with a reason while the model has no keyframe.applyEase command', () => {
		const h = setup();
		h.select([h.opacity()[0]!.id, h.opacity()[1]!.id]);
		docCommandSupport.has = (t) => t !== 'keyframe.applyEase';
		expect(h.reason('ease.apply')).toBe('This build has no keyframe.applyEase command yet');
	});

	it('Apply Ease sends keyframe.applyEase with the curve and the sections (stubbed model)', async () => {
		const h = setup();
		docCommandSupport.has = () => true;
		const ids = [h.opacity()[0]!.id, h.opacity()[1]!.id];
		h.select(ids);
		const apply = vi.spyOn(h.session, 'apply').mockReturnValue(ok());
		const curve = { kind: 'cubic' as const, x1: 0.2, y1: 0, x2: 0.1, y2: 1 };
		expect(
			(await runCommand('ease.apply', h.ctx, { curve, sections: ['out', 'in'], name: 'Snappy' })).ran,
		).toBe(true);
		expect(apply).toHaveBeenCalledWith(
			expect.objectContaining({
				label: 'Apply Ease: Snappy',
				origin: 'user',
				commands: [{ type: 'keyframe.applyEase', keyframeIds: ids, curve, sections: ['out', 'in'] }],
			}),
		);
		expect(easeLibrary.get().recent[0]).toEqual(curve);
		// Without arguments the panel's curve and targeting are used; no sections = the command's automatic choice.
		easeLibrary.settings({ curve, sections: [] });
		await runCommand('ease.apply', h.ctx);
		expect(apply.mock.calls[1]![0].commands).toEqual([
			{ type: 'keyframe.applyEase', keyframeIds: ids, curve },
		]);
		expect((await runCommand('ease.apply', h.ctx, { curve: { kind: 'cubic', x1: 3 } })).reason).toBe(
			'invalid-args',
		);
	});

	it('a refusal of the model is shown as a toast', async () => {
		const h = setup();
		docCommandSupport.has = () => true;
		h.select([h.opacity()[0]!.id, h.opacity()[1]!.id]);
		vi.spyOn(h.session, 'apply').mockReturnValue({
			ok: false,
			errors: [{ code: 'E_INVALID_PARAM', message: 'Hold keys cannot be eased' }],
		} as unknown as TransactionResult);
		await runCommand('ease.apply', h.ctx, { curve: { kind: 'cubic', x1: 0.3, y1: 0, x2: 0.6, y2: 1 } });
		expect(h.toasts.at(-1)).toMatchObject({
			kind: 'warning',
			message: 'Apply Ease: not possible',
			detail: 'Hold keys cannot be eased',
		});
	});

	it('Copy Ease takes one key’s sides or the segments; Paste Ease sends them (stubbed model)', async () => {
		const h = setup();
		const [a, b] = h.opacity();
		h.select([a!.id, b!.id]);
		expect(h.reason('ease.paste')).toBeDefined();
		expect((await runCommand('ease.copy', h.ctx)).ran).toBe(true);
		const copied = easeClipboard.get()!;
		expect(copied.ease).toEqual({ kind: 'segments', segments: [easesToCubic(a!.easeOut, b!.easeIn)] });
		expect(copied.values).toEqual([0, 100]);
		h.select([a!.id]);
		await runCommand('ease.copy', h.ctx);
		expect(easeClipboard.get()!.ease).toEqual({ kind: 'key', easeIn: a!.easeIn, easeOut: a!.easeOut });
		docCommandSupport.has = () => true;
		const apply = vi.spyOn(h.session, 'apply').mockReturnValue(ok());
		h.select([b!.id]);
		await runCommand('ease.paste', h.ctx, { sections: ['in'] });
		expect(apply.mock.calls[0]![0].commands).toEqual([
			{
				type: 'keyframe.pasteEase',
				keyframeIds: [b!.id],
				clip: { kind: 'key', easeIn: a!.easeIn, easeOut: a!.easeOut },
				sections: ['in'],
			},
		]);
		await runCommand('ease.pasteValues', h.ctx);
		expect(apply.mock.calls[1]![0].commands).toEqual([
			{ type: 'keyframe.pasteValues', keyframeIds: [b!.id], values: [0] },
		]);
	});

	it('Duplicate Keys at Playhead pastes them with the earliest at the playhead', async () => {
		const h = setup();
		const [a, b] = h.opacity();
		h.select([a!.id, b!.id]);
		h.session.transport.seek(60);
		expect((await runCommand('ease.duplicateAtPlayhead', h.ctx)).ran).toBe(true);
		const keys = h.opacity();
		expect(keys).toHaveLength(5);
		expect(keys.slice(3).map((k) => k.value)).toEqual([0, 100]);
		expect(segmentCurve(keys, 3)).toEqual(segmentCurve(keys, 0));
		// The pasted keys become the selection.
		expect(h.session.getState().selection.keyframes?.keyframeIds).toEqual(keys.slice(3).map((k) => k.id));
	});

	it('Mirror Keys at Playhead pastes them reversed with mirrored eases', async () => {
		const h = setup();
		const [a, b] = h.opacity();
		h.select([a!.id, b!.id]);
		h.session.transport.seek(60);
		expect((await runCommand('ease.mirrorAtPlayhead', h.ctx)).ran).toBe(true);
		const keys = h.opacity();
		expect(keys.slice(3).map((k) => k.value)).toEqual([100, 0]);
		const original = segmentCurve(keys, 0)!;
		const mirrored = segmentCurve(keys, 3)!;
		expect(mirrored.x1).toBeCloseTo(1 - original.x2, 9);
		expect(mirrored.y1).toBeCloseTo(1 - original.y2, 9);
		expect(mirrored.x2).toBeCloseTo(1 - original.x1, 9);
		expect(mirrored.y2).toBeCloseTo(1 - original.y1, 9);
		expect(keys[4]!.time - keys[3]!.time).toBe(b!.time - a!.time);
	});

	it('Spatial ▸ Linear needs point keys; Temporal ▸ Continuous works on any', async () => {
		const h = setup();
		h.select([h.opacity()[0]!.id]);
		expect(h.reason('ease.spatialLinear')).toMatch(/point property/);
		h.select(h.position().map((k) => k.id));
		expect((await runCommand('ease.spatialLinear', h.ctx)).ran).toBe(true);
		expect((await runCommand('ease.temporalContinuous', h.ctx)).ran).toBe(true);
		expect(h.position().every((k) => k.interpolation === 'continuous-bezier')).toBe(true);
	});

	it('Add Overshoot / Bounce set the preset expression on the selected properties', async () => {
		const h = setup();
		h.select([h.opacity()[0]!.id, h.position()[0]!.id]);
		expect((await runCommand('ease.addBounce', h.ctx)).ran).toBe(true);
		const clip = clipOf(h.session, h.clipId) as unknown as {
			opacity: { expression?: { text: string } };
			transform: { position: { expression?: { text: string } } };
		};
		expect(clip.opacity.expression?.text).toMatch(/elasticity/);
		expect(clip.transform.position.expression?.text).toMatch(/elasticity/);
		expect((await runCommand('ease.addOvershoot', h.ctx)).ran).toBe(true);
		expect((clipOf(h.session, h.clipId) as unknown as typeof clip).opacity.expression?.text).toMatch(/decay/);
	});

	it('the gated path / clean-up commands say what is missing', () => {
		const h = setup();
		h.select(h.position().map((k) => k.id));
		docCommandSupport.has = () => false;
		expect(h.reason('ease.drivePath')).toBe('This build has no keyframe.createPathController command yet');
		expect(h.reason('ease.cleanupPath')).toBe('This build has no keyframes.cleanupPath command yet');
		docCommandSupport.has = () => true;
		expect(h.reason('ease.drivePath')).toBeUndefined();
	});
});

describe('shortcuts', () => {
	it('F9, Shift+F9, Ctrl+Shift+F9 are the Easy Ease commands everywhere', () => {
		const at = (chord: string, panel: Parameters<typeof scopeChain>[0]) =>
			resolveBindings(chord, scopeChain(panel), { platform: 'win', runtime: 'web' })[0]?.command;
		expect(at('F9', 'effectControls')).toBe('ease.easyEase');
		expect(at('Shift+F9', 'timeline')).toBe('ease.easyEaseIn');
		expect(at('Ctrl+Shift+F9', 'easing')).toBe('ease.easyEaseOut');
		expect(
			resolveBindings('Cmd+Shift+F9', scopeChain('easing'), { platform: 'mac', runtime: 'desktop' })[0]
				?.command,
		).toBe('ease.easyEaseOut');
		// In the Easing panel Copy / Paste act on eases; elsewhere they keep their meaning.
		expect(at('Ctrl+KeyC', 'easing')).toBe('ease.copy');
		expect(at('Ctrl+KeyV', 'easing')).toBe('ease.paste');
		expect(at('Ctrl+KeyC', 'effectControls')).toBe('edit.copy');
	});

	it('every easing binding names a registered command', () => {
		for (const b of DEFAULT_KEYMAP.filter((x) => x.command.startsWith('ease.')))
			expect(getCommand(b.command), b.command).toBeDefined();
	});
});
