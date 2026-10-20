import {
	BUILTIN_EASE_GROUPS,
	builtinEasePresets,
	CubicEaseSchema,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	type TransactionResult,
} from '@jasper/project';
import { EditorSession } from '@jasper/session';
import { SessionProvider } from '@jasper/session/react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getCommand, registerAllCommands, runCommand } from '../src/commands/index.ts';
import type { CommandCtx, ToastRequest } from '../src/commands/types.ts';
import { StrokeAnimationBody } from '../src/panels/strokeAnimation/StrokeAnimationPanel.tsx';
import { vectorUi } from '../src/shapes/vector.ts';
import { MENUBAR } from '../src/shell/menus/model.ts';
import type { ShellMenuItem } from '../src/shell/menus/resolve.ts';
import {
	ANIMATE_TRIM_STYLES,
	type AnimateTrimCommand,
	type AnimateTrimStyle,
	type StrokeTx,
	setStrokeAnimationAdapter,
} from '../src/stroke-animation/adapter.ts';
import {
	animationStart,
	buildAnimateCommands,
	effectiveFlags,
	formatCubic,
	masterTrims,
	parseCubic,
	presetForCurve,
	presetLabel,
	STROKE_ACTIONS,
	STROKE_REASONS,
	type StrokeCurvePreset,
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

/** Records the transactions and answers like the shape commands would. */
function stubAdapter(answer?: (tx: StrokeTx) => TransactionResult) {
	const txs: StrokeTx[] = [];
	setStrokeAnimationAdapter({
		apply: (_s, tx) => {
			txs.push(tx);
			return (
				answer?.(tx) ?? {
					ok: true,
					revision: txs.length,
					refs: {},
					created: [],
					changed: [],
					deleted: [],
					warnings: [],
					results: tx.commands.map(() => null),
				}
			);
		},
	});
	return txs;
}

function ctxFor(session: EditorSession | null, toasts: ToastRequest[] = []): CommandCtx {
	return {
		session,
		transport: session?.transport,
		ui: { toast: (r: ToastRequest) => toasts.push(r), openDialog: () => {} },
		capabilities: new Set(),
	} as unknown as CommandCtx;
}

beforeEach(() => {
	localStorage.clear();
	strokePrefs.reload();
	registerAllCommands();
});
afterEach(() => {
	cleanup();
	setStrokeAnimationAdapter(null);
	vectorUi.set({ selected: null, vertices: [], collapsed: {} });
	localStorage.clear();
	strokePrefs.reload();
});

describe('payloads', () => {
	const clip = { id: 'c1', start: 30, duration: 60 };

	it('maps every style × modifier to the contract payload', () => {
		for (const style of ANIMATE_TRIM_STYLES)
			for (const reverse of [false, true])
				for (const animateOffset of [false, true]) {
					const [cmd, ...rest] = buildAnimateCommands(
						style,
						[clip],
						DEFAULT_STROKE_PREFS,
						{ reverse, animateOffset },
						0,
					);
					expect(rest).toEqual([]);
					const want: AnimateTrimCommand = {
						type: 'shape.animateTrim',
						clipIds: ['c1'],
						style,
						reverse,
						animateOffset,
						durationFrames: 10,
						...(animateOffset ? { offsetDegrees: 180 } : {}),
						...(style === 'divideIn' || style === 'divideOut' ? { copies: 4 } : {}),
						...(style === 'inOut' ? { inOutLag: 0.5 } : {}),
					};
					expect(cmd).toEqual(want);
				}
	});

	it('Alt toggles Reverse and Shift toggles Animate offset relative to the checkboxes', () => {
		for (const reverse of [false, true])
			for (const animateOffset of [false, true])
				for (const alt of [false, true])
					for (const shift of [false, true])
						expect(effectiveFlags({ reverse, animateOffset }, { alt, shift })).toEqual({
							reverse: reverse !== alt,
							animateOffset: animateOffset !== shift,
						});
	});

	it('starts at the playhead only inside the clip, and groups clips by start', () => {
		expect(animationStart(clip, 45, 'playhead')).toBe(45);
		expect(animationStart(clip, 30, 'playhead')).toBeUndefined(); // = clip start
		expect(animationStart(clip, 90, 'playhead')).toBeUndefined(); // the clip's end is outside it
		expect(animationStart(clip, 10, 'playhead')).toBeUndefined();
		expect(animationStart(clip, 45, 'clipStart')).toBeUndefined();
		expect(animationStart(clip, Number.NaN, 'playhead')).toBeUndefined();
		const other = { id: 'c2', start: 200, duration: 30 };
		const third = { id: 'c3', start: 0, duration: 100 };
		const cmds = buildAnimateCommands(
			'in',
			[clip, other, third],
			DEFAULT_STROKE_PREFS,
			{ reverse: false, animateOffset: false },
			45,
		);
		expect(cmds.map((c) => [c.clipIds, c.at])).toEqual([
			[['c1', 'c3'], 45],
			[['c2'], undefined],
		]);
	});

	it('sends the settings and the curve', () => {
		const curve = preset('basic.ease').curve;
		const prefs = { ...DEFAULT_STROKE_PREFS, durationFrames: 24, copies: 7, inOutLag: 0.25, curve };
		const [divide] = buildAnimateCommands(
			'divideOut',
			[clip],
			prefs,
			{ reverse: true, animateOffset: false },
			0,
		);
		expect(divide).toMatchObject({ durationFrames: 24, copies: 7, curve, reverse: true });
		expect(divide).not.toHaveProperty('inOutLag');
		const [inOut] = buildAnimateCommands('inOut', [clip], prefs, { reverse: false, animateOffset: true }, 0);
		expect(inOut).toMatchObject({ inOutLag: 0.25, offsetDegrees: 180, animateOffset: true });
		expect(inOut).not.toHaveProperty('copies');
	});

	it('reads the master trim of each clip from the results and ignores anything else', () => {
		expect(
			masterTrims([
				{ clips: [{ clipId: 'a', trimItemIds: ['t1', 't2'] }] },
				null,
				{ clips: [{ clipId: 'b', trimItemIds: [] }] },
				'x',
				{ clips: [{ clipId: 'c', trimItemIds: ['t9'] }] },
			]),
		).toEqual([
			{ clipId: 'a', trimItemId: 't1' },
			{ clipId: 'c', trimItemId: 't9' },
		]);
	});
});

describe('curve presets', () => {
	it('offers the cubic presets of the built-in catalogue only', () => {
		expect(CURVES.length).toBeGreaterThan(10);
		expect(CURVES.every((p) => p.curve.kind === 'cubic' && CubicEaseSchema.safeParse(p.curve).success)).toBe(
			true,
		);
		expect(builtinEasePresets().some((p) => p.curve.kind === 'multi')).toBe(true);
		expect(CURVES.some((p) => p.curve.kind !== 'cubic')).toBe(false);
	});

	it('shows a stored curve as its preset, or the preset with the same shape', () => {
		const ease = preset('basic.easy-ease');
		expect(presetForCurve(ease.curve, ease.id, CURVES)?.id).toBe('basic.easy-ease');
		expect(presetForCurve({ ...ease.curve }, null, CURVES)?.id).toBe('basic.easy-ease');
		expect(presetForCurve({ kind: 'cubic', x1: 0.9, y1: -2, x2: 0.1, y2: 3 }, null, CURVES)).toBeNull();
		expect(presetForCurve(null, 'basic.easy-ease', CURVES)).toBeNull();
	});

	it('labels presets with their group outside Basic', () => {
		const id = (s: string) => s;
		expect(presetLabel(preset('basic.ease'), id)).toBe('Ease (CSS)');
		const other = CURVES.find((p) => p.group !== 'basic')!;
		expect(presetLabel(other, id)).toBe(
			`${BUILTIN_EASE_GROUPS.find((g) => g.id === other.group)!.name} · ${other.name}`,
		);
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
	it('every action has a registered command, and the menu lists each of them', () => {
		const ids = new Set<string>();
		const walk = (items: readonly ShellMenuItem[]) => {
			for (const it of items) {
				if (it.type === 'command') ids.add(it.command);
				if (it.type === 'submenu') walk(it.items);
			}
		};
		walk(MENUBAR.find((m) => m.id === 'graphics')!.items);
		for (const a of STROKE_ACTIONS) {
			expect(getCommand(a.command), a.command).toBeDefined();
			expect(ids.has(a.command), a.command).toBe(true);
		}
		expect(ids.has('panel.focus.strokeAnimation')).toBe(true);
		expect(getCommand('panel.focus.strokeAnimation')).toBeDefined();
	});

	it('is disabled with a reason without a project, a sequence, a shape selection or write access', async () => {
		const drawIn = getCommand('strokeAnimation.drawIn')!;
		expect(drawIn.when!(ctxFor(null))).toBe(false);
		expect(drawIn.disabledReason!(ctxFor(null))).toBe(STROKE_REASONS.noProject);
		const { session } = makeSession();
		expect(drawIn.disabledReason!(ctxFor(session))).toBe(STROKE_REASONS.noShape);
		const rect = addShape(session, { type: 'rect' });
		session.select('timeline', [rect]);
		expect(drawIn.when!(ctxFor(session))).toBe(true);
		const txs = stubAdapter();
		const r = await runCommand('strokeAnimation.drawIn', ctxFor(session), { reverse: true });
		expect(r.ran).toBe(true);
		expect(txs[0]!.commands).toEqual([
			{
				type: 'shape.animateTrim',
				clipIds: [rect],
				style: 'in',
				reverse: true,
				animateOffset: false,
				durationFrames: 10,
			},
		]);
		expect(getCommand('strokeAnimation.addTracer')!.disabledReason!(ctxFor(session))).toBe(
			STROKE_REASONS.noTrim,
		);
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
		expect(drawIn.disabledReason!(ctxFor(ro))).toBe(STROKE_REASONS.readOnly);
		expect(getCommand('strokeAnimation.addHorizontalLine')!.disabledReason!(ctxFor(ro))).toBe(
			STROKE_REASONS.readOnly,
		);
	});

	it('shows refusals and skipped-clip warnings as notifications', async () => {
		const { session } = makeSession();
		const a = addShape(session, { type: 'vector', contents: STROKED_PATH });
		session.select('timeline', [a]);
		const toasts: ToastRequest[] = [];
		stubAdapter(() => ({
			ok: false,
			revision: 0,
			errors: [{ commandIndex: 0, code: 'E_INVALID_PARAM', message: 'No path' }],
		}));
		await runCommand('strokeAnimation.divideIn', ctxFor(session, toasts));
		expect(toasts.at(-1)).toMatchObject({ kind: 'error', detail: 'No path' });
		stubAdapter(() => ({
			ok: true,
			revision: 1,
			refs: {},
			created: [],
			changed: [],
			deleted: [],
			warnings: [{ commandIndex: 0, code: 'W_TRIM_SKIPPED', message: 'Clip “Text” has no paths: skipped' }],
			results: [null],
		}));
		await runCommand('strokeAnimation.drawOut', ctxFor(session, toasts));
		expect(toasts.at(-1)).toMatchObject({ kind: 'warning', detail: 'Clip “Text” has no paths: skipped' });
		expect(toasts.at(-1)!.message).toContain('1 skipped');
	});

	it('adds tracers to the next animation in the same undo step', async () => {
		const { session } = makeSession();
		const a = addShape(session, { type: 'vector', contents: STROKED_PATH });
		session.select('timeline', [a]);
		strokePrefs.set({ addTracer: true, tracerTip: 'end' });
		const txs = stubAdapter((tx) => ({
			ok: true,
			revision: 1,
			refs: {},
			created: [],
			changed: [],
			deleted: [],
			warnings: [],
			results: tx.commands.map((c) =>
				c.type === 'shape.animateTrim' ? { clips: [{ clipId: a, trimItemIds: ['trimA', 'trimA2'] }] } : null,
			),
		}));
		await runCommand('strokeAnimation.drawIn', ctxFor(session));
		expect(txs).toHaveLength(2);
		expect(txs[1]!.commands).toEqual([
			{ type: 'shape.addTrimTracer', clipId: a, trimItemId: 'trimA', tip: 'end' },
		]);
		expect(txs[0]!.coalesceKey).toBeDefined();
		expect(txs[1]!.coalesceKey).toBe(txs[0]!.coalesceKey);
		expect(txs[1]!.label).toBe(txs[0]!.label);
		expect(getCommand('strokeAnimation.toggleTracer')!.checked!(ctxFor(session))).toBe(true);
		await runCommand('strokeAnimation.toggleTracer', ctxFor(session));
		expect(strokePrefs.get().addTracer).toBe(false);
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
		expect(tracerTarget(session.getState(), null)).toMatchObject({
			ok: true,
			trimItemId: trims[0],
			followerId: null,
		});
		expect(tracerTarget(session.getState(), { clipId: a, itemId: trims[1]! })).toMatchObject({
			trimItemId: trims[1],
		});
		session.select('timeline', [a, follower]);
		const txs = stubAdapter();
		await runCommand('strokeAnimation.addTracer', ctxFor(session));
		expect(txs[0]!.commands).toEqual([
			{
				type: 'shape.addTrimTracer',
				clipId: a,
				trimItemId: trims[0],
				tip: 'auto',
				follower: { clipId: follower },
				orient: true,
			},
		]);
		session.select('timeline', [a, follower, extra]);
		expect(tracerTarget(session.getState(), null)).toEqual({
			ok: false,
			reason: STROKE_REASONS.manyFollowers,
		});
		const b = addShape(session, { type: 'vector', contents: TRIMMED_PATH }, 0, 90, 'V4');
		session.select('timeline', [a, b]);
		expect(tracerTarget(session.getState(), null)).toEqual({ ok: false, reason: STROKE_REASONS.manyTrims });
	});

	it('adds lines at the playhead on a free track and selects them', async () => {
		const { session } = makeSession();
		addShape(session, { type: 'rect' }, 0, 300, 'V1');
		session.transport.seek(40);
		const txs = stubAdapter();
		await runCommand('strokeAnimation.addVerticalLine', ctxFor(session));
		expect(txs[0]).toMatchObject({ selectCreated: true });
		const cmd = txs[0]!.commands[0]!;
		expect(cmd).toMatchObject({
			type: 'shape.addLine',
			orientation: 'vertical',
			at: 40,
			durationFrames: 150,
		});
		const tracks = session.getCommitted().sequences[session.getState().activeSequenceId!]!.videoTracks;
		expect(cmd).toHaveProperty('trackId', tracks[1]!.id);
		await runCommand('strokeAnimation.reversePath', ctxFor(session));
		expect(txs).toHaveLength(1); // nothing selected: not run
	});
});

describe('Stroke Animation panel', () => {
	const mount = (session: EditorSession, presets: readonly StrokeCurvePreset[] = []) =>
		render(
			<SessionProvider session={session}>
				<StrokeAnimationBody session={session} curvePresets={presets} />
			</SessionProvider>,
		);

	it('disables the buttons with the reason until a shape is selected', () => {
		const { session } = makeSession();
		const txs = stubAdapter();
		mount(session);
		const btn = screen.getByTestId('stroke-btn-drawIn');
		expect(btn.getAttribute('aria-disabled')).toBe('true');
		expect(screen.getByTestId('stroke-info').textContent).toBe(STROKE_REASONS.noShape);
		fireEvent.click(btn);
		expect(txs).toHaveLength(0);
		// Lines only need a sequence.
		expect(screen.getByTestId('stroke-btn-addHorizontalLine').getAttribute('aria-disabled')).toBeNull();
		const rect = addShape(session, { type: 'rect' });
		act(() => session.select('timeline', [rect]));
		expect(btn.getAttribute('aria-disabled')).toBeNull();
		expect(screen.getByTestId('stroke-info').textContent).toContain('1 shape clip selected');
		expect(screen.getByTestId('stroke-btn-addTracer').getAttribute('aria-disabled')).toBe('true');
	});

	it('maps every animation button × Alt / Shift to its payload', () => {
		const { session } = makeSession();
		const rect = addShape(session, { type: 'rect' }, 0, 90);
		session.select('timeline', [rect]);
		strokePrefs.set({ reverse: true });
		const txs = stubAdapter();
		mount(session);
		const animations = STROKE_ACTIONS.filter((a) => a.style);
		expect(animations.map((a) => a.style).sort()).toEqual([...ANIMATE_TRIM_STYLES].sort());
		const mods = [
			{ altKey: false, shiftKey: false },
			{ altKey: true, shiftKey: false },
			{ altKey: false, shiftKey: true },
			{ altKey: true, shiftKey: true },
		];
		for (const a of animations)
			for (const m of mods) {
				fireEvent.click(screen.getByTestId(`stroke-btn-${a.id}`), m);
				const cmd = txs.at(-1)!.commands[0] as AnimateTrimCommand;
				expect(cmd.style).toBe(a.style as AnimateTrimStyle);
				expect(cmd.clipIds).toEqual([rect]);
				// Reverse is checked: Alt turns it off for the click; Shift turns Animate offset on.
				expect(cmd.reverse).toBe(!m.altKey);
				expect(cmd.animateOffset).toBe(m.shiftKey);
			}
		expect(txs).toHaveLength(animations.length * mods.length);
		expect(strokePrefs.get()).toMatchObject({ reverse: true, animateOffset: false });
	});

	it('edits and persists the settings; hides buttons', () => {
		const { session } = makeSession();
		mount(session, [...CURVES]);
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
