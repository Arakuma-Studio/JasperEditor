// Frequent updates can starve Suspense retries because their render lane never expires.
// State-based loading must still mount slow panels while other updates arrive.
import { act, cleanup, getConfig, render, screen } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadable, useLoaded } from '../src/panels/lazy.ts';
import type { PanelProps } from '../src/panels/types.ts';

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

let renderTime = 0;
let mounted = () => {};
function Slow() {
	renderTime += 3;
	return <i />;
}
/** Sixty units of work consume virtual scheduler time, so React yields without spinning the CPU. */
function Heavy(_props: Partial<PanelProps>) {
	useEffect(() => mounted(), []);
	return (
		<div data-testid="content">
			{Array.from({ length: 60 }, (_, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: a fixed list
				<Slow key={i} />
			))}
		</div>
	);
}
/** Job progress arrives between scheduler tasks until the panel commits. */
function Ticker({ update }: { update(): void }) {
	const [n, setN] = useState(0);
	useEffect(() => {
		let task: ReturnType<typeof setImmediate>;
		const tick = () => {
			setN((x) => x + 1);
			update();
			task = setImmediate(tick);
		};
		task = setImmediate(tick);
		return () => clearImmediate(task);
	}, [update]);
	return <span data-n={n} />;
}

describe('panel loading under frequent updates', () => {
	it('a panel loaded through state appears although updates keep arriving', async () => {
		renderTime = performance.now();
		vi.spyOn(performance, 'now').mockImplementation(() => renderTime);
		let updates = 0;
		let updateLimit!: () => void;
		const pressure = new Promise<void>((r) => {
			updateLimit = r;
		});
		const committed = new Promise<void>((r) => {
			mounted = r;
		});
		const update = () => {
			if (++updates === 120) updateLimit();
		};
		let resolve!: (c: typeof Heavy) => void;
		const source = loadable<Partial<PanelProps>>(() => new Promise((r) => (resolve = r)));
		function Panel() {
			const state = useLoaded(source);
			if (state.status !== 'ready') return <b data-testid="fallback" />;
			return <state.Component />;
		}
		render(
			<div>
				<Ticker update={update} />
				<Panel />
			</div>,
		);
		expect(screen.queryByTestId('fallback')).not.toBeNull();
		resolve(Heavy);
		// Keep this outside React's act wrapper: forcing a synchronous render would hide scheduler starvation.
		await getConfig().asyncWrapper(() => Promise.race([committed, pressure]));
		expect(screen.queryByTestId('content')).not.toBeNull();
		expect(updates).toBeGreaterThan(0);
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
		void b.catch(() => undefined);
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
		await act(async () => {
			await failing.load().catch(() => undefined);
		});
		expect(screen.getByTestId('state').textContent).toBe('failed: offline');
		const ready = loadable<object>(async () => Heavy);
		await ready.load();
		view.rerender(<Probe source={ready} />);
		expect(screen.getByTestId('state').textContent).toBe('ready');
	});
});
