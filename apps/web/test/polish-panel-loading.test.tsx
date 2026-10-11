// Frequent updates can starve Suspense retries because their render lane never expires.
// State-based loading must still mount slow panels while other updates arrive.
import { cleanup, render, screen } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { isLoadable, lazyPanel, loadable, useLoaded } from '../src/panels/lazy.ts';
import type { PanelProps } from '../src/panels/types.ts';

afterEach(() => cleanup());

function busy(ms: number) {
	const t = performance.now();
	while (performance.now() - t < ms) {}
}
function Slow() {
	busy(3);
	return <i />;
}
/** ≈ 180 ms of rendering in 60 units React can yield between. */
function Heavy(_props: Partial<PanelProps>) {
	return (
		<div data-testid="content">
			{Array.from({ length: 60 }, (_, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: a fixed list
				<Slow key={i} />
			))}
		</div>
	);
}
/** Another part of the app that updates every 4 ms (job progress, meters…). */
function Ticker() {
	const [n, setN] = useState(0);
	useEffect(() => {
		const id = setInterval(() => setN((x) => x + 1), 4);
		return () => clearInterval(id);
	}, []);
	return <span data-n={n} />;
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('panel loading under frequent updates', () => {
	it('a panel loaded through state appears although updates keep arriving', async () => {
		let resolve!: (c: typeof Heavy) => void;
		const source = loadable<Partial<PanelProps>>(() => new Promise((r) => (resolve = r)));
		function Panel() {
			const state = useLoaded(source);
			if (state.status !== 'ready') return <b data-testid="fallback" />;
			return <state.Component />;
		}
		render(
			<div>
				<Ticker />
				<Panel />
			</div>,
		);
		expect(screen.queryByTestId('fallback')).not.toBeNull();
		resolve(Heavy);
		await wait(1200);
		expect(screen.queryByTestId('content')).not.toBeNull();
		expect(screen.queryByTestId('fallback')).toBeNull();
	});
});

describe('loadable', () => {
	it('shares one download, remembers the component, and asks again after a failure', async () => {
		let calls = 0;
		let fail = true;
		const source = loadable<object>(async () => {
			calls++;
			if (fail) throw new Error('offline');
			return Heavy;
		});
		expect(source.loaded()).toBeNull();
		const a = source.load();
		const b = source.load();
		expect(a).toBe(b);
		await expect(a).rejects.toThrow('offline');
		expect(calls).toBe(1);
		fail = false;
		expect(await source.load()).toBe(Heavy);
		expect(calls).toBe(2);
		expect(source.loaded()).toBe(Heavy);
		await source.load();
		expect(calls).toBe(2);
	});

	it('useLoaded reports a failed download and renders at once what is already loaded', async () => {
		const failing = loadable<object>(async () => {
			throw new Error('offline');
		});
		function Probe(props: { source: typeof failing }) {
			const s = useLoaded(props.source);
			return (
				<span data-testid="state">
					{s.status === 'failed' ? `failed: ${(s.error as Error).message}` : s.status}
				</span>
			);
		}
		const view = render(<Probe source={failing} />);
		expect(screen.getByTestId('state').textContent).toBe('loading');
		await wait(20);
		expect(screen.getByTestId('state').textContent).toBe('failed: offline');
		const ready = loadable<object>(async () => Heavy);
		await ready.load();
		view.rerender(<Probe source={ready} />);
		await wait(20);
		expect(screen.getByTestId('state').textContent).toBe('ready');
	});

	it('every panel of the registry is loadable (the dock mounts them through state)', async () => {
		const { listPanels } = await import('../src/panels/registry.ts');
		for (const def of listPanels()) expect(isLoadable(def.component), def.kind).toBe(true);
		const p = lazyPanel(async () => ({ Missing: undefined as never }), 'Missing');
		await expect(p.load()).rejects.toThrow(/no export/);
	});
});
