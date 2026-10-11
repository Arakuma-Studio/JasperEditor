// Layers with GPU shader effects in the composition (wave-1 fx framework), happy-dom with the GPU mocked: the padded
// output canvas, the chain the layer runs (shader + LUT passes reach the host, in stack order), the CSS stages left
// to LayerBox, and the visible bypass when the GPU or HTML-in-Canvas is missing. Real WebGL: fx-gl.test.ts; real
// renders: fx-render.e2e.test.ts.
import {
	applyTransaction,
	buildRenderSnapshot,
	type Command,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	type EffectParams,
	type FxEffectPlan,
	type Lut,
	type RenderSnapshot,
} from '@jasper/project';
import { Thumbnail } from '@remotion/player';
import { render, waitFor } from '@testing-library/react';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FxHost } from '../src/fx/host.ts';
import { setFxEffectRegistry } from '../src/fx/registry.ts';
import { fxStatus } from '../src/fx/status.ts';
import { DEFAULT_RENDER_OPTIONS, SequenceComposition } from '../src/index.ts';
import { testFxRegistry } from './fx-examples.ts';

const gpu = vi.hoisted(() => ({
	webgl: true,
	runs: [] as { kind: string; id: string; canvas?: FxEffectPlan['canvas'] }[],
}));

vi.mock('../src/color/gl.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('../src/color/gl.ts')>()),
	canUseWebGl2: () => gpu.webgl,
	colorStageBackend: () => 'webgl',
}));
vi.mock('../src/fx/host.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('../src/fx/host.ts')>()),
	fxHost: () => ({}),
	runShaderPlan: (_h: FxHost, plan: FxEffectPlan) =>
		gpu.runs.push({ kind: 'gpu', id: plan.effectId, canvas: plan.canvas }),
	runLutPass: (_h: FxHost, _lut: Lut, key: string) => gpu.runs.push({ kind: 'lut', id: key }),
}));

/** happy-dom has no canvas rendering: a no-op 2D context so Remotion's chain and FxPicture can run. */
function fake2d(canvas: HTMLCanvasElement) {
	const noop = () => {};
	return {
		canvas,
		clearRect: noop,
		drawImage: noop,
		fillRect: noop,
		save: noop,
		restore: noop,
		beginPath: noop,
		rect: noop,
		clip: noop,
		translate: noop,
		scale: noop,
		getImageData: (_x: number, _y: number, w: number, h: number) => ({
			data: new Uint8ClampedArray(w * h * 4),
		}),
		putImageData: noop,
		globalCompositeOperation: 'source-over',
		filter: 'none',
		fillStyle: '#000',
	};
}
const originalGetContext = HTMLCanvasElement.prototype.getContext;
beforeAll(() => {
	HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string) {
		return type === '2d' ? fake2d(this) : null;
	} as never;
	setFxEffectRegistry(testFxRegistry);
});
afterAll(() => {
	HTMLCanvasElement.prototype.getContext = originalGetContext;
	setFxEffectRegistry(null);
});
beforeEach(() => {
	gpu.webgl = true;
	gpu.runs.length = 0;
	fxStatus.reset();
});

function makeDoc(commands: Command[]): RenderSnapshot {
	const ids = createCounterIdSource(1);
	const base = createEmptyProject({ ids, name: 'F', preset: 'hd-1080p-25' });
	const { document, result } = applyTransaction(
		base,
		{ label: 'setup', origin: 'user', commands },
		{ ids, now: () => 't', revision: 0, registries: { ...defaultRegistries(), effects: testFxRegistry } },
	);
	if (!result.ok) throw new Error(JSON.stringify(result.errors));
	return buildRenderSnapshot(document, Object.keys(document.sequences)[0]!, {
		resolveMedia: () => null,
		resolveFont: () => null,
	});
}

const solid = (effects: Command[]): Command[] => [
	{ type: 'clip.addSolid', at: 0, duration: 50, track: 'V1', color: [0, 0.5, 1, 1], ref: '$s' },
	...effects,
];
const add = (effectId: string, params?: EffectParams): Command => ({
	type: 'effect.add',
	target: { clipId: '$s' },
	effectId,
	...(params ? { params } : {}),
});

function renderFrame(doc: RenderSnapshot, frame = 3) {
	return render(
		<Thumbnail
			component={SequenceComposition}
			inputProps={{ doc, options: DEFAULT_RENDER_OPTIONS }}
			compositionWidth={doc.settings.width}
			compositionHeight={doc.settings.height}
			durationInFrames={Math.max(1, doc.durationFrames)}
			fps={doc.settings.fps.num / doc.settings.fps.den}
			frameToDisplay={frame}
		/>,
	);
}

describe('GPU shader effects on layers (GPU mocked)', () => {
	it('draws a solid through the chain on a canvas grown by the padding (S03:FX-041)', async () => {
		const doc = makeDoc(solid([add('test.drop-shadow', { distance: 10, softness: 0 })]));
		const { container } = renderFrame(doc);
		const out = container.querySelector('canvas[data-fx-output]') as HTMLCanvasElement | null;
		expect(out).not.toBeNull();
		expect(out!.style.left).toBe('-10px');
		expect(out!.style.top).toBe('-10px');
		expect(out!.style.width).toBe('1940px');
		expect([out!.width, out!.height]).toEqual([1940, 1100]);
		await waitFor(() => expect(gpu.runs.some((r) => r.id === 'test.drop-shadow')).toBe(true));
		expect(gpu.runs.find((r) => r.id === 'test.drop-shadow')!.canvas).toEqual({ width: 1940, height: 1100 });
		expect(container.querySelector('[data-grade-chip]')).toBeNull();
	});

	it('keeps stack order: colour run and shader in the chain, a trailing SVG effect as a CSS stage', async () => {
		const doc = makeDoc(
			solid([
				add('jasper.hue-saturation', { hue: 40 }),
				add('test.s.gradient', { opacity: 50 }),
				add('jasper.gaussian-blur', { radius: 3, dimensions: 'horizontal' }),
			]),
		);
		const { container } = renderFrame(doc);
		await waitFor(() => expect(gpu.runs.map((r) => r.kind)).toEqual(['lut', 'gpu']));
		expect(container.querySelector('[data-effect="jasper.gaussian-blur"]')).not.toBeNull();
		expect(container.querySelector('[data-effect="jasper.hue-saturation"]')).toBeNull();
	});

	it('without WebGL2 the preview bypasses shader effects visibly (chip), never silently', () => {
		gpu.webgl = false;
		const doc = makeDoc(solid([add('test.s.glow')]));
		const { container } = renderFrame(doc);
		expect(container.querySelector('canvas[data-fx-output]')).toBeNull();
		expect(container.querySelector('[data-grade-chip]')!.textContent).toBe(
			'GPU effects unavailable (no WebGL2)',
		);
	});

	it('a DOM layer without HTML-in-Canvas shows a chip instead of a wrong picture', () => {
		const doc = makeDoc([
			{
				type: 'clip.addShape',
				at: 0,
				duration: 50,
				track: 'V1',
				shape: { type: 'rect', size: [200, 100] },
				ref: '$s',
			} as Command,
			add('test.drop-shadow'),
		]);
		const { container } = renderFrame(doc);
		expect(container.querySelector('[data-shape]')).not.toBeNull(); // still drawn, effects bypassed
		expect(container.querySelector('[data-grade-chip]')!.textContent).toMatch(/HTML-in-Canvas/);
	});

	it('a shader that fails to compile is bypassed alone with a chip (preview)', async () => {
		fxStatus.shaderFailed('test.s.glow', 'FX_SHADER_ERROR: test.s.glow pass 0: boom');
		const doc = makeDoc(solid([add('test.s.glow'), add('test.s.gradient')]));
		const { container } = renderFrame(doc);
		await waitFor(() => expect(gpu.runs.map((r) => r.id)).toEqual(['test.s.gradient']));
		expect(container.querySelector('[data-grade-chip]')!.textContent).toBe('Effect failed: test.s.glow');
	});
});
