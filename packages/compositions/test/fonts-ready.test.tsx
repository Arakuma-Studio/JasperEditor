// S11:FIX-003 — per-face font readiness: a text layer whose face is still loading is not mounted (it never splits,
// measures or paints with the fallback font; the Player shows nothing), renders are held by one delayRender handle
// created in a layout effect (StrictMode-safe, released on unmount) and released once the layer has mounted.
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
	FontsReadyContext,
	type FontsReadyState,
	layerFontFaces,
	type RenderDoc,
	SequenceComposition,
	useFontsReady,
	useFontsReadyState,
} from '../src/index.ts';

type Deferred = { resolve(): void; reject(e: Error): void; family: string; weight: string };

/** A FontFace whose load() resolves only when the test says so. */
let pending: Deferred[] = [];
class DeferredFontFace {
	family: string;
	weight: string;
	constructor(family: string, _src: string, desc: { weight: string; style: string }) {
		this.family = family;
		this.weight = desc.weight;
	}
	load() {
		return new Promise<this>((resolve, reject) => {
			pending.push({
				resolve: () => resolve(this),
				reject,
				family: this.family,
				weight: this.weight,
			});
		});
	}
}
const added: unknown[] = [];

beforeEach(() => {
	pending = [];
	vi.stubGlobal('FontFace', DeferredFontFace);
	Object.defineProperty(document, 'fonts', {
		configurable: true,
		value: { add: (f: unknown) => added.push(f) },
	});
});
afterEach(() => vi.unstubAllGlobals());

const handles = () =>
	(window as unknown as { remotion_delayRenderHandles: number[] }).remotion_delayRenderHandles;
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
		expect(doc.fonts).toHaveLength(1);
		const r = renderFrame(doc, 5);
		await settle();
		expect(pending.map((p) => p.family)).toEqual(['Slow Sans A']);
		// nothing of the layer exists: not hidden-but-measuring, simply not mounted
		expect(r.container.querySelector('[data-kind="text"]')).toBeNull();
		expect(r.container.textContent).not.toContain('Fonts first');
		await act(async () => pending[0]!.resolve());
		await waitFor(() => expect(r.container.querySelector('[data-text-block]')).not.toBeNull());
		const block = r.container.querySelector<HTMLElement>('[data-text-block]')!;
		expect(block.textContent).toBe('Fonts first');
		expect(block.style.fontFamily).toMatch(/^"Slow Sans A"/);
		expect(added).toHaveLength(1);
		r.unmount();
	});

	it('a face that fails to load counts as settled: the text renders with the fallback stack', async () => {
		const r = renderFrame(textDoc('Broken Sans'), 5);
		await settle();
		expect(r.container.querySelector('[data-text-block]')).toBeNull();
		await act(async () => pending[0]!.reject(new Error('404')));
		await waitFor(() => expect(r.container.querySelector('[data-text-block]')).not.toBeNull());
		r.unmount();
	});

	it('faces already loaded on the page never hide the layer again (no blink on a new document)', async () => {
		const doc = textDoc('Cached Sans');
		const r = renderFrame(doc, 5);
		await settle();
		await act(async () => pending[0]!.resolve());
		await waitFor(() => expect(r.container.querySelector('[data-text-block]')).not.toBeNull());
		r.unmount();
		// same faces, new document identity: mounted in the very first render
		const again = renderFrame({ ...doc, fonts: doc.fonts.map((f) => ({ ...f })) }, 6);
		expect(again.container.querySelector('[data-text-block]')).not.toBeNull();
		again.unmount();
	});
});

describe('useFontsReadyState: per-face readiness and the delayRender handle', () => {
	const face = (family: string, weight: number, n: number) => ({
		fontId: `fnt_${family}`,
		family,
		weight,
		style: 'normal' as const,
		url: `/fonts/${family}-${weight}-${n}.woff2`,
	});

	it('tracks family / weight / style separately and holds one handle until every face settled', async () => {
		const n = ++unique;
		const fonts = [face('Duo', 400, n), face('Duo', 700, n)];
		const before = handles().length;
		const h = renderHook(() => useFontsReadyState(fonts), {
			wrapper: ({ children }) => <StrictMode>{children}</StrictMode>,
		});
		await settle();
		// StrictMode ran the layout effect twice: the first handle was released by its cleanup
		expect(handles().length).toBe(before + 1);
		expect(h.result.current.allLoaded).toBe(false);
		const regular = pending.find((p) => p.weight === '400')!;
		await act(async () => regular.resolve());
		const s = h.result.current;
		expect(s.isLoaded!('Duo', 400)).toBe(true);
		expect(s.isLoaded!('Duo', 700)).toBe(false);
		expect(s.isLoaded!('Duo')).toBe(false);
		expect(s.isLoaded!('Duo', 400, 'italic')).toBe(true); // no such face: nothing to wait for
		expect(s.isLoaded!('Other')).toBe(true);
		expect(s.allLoaded).toBe(false);
		expect(handles().length).toBe(before + 1);
		for (const p of pending.filter((x) => x.weight === '700')) await act(async () => p.resolve());
		await waitFor(() => expect(h.result.current.allLoaded).toBe(true));
		expect(handles().length).toBe(before);
		h.unmount();
	});

	it('unmounting while faces load releases the handle (no stuck render)', async () => {
		const before = handles().length;
		const h = renderHook(() => useFontsReadyState([face('Gone', 400, ++unique)]));
		await settle();
		expect(handles().length).toBe(before + 1);
		h.unmount();
		expect(handles().length).toBe(before);
	});

	it('useFontsReady accepts family names and face queries', () => {
		const state: FontsReadyState = {
			allLoaded: false,
			isLoaded: (family, weight) => family === 'A' && weight !== 700,
		};
		const wrapper = ({ children }: { children: React.ReactNode }) => (
			<FontsReadyContext.Provider value={state}>{children}</FontsReadyContext.Provider>
		);
		const ready = (faces: Parameters<typeof useFontsReady>[0]) =>
			renderHook(() => useFontsReady(faces), { wrapper }).result.current;
		expect(ready(['A', { family: 'A', weight: 400 }])).toBe(true);
		expect(ready([{ family: 'A', weight: 700 }])).toBe(false);
		expect(ready(['B'])).toBe(false);
	});
});

describe('layerFontFaces', () => {
	const fonts = [
		{ fontId: 'fnt_a', family: 'Alpha', weight: 400, style: 'normal' as const, url: '/a.woff2' },
		{ fontId: 'fnt_a', family: 'Alpha', weight: 700, style: 'italic' as const, url: '/ab.woff2' },
		{ fontId: 'fnt_b', family: 'Beta', weight: 400, style: 'normal' as const, url: '/b.woff2' },
	];
	it('text: the face of the style and of each styled run (as TextLayer resolves it)', () => {
		const clip = {
			source: {
				text: {
					text: 'ab',
					style: { fontId: 'fnt_a', weight: 400, italic: false },
					runs: [{ from: 1, to: 2, style: { weight: 700, italic: true } }],
				},
				box: { width: 1, height: 1, autoSize: 'none' },
			},
		} as never;
		expect(layerFontFaces(clip, fonts)).toEqual([
			{ family: 'Alpha', weight: 400, style: 'normal' },
			{ family: 'Alpha', weight: 700, style: 'italic' },
		]);
		const missing = {
			source: { text: { text: 'x', style: { fontId: 'fnt_x', weight: 400, italic: false } }, box: {} },
		} as never;
		expect(layerFontFaces(missing, fonts)).toEqual([]);
	});
	it('anime templates: the document fonts their params name; other layers: none', () => {
		const mg = (params: unknown, renderer?: 'anime') =>
			({ source: { mg: { template: { id: 't', version: 1 }, params, canvas: {}, renderer } } }) as never;
		expect(layerFontFaces(mg({ title: { fontId: 'fnt_b' } }, 'anime'), fonts)).toEqual([
			{ family: 'Beta', weight: 400, style: 'normal' },
		]);
		expect(layerFontFaces(mg({ font: 'Beta' }), fonts)).toEqual([]);
		expect(layerFontFaces({ source: { color: [0, 0, 0, 1] } } as never, fonts)).toEqual([]);
	});
});
