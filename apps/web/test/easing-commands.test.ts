import { EngineClient } from '@jasper/engine-client';
import {
	builtinEasePresets,
	type Command,
	type CubicEase,
	describeKeyframeEases,
	easesToCubic,
	incomingEase,
	type Keyframe,
	outgoingEase,
} from '@jasper/project';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { easeEnv, warningText } from '../src/commands/easing.ts';
import {
	type CommandCtx,
	createCommandContext,
	getCommand,
	isCommandEnabled,
	registerAllCommands,
	resolveBindings,
	runCommand,
	scopeChain,
	type ToastRequest,
} from '../src/commands/index.ts';
import { easeClipboard } from '../src/panels/easing/clipboard.ts';
import { easeLibrary } from '../src/panels/easing/library.ts';
import { addSolids, clipOf, makeSession } from './inspector-helpers.tsx';

const engine = new EngineClient({ fetch: (async () => new Response('{}')) as unknown as typeof fetch });
beforeAll(() => registerAllCommands());
beforeEach(() => {
	globalThis.localStorage?.clear();
	easeLibrary.reload();
	easeClipboard.set(null);
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

/** Segment i → i+1 as the evaluator plays it. */
const seg = (kfs: K[], i: number): CubicEase =>
	kfs[i]!.interpolation === 'linear'
		? { kind: 'cubic', x1: 1 / 3, y1: 1 / 3, x2: 2 / 3, y2: 2 / 3 }
		: easesToCubic(outgoingEase(kfs, i), incomingEase(kfs, i + 1));
const near = (a: CubicEase, b: CubicEase) => {
	for (const k of ['x1', 'y1', 'x2', 'y2'] as const) expect(a[k]).toBeCloseTo(b[k], 6);
};

describe('the keyframe selection as the easing commands read it', () => {
	it('two neighbouring keys: one cubic segment, exactly the stored eases', () => {
		const h = setup();
		const [a, b] = h.opacity();
		h.select([a!.id, b!.id]);
		const sel = easeEnv(h.ctx)!.sel;
		expect(sel.blocked).toBeNull();
		expect(sel.properties).toHaveLength(1);
		const p = sel.properties[0]!;
		expect(p.curve).toEqual({ kind: 'cubic', x1: 0.5, y1: 0, x2: 0.8, y2: 0.8 });
		expect(p.segments.map((x) => x.section)).toEqual(['middle', 'out']);
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
		expect(new Set(sel.properties.map((p) => `${p.label}:${p.spatial}`))).toEqual(
			new Set(['Position:true', 'Opacity:false']),
		);
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

	it('Apply Ease shapes the segment exactly, as one undo step, and remembers the curve', async () => {
		const h = setup();
		const [a, b] = h.opacity();
		h.select([a!.id, b!.id]);
		const curve = { kind: 'cubic' as const, x1: 0.2, y1: 0, x2: 0.1, y2: 1 };
		const before = h.session.getState().history.entries.length;
		expect((await runCommand('ease.apply', h.ctx, { curve, name: 'Snappy' })).ran).toBe(true);
		near(seg(h.opacity(), 0), curve);
		expect(h.session.getState().history.entries.at(-1)!.label).toBe('Apply Ease: Snappy');
		expect(h.session.getState().history.entries.length).toBe(before + 1);
		expect(easeLibrary.get().recent[0]).toEqual(curve);
		h.session.undo();
		near(seg(h.opacity(), 0), easesToCubic(a!.easeOut, b!.easeIn));
		// Without arguments: the panel's curve; sections pick the outer segment of a single key.
		easeLibrary.settings({ curve, sections: ['out'] });
		h.select([b!.id]);
		expect((await runCommand('ease.apply', h.ctx)).ran).toBe(true);
		near(seg(h.opacity(), 1), curve);
		expect((await runCommand('ease.apply', h.ctx, { curve: { kind: 'cubic', x1: 3 } })).reason).toBe(
			'invalid-args',
		);
	});

	it('a multi-point curve creates keys; the selection follows the result', async () => {
		const h = setup();
		const [a, b] = h.opacity();
		h.select([a!.id, b!.id]);
		const bounce = builtinEasePresets().find((p) => p.curve.kind === 'multi' && p.group === 'bounce')!;
		expect((await runCommand('ease.apply', h.ctx, { curve: bounce.curve, name: bounce.name })).ran).toBe(
			true,
		);
		expect(h.opacity().length).toBeGreaterThan(3);
		const sel = h.session.getState().selection.keyframes!.keyframeIds;
		expect(sel.length).toBe(h.opacity().length - 1);
	});

	it('a refusal of the model is shown as a toast', async () => {
		const h = setup();
		h.select([h.opacity()[0]!.id]);
		await runCommand('ease.apply', h.ctx, {
			curve: { kind: 'cubic', x1: 0.3, y1: 0, x2: 0.6, y2: 1 },
			sections: ['in'],
		});
		expect(h.toasts.at(-1)).toMatchObject({ kind: 'warning', message: 'Apply Ease: not possible' });
	});

	it('Copy Ease → Paste Ease onto another property; Paste Values', async () => {
		const h = setup();
		const [a, b, c] = h.opacity();
		h.select([a!.id, b!.id]);
		expect(h.reason('ease.paste')).toBe('Copy an ease first');
		expect((await runCommand('ease.copy', h.ctx)).ran).toBe(true);
		const copied = easeClipboard.get()!;
		expect(copied.ease).toEqual({ kind: 'segments', segments: [easesToCubic(a!.easeOut, b!.easeIn)] });
		expect(copied.values).toEqual([0, 100]);
		h.select(h.position().map((k) => k.id));
		expect((await runCommand('ease.paste', h.ctx)).ran).toBe(true);
		near(seg(h.position(), 0), easesToCubic(a!.easeOut, b!.easeIn));
		expect(h.session.getState().history.entries.at(-1)!.label).toBe('Paste Ease');
		h.select([b!.id, c!.id]);
		expect((await runCommand('ease.pasteValues', h.ctx)).ran).toBe(true);
		expect(h.opacity().map((k) => k.value)).toEqual([0, 0, 100]);
		expect(h.session.getState().history.entries.at(-1)!.label).toBe('Paste Keyframe Values');
		// One key: its two sides.
		h.select([a!.id]);
		await runCommand('ease.copy', h.ctx);
		expect(easeClipboard.get()!.ease.kind).toBe('key');
	});

	it('Keyframe Velocity sets a side’s speed and influence', async () => {
		const h = setup();
		const [a, b] = h.opacity();
		h.select([a!.id, b!.id]);
		expect(
			(
				await runCommand('ease.setVelocity', h.ctx, {
					keyframeId: a!.id,
					side: 'out',
					speed: 50,
					influence: 40,
				})
			).ran,
		).toBe(true);
		const d = describeKeyframeEases(h.session.getCommitted(), [a!.id]);
		if (!d.ok) throw new Error(d.message);
		const out = d.properties[0]!.keys[0]!.easeOut!;
		expect(out.speed).toBeCloseTo(50, 6);
		expect(out.influencePercent).toBeCloseTo(40, 6);
		expect(h.session.getState().history.entries.at(-1)!.label).toBe('Keyframe Velocity');
		// A key outside the selection is refused.
		await runCommand('ease.setVelocity', h.ctx, { keyframeId: h.position()[0]!.id, side: 'in', speed: 1 });
		expect(h.toasts.at(-1)!.message).toBe('Select the keyframe first');
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
		expect(seg(keys, 3)).toEqual(seg(keys, 0));
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
		const original = seg(keys, 0);
		const mirrored = seg(keys, 3);
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

	it('Drive Along Path requires point keys and creates their controller', async () => {
		const h = setup();
		h.select([h.opacity()[0]!.id, h.opacity()[1]!.id]);
		expect(h.reason('ease.drivePath')).toMatch(/one point property/);
		h.select([h.position()[0]!.id]);
		expect(h.reason('ease.drivePath')).toBe('Select two or more keys of the property');
		h.select(h.position().map((k) => k.id));
		expect((await runCommand('ease.drivePath', h.ctx)).ran).toBe(true);
		const clip = clipOf(h.session, h.clipId) as unknown as {
			transform: { position: { expression?: { text: string } } };
			effects: { effectId: string }[];
		};
		expect(clip.transform.position.expression?.text).toBeTruthy();
		expect(h.toasts.filter((t) => t.message.includes('not possible'))).toEqual([]);
	});

	it('lists every warning of a result once', () => {
		const r = {
			ok: true,
			results: [],
			created: [],
			warnings: [
				{ code: 'W_EASE_FLAT_SEGMENT', message: 'Opacity: flat' },
				{ code: 'W_EASE_CLAMPED', message: 'Scale: clamped' },
				{ code: 'W_EASE_FLAT_SEGMENT', message: 'Opacity: flat' },
			],
		} as unknown as Parameters<typeof warningText>[0];
		expect(warningText(r)).toBe('Opacity: flat\nScale: clamped');
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
});
