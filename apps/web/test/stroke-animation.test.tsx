import {
	CubicEaseSchema,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
} from '@jasper/project';
import { EditorSession } from '@jasper/session';
import { SessionProvider } from '@jasper/session/react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getCommand, registerCommands, runCommand } from '../src/commands/registry.ts';
import type { CommandCtx, ToastRequest } from '../src/commands/types.ts';
import { StrokeAnimationPanel } from '../src/panels/strokeAnimation/StrokeAnimationPanel.tsx';
import { vectorUi } from '../src/shapes/vector.ts';
import { strokeAnimationCommands } from '../src/stroke-animation/commands.ts';
import {
	formatCubic,
	parseCubic,
	presetForCurve,
	strokeCurvePresets,
	tracerTarget,
} from '../src/stroke-animation/model.ts';
import {
	DEFAULT_STROKE_PREFS,
	parseStrokePrefs,
	STROKE_BUTTON_IDS,
	StrokePrefsSchema,
	strokePrefs,
} from '../src/stroke-animation/prefs.ts';

const CURVES = strokeCurvePresets();
const preset = (id: string) => {
	const p = CURVES.find((x) => x.id === id);
	if (!p) throw new Error(`no cubic preset ${id}`);
	return p;
};

function makeSession() {
	const ids = createCounterIdSource(1);
	const document = createEmptyProject({ ids, name: 'Stroke', preset: 'hd-1080p-30' });
	const session = new EditorSession({
		projectId: document.projectId,
		document,
		ctx: { ids, now: () => 't', registries: defaultRegistries() },
		coalesceWindowMs: 0,
	});
	return { session, seqId: session.getState().activeSequenceId! };
}

function addShape(session: EditorSession, shape: unknown, at = 0, duration = 90, track = 'V1'): string {
	const r = session.apply({
		label: 'setup',
		origin: 'user',
		commands: [{ type: 'clip.addShape', at, duration, track, shape, ref: '$s' }] as never,
	});
	if (!r.ok) throw new Error(JSON.stringify(r.errors));
	return r.refs.$s!;
}
const STROKED_PATH = [
	{ type: 'rect', size: [200, 100] },
	{ type: 'stroke', color: '#ffffff', width: 4 },
];
const TRIMMED_PATH = [...STROKED_PATH, { type: 'trim' }];

function ctxFor(session: EditorSession | null, toasts: ToastRequest[] = []): CommandCtx {
	return {
		session,
		transport: session?.transport,
		ui: { toast: (r: ToastRequest) => toasts.push(r), openDialog: () => {} },
		capabilities: new Set(),
	} as unknown as CommandCtx;
}

let unregister: (() => void) | undefined;

beforeEach(() => {
	localStorage.clear();
	strokePrefs.reload();
	unregister = registerCommands(strokeAnimationCommands);
});
afterEach(() => {
	cleanup();
	unregister?.();
	vectorUi.set({ selected: null, vertices: [], collapsed: {} });
	localStorage.clear();
	strokePrefs.reload();
});

describe('curve presets', () => {
	it('shows a stored curve as its preset, or the preset with the same shape', () => {
		const ease = preset('basic.easy-ease');
		expect(presetForCurve(ease.curve, ease.id, CURVES)?.id).toBe('basic.easy-ease');
		expect(presetForCurve({ ...ease.curve }, null, CURVES)?.id).toBe('basic.easy-ease');
		expect(presetForCurve({ kind: 'cubic', x1: 0.9, y1: -2, x2: 0.1, y2: 3 }, null, CURVES)).toBeNull();
		expect(presetForCurve(null, 'basic.easy-ease', CURVES)).toBeNull();
	});
});

describe('curve text', () => {
	it('parses CSS cubic-bezier and plain lists, refuses invalid curves', () => {
		expect(parseCubic('0.25, 0.1, 0.25, 1')).toEqual({ kind: 'cubic', x1: 0.25, y1: 0.1, x2: 0.25, y2: 1 });
		expect(parseCubic(' cubic-bezier(.42, 0, .58, 1) ')).toEqual({
			kind: 'cubic',
			x1: 0.42,
			y1: 0,
			x2: 0.58,
			y2: 1,
		});
		expect(parseCubic('0 0 1 1')).toEqual({ kind: 'cubic', x1: 0, y1: 0, x2: 1, y2: 1 });
		for (const bad of [
			'',
			'1, 2, 3',
			'1.5, 0, 0.5, 1',
			'0, 0, -0.1, 1',
			'0, 11, 0.5, 1',
			'a, b, c, d',
			'0,0,1,1,1',
			'NaN, 0, 1, 1',
		])
			expect(parseCubic(bad)).toBeNull();
	});

	it('round-trips every valid cubic through its text (3 decimals)', () => {
		const unit = fc.double({ min: 0, max: 1, noNaN: true });
		const y = fc.double({ min: -10, max: 10, noNaN: true });
		fc.assert(
			fc.property(unit, y, unit, y, (x1, y1, x2, y2) => {
				const c = parseCubic(formatCubic({ kind: 'cubic', x1, y1, x2, y2 }));
				expect(c).not.toBeNull();
				expect(CubicEaseSchema.safeParse(c).success).toBe(true);
				expect(Math.abs(c!.x1 - x1)).toBeLessThanOrEqual(0.0005);
				expect(Math.abs(c!.y2 - y2)).toBeLessThanOrEqual(0.0005);
			}),
		);
	});

	it('never throws on arbitrary text', () => {
		fc.assert(fc.property(fc.string(), (s) => void expect(() => parseCubic(s)).not.toThrow()));
	});
});

describe('preferences', () => {
	it('parses any stored value into valid preferences', () => {
		fc.assert(
			fc.property(fc.jsonValue(), (raw) => {
				const p = parseStrokePrefs(raw);
				expect(StrokePrefsSchema.safeParse(p).success).toBe(true);
			}),
		);
	});

	it('keeps valid fields and replaces only the invalid ones', () => {
		const arb = fc.record({
			durationFrames: fc.oneof(fc.integer({ min: 1, max: 3600 }), fc.anything()),
			copies: fc.oneof(fc.integer({ min: 2, max: 64 }), fc.anything()),
			inOutLag: fc.oneof(fc.double({ min: 0, max: 1, noNaN: true }), fc.anything()),
			startAt: fc.oneof(fc.constantFrom('playhead', 'clipStart'), fc.anything()),
			hidden: fc.array(fc.oneof(fc.constantFrom(...STROKE_BUTTON_IDS), fc.string())),
		});
		fc.assert(
			fc.property(arb, (raw) => {
				const p = parseStrokePrefs({ ...raw, version: 7, extra: 1 });
				for (const k of ['durationFrames', 'copies', 'inOutLag', 'startAt'] as const) {
					const valid = StrokePrefsSchema.shape[k].safeParse(raw[k]).success;
					expect(p[k]).toEqual(valid ? raw[k] : DEFAULT_STROKE_PREFS[k]);
				}
				expect(p.hidden.every((h) => STROKE_BUTTON_IDS.includes(h))).toBe(true);
				expect(new Set(p.hidden).size).toBe(p.hidden.length);
			}),
		);
	});

	it('round-trips through storage and ignores invalid updates', () => {
		strokePrefs.set({
			durationFrames: 15,
			curve: preset('basic.ease-out').curve,
			curvePresetId: 'basic.ease-out',
		});
		strokePrefs.set({ durationFrames: -4, copies: 1000, startAt: 'nowhere' as never });
		expect(strokePrefs.get()).toMatchObject({ durationFrames: 15, copies: 4, startAt: 'playhead' });
		const stored = JSON.parse(localStorage.getItem(strokePrefs.key)!);
		expect(stored.version).toBe(1);
		strokePrefs.reload();
		expect(strokePrefs.get()).toMatchObject({ durationFrames: 15, curvePresetId: 'basic.ease-out' });
		localStorage.setItem(strokePrefs.key, '{not json');
		strokePrefs.reload();
		expect(strokePrefs.get()).toEqual(DEFAULT_STROKE_PREFS);
	});

	it('drops a preset id without its curve', () => {
		expect(parseStrokePrefs({ curve: null, curvePresetId: 'x' }).curvePresetId).toBeNull();
	});
});

describe('UI commands', () => {
	it('is disabled with a reason without a project, a sequence, a shape selection or write access', async () => {
		const drawIn = getCommand('strokeAnimation.drawIn')!;
		expect(drawIn.when!(ctxFor(null))).toBe(false);
		expect(drawIn.disabledReason!(ctxFor(null))).toBeTruthy();
		const { session } = makeSession();
		expect(drawIn.disabledReason!(ctxFor(session))).toBeTruthy();
		expect(drawIn.when!(ctxFor(session))).toBe(false);
		const rect = addShape(session, { type: 'rect' });
		session.select('timeline', [rect]);
		expect(drawIn.when!(ctxFor(session))).toBe(true);

		expect(getCommand('strokeAnimation.addTracer')!.when!(ctxFor(session))).toBe(false);
		expect(getCommand('strokeAnimation.addTracer')!.disabledReason!(ctxFor(session))).toBeTruthy();
		// Unknown args are refused by the schema.
		expect((await runCommand('strokeAnimation.drawIn', ctxFor(session), { spin: 1 })).reason).toBe(
			'invalid-args',
		);
		const ro = new EditorSession({
			projectId: session.getState().document.projectId,
			document: session.getCommitted(),
			ctx: { ids: createCounterIdSource(500), now: () => 't', registries: defaultRegistries() },
			readOnly: true,
		});
		expect(drawIn.when!(ctxFor(ro))).toBe(false);
		expect(drawIn.disabledReason!(ctxFor(ro))).toBeTruthy();
		expect(getCommand('strokeAnimation.addHorizontalLine')!.when!(ctxFor(ro))).toBe(false);
		expect(getCommand('strokeAnimation.addHorizontalLine')!.disabledReason!(ctxFor(ro))).toBeTruthy();
	});

	it('Add Tracer targets the selected trim item and an optional follower', async () => {
		const { session } = makeSession();
		const a = addShape(session, { type: 'vector', contents: [...TRIMMED_PATH, { type: 'trim' }] });
		const follower = addShape(session, { type: 'ellipse' }, 0, 90, 'V2');
		const extra = addShape(session, { type: 'rect' }, 0, 90, 'V3');
		const seq = session.getCommitted().sequences[session.getState().activeSequenceId!]!;
		const contents = (seq.clips[a] as { shape: { contents: { id: string; type: string }[] } }).shape.contents;
		const trims = contents.filter((i) => i.type === 'trim').map((i) => i.id);
		session.select('timeline', [a]);
		// Default: the last top-level trim; the Shape Contents selection and the panel's choice override it.
		expect(tracerTarget(session.getState(), null)).toMatchObject({
			ok: true,
			trimItemId: trims[1],
			followerId: null,
		});
		expect(tracerTarget(session.getState(), null).ok && tracerTarget(session.getState(), null)).toMatchObject(
			{
				trims: [
					{ id: trims[0], root: true },
					{ id: trims[1], root: true },
				],
			},
		);
		expect(tracerTarget(session.getState(), { clipId: a, itemId: trims[0]! })).toMatchObject({
			trimItemId: trims[0],
		});
		expect(tracerTarget(session.getState(), null, trims[0]!)).toMatchObject({ trimItemId: trims[0] });
		expect(tracerTarget(session.getState(), null, 'not-a-trim')).toMatchObject({ trimItemId: trims[1] });
		session.select('timeline', [a, follower]);

		session.select('timeline', [a, follower, extra]);
		expect(tracerTarget(session.getState(), null)).toEqual({
			ok: false,
			reason: expect.any(String),
		});
		const b = addShape(session, { type: 'vector', contents: TRIMMED_PATH }, 0, 90, 'V4');
		session.select('timeline', [a, b]);
		expect(tracerTarget(session.getState(), null)).toEqual({ ok: false, reason: expect.any(String) });
	});
});

describe('Stroke Animation panel', () => {
	const mount = (session: EditorSession) =>
		render(
			<SessionProvider session={session}>
				<StrokeAnimationPanel instanceId="stroke-animation" visible />
			</SessionProvider>,
		);

	it('disables the buttons with the reason until a shape is selected', () => {
		const { session } = makeSession();
		mount(session);
		const btn = screen.getByTestId('stroke-btn-drawIn');
		expect(btn.getAttribute('aria-disabled')).toBe('true');
		expect(screen.getByTestId('stroke-info').textContent).toBeTruthy();
		fireEvent.click(btn);
		expect(session.getState().history.entries).toHaveLength(0);
		// Lines only need a sequence.
		expect(screen.getByTestId('stroke-btn-addHorizontalLine').getAttribute('aria-disabled')).toBeNull();
		const rect = addShape(session, { type: 'rect' });
		act(() => session.select('timeline', [rect]));
		expect(btn.getAttribute('aria-disabled')).toBeNull();
		expect(screen.getByTestId('stroke-btn-addTracer').getAttribute('aria-disabled')).toBe('true');
	});

	it.each([
		{ altKey: false, shiftKey: false, start: [100, 0], end: [], offset: [] },
		{ altKey: true, shiftKey: false, start: [], end: [0, 100], offset: [] },
		{ altKey: false, shiftKey: true, start: [100, 0], end: [], offset: [0, -180] },
		{ altKey: true, shiftKey: true, start: [], end: [0, 100], offset: [0, 180] },
	])(
		'click modifiers change the drawn trim without changing preferences: $altKey / $shiftKey',
		async ({ altKey, shiftKey, start, end, offset }) => {
			const { session, seqId } = makeSession();
			const shape = addShape(session, { type: 'vector', contents: STROKED_PATH });
			session.select('timeline', [shape]);
			strokePrefs.set({ reverse: true });
			mount(session);
			await act(async () => fireEvent.click(screen.getByTestId('stroke-btn-drawIn'), { altKey, shiftKey }));
			const clip = session.getCommitted().sequences[seqId]!.clips[shape] as unknown as {
				shape: {
					contents: {
						type: string;
						start: { keyframes: { value: number }[] };
						end: { keyframes: { value: number }[] };
						offset: { keyframes: { value: number }[] };
					}[];
				};
			};
			const trim = clip.shape.contents.find((item) => item.type === 'trim')!;
			expect(trim.start.keyframes.map((key) => key.value)).toEqual(start);
			expect(trim.end.keyframes.map((key) => key.value)).toEqual(end);
			expect(trim.offset.keyframes.map((key) => key.value)).toEqual(offset);
			expect(strokePrefs.get()).toMatchObject({ reverse: true, animateOffset: false });
		},
	);

	it('edits and persists the settings; hides buttons', () => {
		const { session } = makeSession();
		mount(session);
		expect(screen.getByTestId('stroke-duration-tc').textContent).toBe('00:00:00:10');
		fireEvent.click(screen.getByRole('checkbox', { name: 'Animate offset' }));
		expect(strokePrefs.get().animateOffset).toBe(true);
		fireEvent.click(screen.getByRole('checkbox', { name: 'Divide Out' }));
		expect(strokePrefs.get().hidden).toEqual(['divideOut']);
		expect(screen.queryByTestId('stroke-btn-divideOut')).toBeNull();
		act(() => strokePrefs.set({ curve: preset('basic.ease-out').curve, curvePresetId: 'basic.ease-out' }));
		expect(screen.getByText('Ease Out (CSS)')).toBeTruthy();
		const text = screen.getByTestId('stroke-curve-text') as HTMLInputElement;
		expect(text.value).toBe('0, 0, 0.58, 1');
		fireEvent.change(text, { target: { value: '2, 0, 1, 1' } });
		fireEvent.keyDown(text, { key: 'Enter' });
		expect(screen.getByRole('alert')).toBeTruthy();
		expect(strokePrefs.get().curvePresetId).toBe('basic.ease-out');
		fireEvent.change(text, { target: { value: 'cubic-bezier(0.3, -0.2, 0.7, 1.2)' } });
		fireEvent.keyDown(text, { key: 'Enter' });
		expect(strokePrefs.get()).toMatchObject({
			curve: { kind: 'cubic', x1: 0.3, y1: -0.2, x2: 0.7, y2: 1.2 },
			curvePresetId: null,
		});
		expect(screen.getByText('Custom cubic')).toBeTruthy();
		expect(JSON.parse(localStorage.getItem(strokePrefs.key)!).hidden).toEqual(['divideOut']);
	});
});

describe('with the real shape commands', () => {
	type Item = { id: string; type: string; name: string; contents?: Item[] } & Record<string, unknown>;
	type Anim = { value: number; keyframes: { time: number; value: number }[]; expression?: unknown };
	const contentsOf = (session: EditorSession, id: string) =>
		(
			session.getCommitted().sequences[session.getState().activeSequenceId!]!.clips[id] as unknown as {
				shape: { contents: Item[] };
			}
		).shape.contents;
	const clipsOf = (session: EditorSession) =>
		Object.values(session.getCommitted().sequences[session.getState().activeSequenceId!]!.clips);
	const historyLength = (session: EditorSession) => session.getState().history.entries.length;
	it('Draw In keys Trim Paths at the playhead in one undo step; a re-run replaces it; undo restores', async () => {
		const { session } = makeSession();
		const a = addShape(session, { type: 'vector', contents: STROKED_PATH }, 0, 90);
		const later = addShape(session, { type: 'vector', contents: STROKED_PATH }, 40, 90, 'V2');
		session.select('timeline', [a, later]);
		session.transport.seek(20);
		const toasts: ToastRequest[] = [];
		const before = historyLength(session);
		await runCommand('strokeAnimation.drawIn', ctxFor(session, toasts));
		expect(toasts).toEqual([]);
		expect(historyLength(session)).toBe(before + 1);
		let trims = contentsOf(session, a).filter((i) => i.type === 'trim');
		expect(trims).toHaveLength(1);
		const end = trims[0]!.end as Anim;
		// Key times are flicks of clip content time (705 600 000 per second, 30 fps): frames 20 → 30.
		const frame = 705_600_000 / 30;
		expect(end.keyframes.map((k) => [k.time / frame, k.value])).toEqual([
			[20, 0],
			[30, 100],
		]);
		// The playhead is outside the later clip: it starts at its own content frame zero.
		const laterTrim = contentsOf(session, later).find((item) => item.type === 'trim')!;
		expect((laterTrim.end as Anim).keyframes.map((key) => [key.time / frame, key.value])).toEqual([
			[0, 0],
			[10, 100],
		]);
		// Alt-click (reverse) on the same clip replaces the animation instead of stacking a second trim.
		strokePrefs.set({ startAt: 'clipStart' });
		await runCommand('strokeAnimation.drawIn', ctxFor(session, toasts), { reverse: true });
		trims = contentsOf(session, a).filter((i) => i.type === 'trim');
		expect(trims).toHaveLength(1);
		expect((trims[0]!.start as Anim).keyframes.map((key) => [key.time / frame, key.value])).toEqual([
			[0, 100],
			[10, 0],
		]);
		session.undo();
		session.undo();
		expect(contentsOf(session, a).some((i) => i.type === 'trim')).toBe(false);
	});

	it('Divide Out converts rectangles and exposes the divided animation’s master trim', async () => {
		const { session } = makeSession();
		const a = addShape(session, { type: 'vector', contents: STROKED_PATH }, 0, 90, 'V1');
		const rect = addShape(
			session,
			{ type: 'rect', stroke: { color: [1, 1, 1, 1], width: 6, position: 'center' } },
			0,
			90,
			'V2',
		);
		session.select('timeline', [a, rect]);
		strokePrefs.set({
			copies: 3,
			offsetDegrees: 90,
			curve: { kind: 'cubic', x1: 0.2, y1: 0, x2: 0.8, y2: 1 },
			curvePresetId: null,
		});
		const toasts: ToastRequest[] = [];
		expect(
			(await runCommand('strokeAnimation.divideOut', ctxFor(session, toasts), { animateOffset: true })).ran,
		).toBe(true);
		expect(toasts).toEqual([]);
		const seq = session.getCommitted().sequences[session.getState().activeSequenceId!]!;
		expect((seq.clips[rect] as unknown as { shape: { type: string } }).shape.type).toBe('vector');
		// The last style was Divide Out with 3 copies: three parts.
		expect(contentsOf(session, a).filter((i) => i.type === 'group')).toHaveLength(3);
		// Add Tracer follows the divided animation's master trim (in Part 1; the other parts' trims are driven by it).
		session.select('timeline', [a]);
		const part1 = contentsOf(session, a).find((i) => i.type === 'group')!;
		const master = part1.contents!.find((i) => i.type === 'trim')!;
		const start = master.start as { keyframes: { easeOut: { influence: number; slope: number } }[] };
		expect(start.keyframes[0]!.easeOut).toEqual({ influence: 0.2, slope: 0 });
		expect((master.offset as Anim).keyframes.map((key) => key.value)).toEqual([0, 90]);
		const target = tracerTarget(session.getState(), null);
		expect(target.ok && target.trimItemId).toBe(master.id);
		expect(target.ok && target.trims.map((t) => t.name)).toEqual([
			`${part1.name} › ${master.name}`,
			expect.stringContaining('›'),
			expect.stringContaining('›'),
		]);
	});

	it('reports skipped clips and refuses when nothing applies, without changing the document', async () => {
		const { session } = makeSession();
		const a = addShape(session, { type: 'vector', contents: STROKED_PATH }, 0, 90, 'V1');
		const fillOnly = addShape(session, { type: 'vector', contents: [{ type: 'fill' }] }, 0, 90, 'V2');
		session.select('timeline', [a, fillOnly]);
		const toasts: ToastRequest[] = [];
		await runCommand('strokeAnimation.drawOut', ctxFor(session, toasts));
		expect(toasts).toHaveLength(1);
		expect(toasts[0]).toMatchObject({ kind: 'warning' });
		expect(toasts[0]!.message).toContain('1 skipped');
		session.select('timeline', [fillOnly]);
		const doc = session.getCommitted();
		await runCommand('strokeAnimation.drawOut', ctxFor(session, toasts));
		expect(toasts.at(-1)).toMatchObject({ kind: 'error' });
		expect(session.getCommitted()).toBe(doc);
	});

	it('Tracer on Next adds a tracer for each animated clip in the same History entry', async () => {
		// No History coalescing (window 0): one entry proves one transaction.
		const { session } = makeSession();
		const a = addShape(session, { type: 'vector', contents: STROKED_PATH }, 0, 90, 'V1');
		// Skipped by the animation (nothing to trim): it must not get a tracer.
		const fillOnly = addShape(session, { type: 'vector', contents: [{ type: 'fill' }] }, 0, 90, 'V2');
		session.select('timeline', [a, fillOnly]);
		strokePrefs.set({ addTracer: true });
		const before = historyLength(session);
		const clipsBefore = clipsOf(session).length;
		const toasts: ToastRequest[] = [];
		await runCommand('strokeAnimation.growFromMiddle', ctxFor(session, toasts));
		expect(toasts).toHaveLength(1);
		expect(toasts[0]).toMatchObject({ kind: 'warning' });
		expect(toasts[0]!.message).toContain('1 skipped');
		expect(clipsOf(session)).toHaveLength(clipsBefore + 1);
		const tracer = clipsOf(session).find((c) => c.id !== a && c.id !== fillOnly)! as unknown as {
			transform: { position: { expression?: { text: string } } };
		};
		expect(tracer.transform.position.expression?.text).toContain(a);
		expect(historyLength(session)).toBe(before + 1);
		session.undo();
		expect(clipsOf(session)).toHaveLength(clipsBefore);
		expect(contentsOf(session, a).some((i) => i.type === 'trim')).toBe(false);
		session.redo();
		expect(clipsOf(session)).toHaveLength(clipsBefore + 1);
	});

	it('Add Tracer drives a selected follower; lines and path reversal apply', async () => {
		const { session } = makeSession();
		const a = addShape(session, { type: 'vector', contents: STROKED_PATH }, 0, 90, 'V1');
		const follower = addShape(session, { type: 'ellipse' }, 0, 90, 'V2');
		session.select('timeline', [a]);
		await runCommand('strokeAnimation.drawIn', ctxFor(session));
		session.select('timeline', [a, follower]);
		const toasts: ToastRequest[] = [];
		expect((await runCommand('strokeAnimation.addTracer', ctxFor(session, toasts))).ran).toBe(true);
		expect(toasts).toEqual([]);
		const f = session.getCommitted().sequences[session.getState().activeSequenceId!]!.clips[
			follower
		] as unknown as {
			transform: { position: { expression?: { text: string } }; rotation: { expression?: { text: string } } };
		};
		expect(f.transform.position.expression?.text).toBeTruthy();
		expect(f.transform.rotation.expression?.text).toBeTruthy(); // orient (Settings default on)

		session.select('timeline', [a]);
		const path = () => contentsOf(session, a).find((i) => i.type === 'rect')!;
		const dir = path().direction;
		await runCommand('strokeAnimation.reversePath', ctxFor(session, toasts));
		expect(path().direction).not.toEqual(dir);
		expect(toasts).toEqual([]);

		session.transport.seek(15);
		const n = clipsOf(session).length;
		await runCommand('strokeAnimation.addHorizontalLine', ctxFor(session, toasts));
		expect(toasts).toEqual([]);
		expect(clipsOf(session)).toHaveLength(n + 1);
		const line = session.getState().selection.timeline.clips[0]!;
		const lineClip = session.getCommitted().sequences[session.getState().activeSequenceId!]!.clips[line]!;
		expect(lineClip.start).toBe(15);
		expect(contentsOf(session, line).map((i) => i.type)).toContain('stroke');
	});
});
