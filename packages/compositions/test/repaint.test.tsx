// S11:ANM-014 — frame repaint (repaint.tsx) and render host (render-host.ts). Chrome repaints a reused page
// incrementally (partial raster), so before FrameRepaint the same frame of the same DOM came out with different
// anti-aliasing depending on the frames painted before (renderFrames vs renderStill, reversed/shuffled visits, Player
// revisits). The pixel proof is the REMOTION_E2E parity suite (packages/motion/test/determinism-render.e2e.test.ts);
// here: the repaint takes the composition root's layout down and back within the same task (forced layout with
// `display: none`), restores its inline display exactly, runs on every frame of a render and of a paused Player,
// never during playback, and after the layers' layout effects; the render host opens pages in their own windows.
import {
	applyTransaction,
	buildRenderSnapshot,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	type RenderSnapshot,
} from '@jasper/project';
import { Thumbnail } from '@remotion/player';
import { render } from '@testing-library/react';
import { type ReactNode, useLayoutEffect, useRef } from 'react';
import { Internals, useRemotionEnvironment } from 'remotion';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	DEFAULT_RENDER_OPTIONS,
	FrameRepaint,
	renderPagesInOwnWindows,
	repaintFromScratch,
	SequenceComposition,
	wantsFullRepaint,
} from '../src/index.ts';

/** Records the inline display of every element whose layout is forced (offsetHeight) while the spy is on. */
function forcedLayouts() {
	const seen: { el: HTMLElement; display: string }[] = [];
	const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')!;
	vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
		seen.push({ el: this, display: this.style.getPropertyValue('display') });
		return original.get!.call(this) as number;
	});
	return seen;
}
afterEach(() => vi.restoreAllMocks());

describe('repaintFromScratch', () => {
	for (const [label, set] of [
		['no inline display', () => {}],
		['display: flex', (el: HTMLElement) => el.style.setProperty('display', 'flex')],
		['display: grid !important', (el: HTMLElement) => el.style.setProperty('display', 'grid', 'important')],
	] as const)
		it(`forces a layout with display: none, then restores the inline display exactly (${label})`, () => {
			const el = document.createElement('div');
			document.body.append(el);
			set(el);
			const before = el.getAttribute('style');
			const seen = forcedLayouts();
			repaintFromScratch(el);
			expect(seen.filter((s) => s.el === el).map((s) => s.display)).toEqual(['none']);
			expect(el.getAttribute('style')).toBe(before);
			el.remove();
		});
});

describe('wantsFullRepaint', () => {
	it('every rendered frame; in the Player only while paused', () => {
		expect(wantsFullRepaint({ rendering: true, playing: false })).toBe(true);
		expect(wantsFullRepaint({ rendering: true, playing: true })).toBe(true);
		expect(wantsFullRepaint({ rendering: false, playing: false })).toBe(true);
		expect(wantsFullRepaint({ rendering: false, playing: true })).toBe(false);
	});
});

/** A render (`@remotion/renderer`) or the Player, playing or paused, around `children`. */
function InEnv({
	rendering,
	playing,
	children,
}: {
	rendering: boolean;
	playing: boolean;
	children: ReactNode;
}) {
	const env = useRemotionEnvironment();
	const timeline = Internals.useTimelineContext();
	return (
		<Internals.RemotionEnvironmentContext.Provider
			value={{ ...env, isRendering: rendering, isPlayer: !rendering }}
		>
			<Internals.TimelineContext.Provider value={{ ...timeline, playing }}>
				{children}
			</Internals.TimelineContext.Provider>
		</Internals.RemotionEnvironmentContext.Provider>
	);
}

describe('FrameRepaint', () => {
	type Mode = 'render' | 'paused' | 'playing';
	/** A layer with a layout effect (like text measurement), logged to check the order. */
	function Layer({ log }: { log: string[] }) {
		useLayoutEffect(() => {
			log.push('layer');
		});
		return <span>layer</span>;
	}
	function Probe({ mode, log }: { mode: Mode; log: string[] }) {
		const root = useRef<HTMLDivElement>(null);
		const body = (
			<div ref={root} data-probe="" style={{ display: 'flex' }}>
				<Layer log={log} />
				<FrameRepaint target={root} />
			</div>
		);
		// A render ignores the playing state (set here to prove it).
		return (
			<InEnv rendering={mode === 'render'} playing={mode !== 'paused'}>
				{body}
			</InEnv>
		);
	}
	const thumb = (frame: number, mode: Mode, log: string[] = []) => (
		<Thumbnail
			component={Probe as never}
			inputProps={{ mode, log }}
			compositionWidth={320}
			compositionHeight={180}
			durationInFrames={30}
			fps={30}
			frameToDisplay={frame}
		/>
	);
	/** Counts the repaints of the probe root from now on. */
	function count() {
		const seen = forcedLayouts();
		return () => seen.filter((s) => s.el.hasAttribute('data-probe') && s.display === 'none').length;
	}

	for (const mode of ['render', 'paused'] as const)
		it(`${mode}: repaints once per frame change and keeps the root's inline display`, () => {
			const repaints = count();
			const r = render(thumb(3, mode));
			// A new subtree's first paint is from scratch anyway (and the root's ref is attached after this effect).
			expect(repaints()).toBe(0);
			r.rerender(thumb(4, mode));
			expect(repaints()).toBe(1);
			r.rerender(thumb(4, mode));
			expect(repaints()).toBe(1);
			r.rerender(thumb(0, mode));
			expect(repaints()).toBe(2);
			expect(r.container.querySelector<HTMLElement>('[data-probe]')!.getAttribute('style')).toBe(
				'display: flex;',
			);
		});

	it('runs after the layers’ layout effects of the same commit', () => {
		const log: string[] = [];
		const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')!.get!;
		vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
			if (this.hasAttribute('data-probe')) log.push(`repaint (display ${this.style.display})`);
			return original.call(this) as number;
		});
		const r = render(thumb(3, 'render', log));
		log.length = 0;
		r.rerender(thumb(9, 'render', log));
		expect(log).toEqual(['layer', 'repaint (display none)']);
	});

	it('never repaints during Player playback', () => {
		const repaints = count();
		const r = render(thumb(3, 'playing'));
		r.rerender(thumb(4, 'playing'));
		r.rerender(thumb(5, 'playing'));
		expect(repaints()).toBe(0);
		// …and repaints the frame playback stops on.
		r.rerender(thumb(5, 'paused'));
		expect(repaints()).toBe(1);
	});
});

describe('SequenceComposition', () => {
	function textDoc(): RenderSnapshot {
		const ids = createCounterIdSource(1);
		const base = createEmptyProject({ ids, name: 'R', preset: 'hd-1080p-30' });
		const { document, result } = applyTransaction(
			base,
			{
				label: 'setup',
				origin: 'user',
				commands: [
					{
						type: 'clip.addText',
						at: 0,
						duration: 60,
						track: 'V1',
						content: { text: 'Hello brave world' },
						textAnimation: { in: { preset: 'slide-up', params: { unit: 'word' } } },
					},
				],
			},
			{ ids, now: () => 't', revision: 0, registries: defaultRegistries() },
		);
		if (!result.ok) throw new Error(result.errors[0]!.message);
		return buildRenderSnapshot(document, Object.keys(document.sequences)[0]!, {
			resolveMedia: () => null,
			resolveFont: () => null,
		});
	}

	it('repaints its root on every frame and keeps the root’s display (AbsoluteFill: flex)', () => {
		const doc = textDoc();
		const thumb = (f: number) => (
			<Thumbnail
				component={SequenceComposition}
				inputProps={{ doc, options: DEFAULT_RENDER_OPTIONS }}
				compositionWidth={doc.settings.width}
				compositionHeight={doc.settings.height}
				durationInFrames={doc.durationFrames}
				fps={30}
				frameToDisplay={f}
			/>
		);
		const seen = forcedLayouts();
		const r = render(thumb(5));
		const root = r.container.querySelector<HTMLElement>('[data-track-id]')!.parentElement!;
		const rootRepaints = () => seen.filter((s) => s.el === root && s.display === 'none').length;
		expect(rootRepaints()).toBe(0);
		r.rerender(thumb(6));
		r.rerender(thumb(30));
		expect(rootRepaints()).toBe(2);
		expect(root.style.display).toBe('flex');
		// The animated title still rendered its measured units (the repaint runs after the layers' layout effects).
		r.rerender(thumb(7));
		expect(r.container.querySelector('[data-text-animating="in"]')).not.toBeNull();
	});
});

describe('renderPagesInOwnWindows', () => {
	it('opens every page of a Remotion browser in its own window, other CDP calls untouched', async () => {
		const calls: [string, unknown][] = [];
		const browser = {
			connection: {
				send: async (method: string, params?: unknown) => {
					calls.push([method, params]);
					return { value: {} };
				},
			},
		};
		expect(renderPagesInOwnWindows(browser)).toBe(true);
		expect(renderPagesInOwnWindows(browser)).toBe(true);
		await browser.connection.send('Target.createTarget', { url: 'about:blank', browserContextId: undefined });
		await browser.connection.send('Target.activateTarget', { targetId: 't1' });
		expect(calls).toEqual([
			['Target.createTarget', { url: 'about:blank', browserContextId: undefined, newWindow: true }],
			['Target.activateTarget', { targetId: 't1' }],
		]);
	});

	it('changes nothing without the CDP connection it relies on', () => {
		expect(renderPagesInOwnWindows({})).toBe(false);
		expect(renderPagesInOwnWindows(null)).toBe(false);
	});
});
