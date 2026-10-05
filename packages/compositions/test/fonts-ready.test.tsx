// S11:FIX-003 — font readiness: a text layer whose face is still loading is not mounted (it never splits,
// measures or paints with the fallback font; the Player shows nothing).
import {
	applyTransaction,
	buildRenderSnapshot,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	type RenderSnapshot,
} from '@jasper/project';
import { Thumbnail } from '@remotion/player';
import { act, render, renderHook, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	DEFAULT_RENDER_OPTIONS,
	type RenderDoc,
	SequenceComposition,
	useFontsReadyState,
} from '../src/index.ts';

type Deferred = { resolve(): void; reject(e: Error): void; weight: string };

/** A FontFace whose load() resolves only when the test says so. */
let pending: Deferred[] = [];
class DeferredFontFace {
	weight: string;
	constructor(_family: string, _src: string, desc: { weight: string }) {
		this.weight = desc.weight;
	}
	load() {
		return new Promise<this>((resolve, reject) => {
			pending.push({
				resolve: () => resolve(this),
				reject,
				weight: this.weight,
			});
		});
	}
}

const originalFonts = Object.getOwnPropertyDescriptor(document, 'fonts');

beforeEach(() => {
	pending = [];
	vi.stubGlobal('FontFace', DeferredFontFace);
	Object.defineProperty(document, 'fonts', {
		configurable: true,
		value: { add: () => {} },
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
	if (originalFonts) Object.defineProperty(document, 'fonts', originalFonts);
	else Reflect.deleteProperty(document, 'fonts');
});

let unique = 0;

/** A one-text-clip document whose (only) face is `family` at `url`. */
function textDoc(family: string): RenderDoc {
	const ids = createCounterIdSource(1);
	const base = createEmptyProject({ ids, name: 'F', preset: 'hd-1080p-30' });
	const { document, result } = applyTransaction(
		base,
		{
			label: 'setup',
			origin: 'user',
			commands: [
				{ type: 'clip.addText', at: 0, duration: 60, track: 'V1', content: { text: 'Fonts first' } },
			],
		},
		{ ids, now: () => 't', revision: 0, registries: defaultRegistries() },
	);
	expect(result.ok).toBe(true);
	const seq = Object.values(document.sequences)[0]!;
	const snap: RenderSnapshot = buildRenderSnapshot(document, seq.id, {
		resolveMedia: () => null,
		resolveFont: () => `/fonts/${family.replace(/\W/g, '-')}-${++unique}.woff2`,
	});
	return { ...snap, fonts: snap.fonts.map((f) => ({ ...f, family })) };
}

function renderFrame(doc: RenderDoc, frame: number) {
	return render(
		<Thumbnail
			component={SequenceComposition}
			inputProps={{ doc, options: DEFAULT_RENDER_OPTIONS }}
			compositionWidth={doc.settings.width}
			compositionHeight={doc.settings.height}
			durationInFrames={Math.max(1, doc.durationFrames)}
			fps={30}
			frameToDisplay={frame}
		/>,
	);
}

const settle = () => act(async () => await Promise.resolve());

describe('font-dependent layers wait for their faces (S11:FIX-003)', () => {
	it('a text layer is not mounted (no fallback-font paint, no measuring) until its face loads', async () => {
		const doc = textDoc('Slow Sans A');
		const r = renderFrame(doc, 5);
		await settle();
		expect(r.container.textContent).not.toContain('Fonts first');
		await act(async () => pending[0]!.resolve());
		await waitFor(() => expect(r.container.textContent).toContain('Fonts first'));
		r.unmount();
	});

	it('a face that fails to load counts as settled: the text renders with the fallback stack', async () => {
		const r = renderFrame(textDoc('Broken Sans'), 5);
		await settle();
		expect(r.container.textContent).not.toContain('Fonts first');
		await act(async () => pending[0]!.reject(new Error('404')));
		await waitFor(() => expect(r.container.textContent).toContain('Fonts first'));
		r.unmount();
	});

	it('faces already loaded on the page never hide the layer again (no blink on a new document)', async () => {
		const doc = textDoc('Cached Sans');
		const r = renderFrame(doc, 5);
		await settle();
		await act(async () => pending[0]!.resolve());
		await waitFor(() => expect(r.container.textContent).toContain('Fonts first'));
		r.unmount();
		// same faces, new document identity: mounted in the very first render
		const again = renderFrame({ ...doc, fonts: doc.fonts.map((f) => ({ ...f })) }, 6);
		expect(again.container.textContent).toContain('Fonts first');
		again.unmount();
	});
});

describe('font readiness across loading faces and unmounts', () => {
	const face = (weight: number, id: number) => ({
		fontId: 'fnt_lifecycle',
		family: 'Lifecycle Sans',
		weight,
		style: 'normal' as const,
		url: `/fonts/lifecycle-${weight}-${id}.woff2`,
	});
	const handles = () =>
		(window as unknown as { remotion_delayRenderHandles: number[] }).remotion_delayRenderHandles;

	it('keeps a pending weight unready after another weight of the same family loads', async () => {
		const fonts = [face(400, ++unique), face(700, ++unique)];
		const before = handles().length;
		const view = renderHook(() => useFontsReadyState(fonts), {
			wrapper: ({ children }) => <StrictMode>{children}</StrictMode>,
		});
		await settle();
		await act(async () => pending.find((entry) => entry.weight === '400')!.resolve());
		expect(view.result.current.isLoaded!('Lifecycle Sans', 400)).toBe(true);
		expect(view.result.current.isLoaded!('Lifecycle Sans', 700)).toBe(false);
		expect(view.result.current.allLoaded).toBe(false);
		expect(handles().length).toBe(before + 1);
		await act(async () => pending.find((entry) => entry.weight === '700')!.resolve());
		await waitFor(() => expect(view.result.current.allLoaded).toBe(true));
		expect(handles().length).toBe(before);
		view.unmount();
	});

	it('releases the render hold when unmounted before its font loads', async () => {
		const fonts = [face(400, ++unique)];
		const before = handles().length;
		const view = renderHook(() => useFontsReadyState(fonts), {
			wrapper: ({ children }) => <StrictMode>{children}</StrictMode>,
		});
		await settle();
		expect(handles().length).toBe(before + 1);
		view.unmount();
		expect(handles().length).toBe(before);
		await act(async () => pending[0]!.resolve());
		expect(handles().length).toBe(before);
	});
});
