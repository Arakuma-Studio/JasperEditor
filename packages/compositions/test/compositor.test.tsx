// compositor: the flat compositor's planning (fx/flat-plan.ts) and the structure the composition builds (happy-dom,
// GPU and HTML-in-Canvas mocked): stacks whose canvas scopes would nest are drawn flat, stacks that worked before keep
// the nested structure, and — a property over random stacks — no HTML-in-Canvas canvas ever lies inside another one.
// The pixels: compositor.e2e.test.ts (Remotion renders in Chrome).
import {
	applyTransaction,
	BLEND_MODES,
	buildRenderSnapshot,
	type Command,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	type RenderSnapshot,
} from '@jasper/project';
import { Thumbnail } from '@remotion/player';
import { cleanup, render } from '@testing-library/react';
import fc from 'fast-check';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
	clipDrawsThroughCanvas,
	docUsesCanvas,
	FLAT_BACKGROUND_KEY,
	type FlatTrackInput,
	flatOpsAt,
	flatStackReason,
	isDomPictureClip,
} from '../src/fx/flat-plan.ts';
import { fxStatus } from '../src/fx/status.ts';
import { DEFAULT_RENDER_OPTIONS, SequenceComposition } from '../src/index.ts';
import { cssExactAdjustment } from '../src/layers/AdjustmentScope.tsx';

vi.mock('../src/color/gl.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('../src/color/gl.ts')>()),
	canUseWebGl2: () => true,
	colorStageBackend: () => 'webgl',
}));
vi.mock('../src/fx/host.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('../src/fx/host.ts')>()),
	fxHost: () => ({}),
	runShaderPlan: () => {},
	runLutPass: () => {},
}));
vi.mock('../src/fx/FxPicture.tsx', async (importOriginal) => ({
	...(await importOriginal<typeof import('../src/fx/FxPicture.tsx')>()),
	canUseHtmlInCanvas: () => true,
}));
// The structure is under test, not the GPU: the matte tap step delivers nothing here (it would composite on the GPU).
vi.mock('../src/fx/matte.ts', async (importOriginal) => {
	const { createEffect } = await import('remotion');
	return {
		...(await importOriginal<typeof import('../src/fx/matte.ts')>()),
		fxMatteTap: createEffect<{ key: string }, null>({
			type: 'test.matte-tap',
			label: 'matte tap (test)',
			documentationLink: null,
			backend: '2d',
			calculateKey: (p) => p.key,
			schema: {},
			validateParams: () => {},
			setup: () => null,
			apply: () => {},
			cleanup: () => {},
		}),
	};
});
vi.mock('../src/three-d/gl.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('../src/three-d/gl.ts')>()),
	renderClassicGL: () => {},
}));
vi.mock('../src/fx/transition.tsx', async (importOriginal) => ({
	...(await importOriginal<typeof import('../src/fx/transition.tsx')>()),
	htmlInCanvasAvailable: () => true,
}));

function fake2d(canvas: HTMLCanvasElement) {
	const noop = () => {};
	return new Proxy(
		{
			canvas,
			globalCompositeOperation: 'source-over',
			filter: 'none',
			fillStyle: '#000',
			// HTML-in-Canvas (Remotion's support probe looks for these).
			drawElementImage: () => new DOMMatrix(),
		},
		{
			get: (t, k) =>
				k in t
					? (t as Record<string | symbol, unknown>)[k]
					: k === 'getImageData'
						? (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) })
						: noop,
			set: (t, k, v) => {
				(t as Record<string | symbol, unknown>)[k] = v;
				return true;
			},
		},
	);
}
const originalGetContext = HTMLCanvasElement.prototype.getContext;
const proto = HTMLCanvasElement.prototype as unknown as Record<string, unknown>;
const HIC = ['requestPaint', 'captureElementImage', 'transferControlToOffscreen'] as const;
beforeAll(() => {
	HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string) {
		return type === '2d' ? fake2d(this) : null;
	} as never;
	// HTML-in-Canvas as Chrome has it (no paint ever happens here: the structure is what is tested).
	proto.requestPaint = () => {};
	proto.captureElementImage = () => ({ width: 1, height: 1, close: () => {} });
	proto.transferControlToOffscreen = function (this: HTMLCanvasElement) {
		return this;
	};
	fxStatus.reset();
});
afterAll(() => {
	HTMLCanvasElement.prototype.getContext = originalGetContext;
	for (const k of HIC) delete proto[k];
});
afterEach(() => cleanup());

function makeDoc(
	commands: Command[] | ((p: ReturnType<typeof createEmptyProject>) => Command[]),
): RenderSnapshot {
	const ids = createCounterIdSource(1);
	const base = createEmptyProject({ ids, name: 'F', preset: 'hd-720p-30' });
	const seqId = Object.keys(base.sequences)[0]!;
	if (typeof commands === 'function') commands = commands(base);
	const { document, result } = applyTransaction(
		base,
		{
			label: 'setup',
			origin: 'user',
			sequenceId: seqId,
			commands: [
				{
					type: 'sequence.updateSettings',
					sequenceId: seqId,
					settings: { width: 320, height: 180 },
				} as Command,
				...commands,
			],
		},
		{ ids, now: () => 't', revision: 0, registries: defaultRegistries() },
	);
	if (!result.ok) throw new Error(JSON.stringify(result.errors));
	return buildRenderSnapshot(document, seqId, { resolveMedia: () => null, resolveFont: () => null });
}

function renderFrame(doc: RenderSnapshot, frame = 3, isPreview = false) {
	return render(
		<Thumbnail
			component={SequenceComposition}
			inputProps={{ doc, options: { ...DEFAULT_RENDER_OPTIONS, isPreview } }}
			compositionWidth={doc.settings.width}
			compositionHeight={doc.settings.height}
			durationInFrames={Math.max(1, doc.durationFrames)}
			fps={doc.settings.fps.num / doc.settings.fps.den}
			frameToDisplay={frame}
		/>,
	);
}

/** The composition rendered (not the Player's error card). */
function rendered(root: Element): void {
	expect(root.textContent ?? '').not.toContain('⚠️');
	expect(root.querySelector('[data-track-id]')).not.toBeNull();
}

/** HTML-in-Canvas canvases (a canvas with element children) that lie inside another one. */
function nestedCanvases(root: Element): Element[] {
	const scopes = [...root.querySelectorAll('canvas')].filter((c) => c.children.length > 0);
	return scopes.filter((c) => scopes.some((o) => o !== c && o.contains(c)));
}

const solid = (track: string, ref: string, color = [0.5, 0.5, 0.5, 1]): Command =>
	({ type: 'clip.addSolid', at: 0, duration: 30, track, color, ref }) as Command;
const mode = (ref: string, blendMode: string): Command =>
	({ type: 'clip.update', clipId: ref, patch: { blendMode } }) as Command;
const adjustment = (track: string, ref: string): Command =>
	({ type: 'clip.addAdjustment', at: 0, duration: 30, track, ref }) as Command;
const effect = (ref: string, effectId: string): Command =>
	({ type: 'effect.add', target: { clipId: ref }, effectId }) as Command;
const text = (track: string, ref: string): Command =>
	({
		type: 'clip.addText',
		at: 0,
		duration: 30,
		track,
		content: { text: 'Hi', style: { fontSize: 40 } },
		ref,
	}) as Command;
const threeD = (ref: string): Command => ({ type: 'clip.set3d', clipIds: [ref], enabled: true }) as Command;
const linear = { type: 'sequence.updateSettings', settings: { color: { blendLinear: true } } } as Command;

// ---------------------------------------------------------------- planning

describe('flat compositor planning', () => {
	const t = (index: number, over: Partial<FlatTrackInput> = {}): FlatTrackInput => ({
		trackId: `V${index + 1}`,
		index,
		layers: { trackId: `V${index + 1}`, clips: [], stages: [] },
		mattes: [],
		adjustments: [],
		...over,
	});
	const clip = (clipId: string, start: number, duration: number, blendMode = 'normal') => ({
		clipId,
		start,
		duration,
		blendMode,
	});

	it('orders the steps like the nested structure: background, then per track adjustment, mattes, 3D run, layers', () => {
		const tracks = [
			t(0, { layers: { trackId: 'V1', clips: [clip('a', 0, 10)], stages: [] } }),
			t(1, {
				adjustments: [{ start: 0, duration: 10 }],
				mattes: [{ id: 'm', start: 0, duration: 5, color: [0, 0, 0, 1] }],
				layers: { trackId: 'V2', clips: [clip('b', 0, 10, 'linear-burn')], stages: [] },
			}),
			t(2, {
				layers: {
					trackId: 'V3',
					clips: [clip('c', 0, 10)],
					stages: [{ id: 'tr', start: 2, duration: 4, blendMode: 'normal' }],
				},
			}),
		];
		const ops = flatOpsAt(tracks, 3, {
			background: [0, 0, 0, 1],
			isGpuSide: (id) => id === 'c',
			run3dAt: (i) => i === 2,
		});
		expect(
			ops.map((op) => (op.kind === 'layers' ? op.items.map((it) => it.key).join('+') : `${op.kind}`)),
		).toEqual([`${FLAT_BACKGROUND_KEY}+a`, 'adjust', 'matte:m+b', 'run3d', 'transition:tr']);
		// Every drawn layer is an item, Normal ones included, with its own mode.
		const items = ops.flatMap((op) => (op.kind === 'layers' ? op.items : []));
		expect(items.find((it) => it.key === 'b')).toMatchObject({ kind: 'clip', mode: 'linear-burn' });
		// Outside their spans: nothing but the background and the layers drawn.
		expect(flatOpsAt(tracks, 20, { background: null, isGpuSide: () => false })).toEqual([]);
	});

	it('needs a flat stack exactly when scopes would nest', () => {
		expect(flatStackReason([], [0, 1])).toBeNull();
		expect(flatStackReason([{ track: 2, kind: 'blend' }], [2, 3])).toBeNull();
		expect(flatStackReason([{ track: 2, kind: 'blend' }], [1])).toMatch(/below blend modes/);
		expect(
			flatStackReason(
				[
					{ track: 1, kind: 'adjustment' },
					{ track: 3, kind: 'blend' },
				],
				[],
			),
		).toMatch(/2 canvas scopes/);
	});

	it('knows which layers draw through HTML-in-Canvas', () => {
		const doc = makeDoc([
			text('V1', '$t'),
			text('V2', '$u'),
			effect('$u', 'jasper.invert'),
			solid('V3', '$s'),
			effect('$s', 'jasper.invert'),
			text('V4', '$c'),
			effect('$c', 'jasper.black-white'),
		]);
		const [t1, t2, s3, t4] = doc.videoTracks.map((tr) => tr.clips[0]!);
		expect(isDomPictureClip(t1!, null)).toBe(true);
		expect(clipDrawsThroughCanvas(t1!, null)).toBe(false);
		expect(clipDrawsThroughCanvas(t1!, null, true)).toBe(true);
		expect(clipDrawsThroughCanvas(t2!, null)).toBe(true);
		// A solid's effects run through FxPicture (a canvas source), never HTML-in-Canvas.
		expect(clipDrawsThroughCanvas(s3!, null)).toBe(false);
		// Colour effects of DOM layers run in their canvas chain.
		expect(clipDrawsThroughCanvas(t4!, null)).toBe(true);
	});

	it('knows which sequences draw through HTML-in-Canvas (nested ones and the display transform)', () => {
		const uses = (cmds: Command[]) => docUsesCanvas(makeDoc(cmds), cssExactAdjustment);
		expect(uses([solid('V1', '$a'), text('V2', '$t')])).toBe(false);
		// CSS blend modes and CSS-exact adjustment layers do not capture.
		expect(uses([solid('V1', '$a'), solid('V2', '$b'), mode('$b', 'multiply')])).toBe(false);
		expect(uses([solid('V1', '$a'), adjustment('V2', '$j'), effect('$j', 'jasper.gaussian-blur')])).toBe(
			false,
		);
		expect(uses([solid('V1', '$a'), solid('V2', '$b'), mode('$b', 'linear-burn')])).toBe(true);
		expect(uses([solid('V1', '$a'), adjustment('V2', '$j'), effect('$j', 'jasper.invert')])).toBe(true);
		expect(uses([solid('V1', '$a'), threeD('$a')])).toBe(true);
		expect(uses([linear, solid('V1', '$a')])).toBe(true);
		expect(uses([text('V1', '$t'), effect('$t', 'jasper.invert')])).toBe(true);
	});
});

// ---------------------------------------------------------------- structure

describe('the composition draws flat only what would nest', () => {
	it('keeps the nested structure for one scope (every stack that worked before)', () => {
		const { container } = renderFrame(
			makeDoc([solid('V1', '$a'), solid('V2', '$b'), mode('$b', 'linear-burn'), text('V3', '$t')]),
		);
		rendered(container);
		expect(container.querySelector('[data-flat-compositor]')).toBeNull();
		expect(container.querySelector('[data-blend-scope="canvas"]')).not.toBeNull();
	});

	it('draws an adjustment layer with GPU effects over a GL blend flat (no scope at all)', () => {
		const { container } = renderFrame(
			makeDoc([
				solid('V1', '$a'),
				solid('V2', '$b'),
				mode('$b', 'linear-burn'),
				adjustment('V3', '$j'),
				effect('$j', 'jasper.invert'),
			]),
		);
		expect(container.querySelector('[data-flat-compositor]')).not.toBeNull();
		expect(container.querySelector('[data-blend-scope]')).toBeNull();
		expect(container.querySelector('[data-adjustment-scope]')).toBeNull();
		rendered(container);
		expect(nestedCanvases(container)).toEqual([]);
	});

	it('draws a DOM layer with GPU effects under a GL blend flat', () => {
		const { container } = renderFrame(
			makeDoc([
				text('V1', '$t'),
				effect('$t', 'jasper.invert'),
				solid('V2', '$b'),
				mode('$b', 'color-dodge'),
			]),
		);
		expect(container.querySelector('[data-flat-compositor]')).not.toBeNull();
		rendered(container);
		expect(nestedCanvases(container)).toEqual([]);
	});
});

// ---------------------------------------------------------------- property: never nested

const GL_MODES: string[] = [...BLEND_MODES];
type TrackSpec =
	| { kind: 'solid'; mode: string; three: boolean }
	| { kind: 'adjustment'; effects: string[] }
	| { kind: 'text' | 'shape'; fx: boolean; mode: string }
	/** Two DOM or media clips meeting at frame 30 with a GPU transition (Push) between them. */
	| { kind: 'transition'; dom: boolean }
	/** A solid keyed by a Track Matte Key reading the track below it. */
	| { kind: 'matte' };

const trackSpec: fc.Arbitrary<TrackSpec> = fc.oneof(
	fc.record({ kind: fc.constant('solid' as const), mode: fc.constantFrom(...GL_MODES), three: fc.boolean() }),
	fc.record({
		kind: fc.constant('adjustment' as const),
		effects: fc.subarray(['jasper.invert', 'jasper.black-white', 'jasper.gaussian-blur']),
	}),
	fc.record({
		kind: fc.constantFrom('text' as const, 'shape' as const),
		fx: fc.boolean(),
		mode: fc.constantFrom('normal', 'multiply', 'linear-burn'),
	}),
	fc.record({ kind: fc.constant('transition' as const), dom: fc.boolean() }),
	fc.record({ kind: fc.constant('matte' as const) }),
);

function commandsOf(
	tracks: TrackSpec[],
	prefix: string,
	sequenceId?: string,
	trackIds?: readonly string[],
): Command[] {
	const out: Command[] = [];
	const seq = sequenceId ? { sequenceId } : {};
	tracks.forEach((t, i) => {
		const track = `V${i + 1}`;
		const ref = `$${prefix}${i}`;
		if (t.kind === 'transition' || t.kind === 'matte') {
			// Top-level tracks only (transitions and Track Matte Keys name the sequence's own tracks).
			if (sequenceId || !trackIds) {
				out.push({ ...solid(track, ref), ...seq } as Command);
				return;
			}
			if (t.kind === 'matte') {
				out.push(solid(track, ref));
				if (i > 0)
					out.push({
						type: 'effect.add',
						target: { clipId: ref },
						effectId: 'jasper.track-matte-key',
						params: { matteTrack: trackIds[i - 1] },
					} as Command);
				return;
			}
			const side = (at: number, r: string): Command =>
				t.dom
					? ({
							type: 'clip.addShape',
							at,
							duration: 30,
							track,
							shape: { type: 'rect', size: [320, 180], fill: [1, 1, 1, 1] },
							ref: r,
						} as Command)
					: ({ type: 'clip.addSolid', at, duration: 30, track, color: [1, 0, 0, 1], ref: r } as Command);
			out.push(side(0, ref), side(30, `${ref}b`), {
				type: 'transition.add',
				trackId: track,
				at: 30,
				effectId: 'jasper.push',
				duration: 10,
			} as Command);
			return;
		}
		if (t.kind === 'solid') {
			out.push({ ...solid(track, ref), ...seq } as Command, mode(ref, t.mode));
			if (t.three) out.push(threeD(ref));
		} else if (t.kind === 'adjustment') {
			out.push({ ...adjustment(track, ref), ...seq } as Command, ...t.effects.map((e) => effect(ref, e)));
		} else {
			out.push(
				t.kind === 'text'
					? ({ ...text(track, ref), ...seq } as Command)
					: ({
							type: 'clip.addShape',
							at: 0,
							duration: 30,
							track,
							shape: { type: 'rect', size: [100, 60], fill: [1, 1, 1, 1] },
							ref,
							...seq,
						} as Command),
				mode(ref, t.mode),
			);
			if (t.fx) out.push(effect(ref, 'jasper.invert'));
		}
	});
	return out;
}

describe('no HTML-in-Canvas canvas is ever nested (property)', () => {
	it('random stacks of blend modes, adjustment layers, DOM layers with effects, 3D, linear light and nests', () => {
		fc.assert(
			fc.property(
				fc.array(trackSpec, { minLength: 1, maxLength: 5 }),
				fc.boolean(),
				fc.option(
					fc.record({
						inner: fc.array(trackSpec, { minLength: 1, maxLength: 3 }),
						fx: fc.boolean(),
					}),
					{ nil: null },
				),
				(tracks, lin, nest) => {
					const build = (p: ReturnType<typeof createEmptyProject>) => {
						const trackIds = Object.values(p.sequences)[0]!.videoTracks.map((x) => x.id);
						const cmds: Command[] = lin ? [linear] : [];
						cmds.push(...commandsOf(tracks, 't', undefined, trackIds));
						if (nest) {
							cmds.push({
								type: 'sequence.create',
								name: 'N',
								preset: 'hd-720p-30',
								settings: { width: 320, height: 180 },
								tracks: { video: 4, audio: 1 },
								ref: '$seq',
							} as Command);
							cmds.push(...commandsOf(nest.inner, 'n', '$seq'));
							cmds.push({
								type: 'clip.place',
								source: { sequenceId: '$seq' },
								at: 0,
								tracks: { video: `V${tracks.length + 1}` },
								ref: '$nest',
							} as unknown as Command);
							if (nest.fx) cmds.push(effect('$nest', 'jasper.invert'));
						}
						return cmds;
					};
					const doc = makeDoc(build);
					// Frame 28: inside the transition spans (25…35) and every other clip (0…30).
					const { container, unmount } = renderFrame(doc, 28);
					try {
						rendered(container);
						expect(nestedCanvases(container)).toEqual([]);
						// The static decision was right: no scope had to ask for a flat stack at run time.
						expect(container.querySelector('[data-canvas-scope-flattening]')).toBeNull();
						expect(container.querySelector('[data-canvas-scope-nested]')).toBeNull();
					} finally {
						unmount();
					}
				},
			),
			{ numRuns: 150, seed: 20261008 },
		);
	}, 120_000);
});
