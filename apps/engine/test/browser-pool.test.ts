// Warm render browsers (remotion/browser-pool.ts, wp-note export-performance §16): reuse by launch options, relaunch
// after a crash, a bounded idle set and lifetime, a hung reset, and nothing left open after stop.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserPool, type BrowserSpec } from '../src/remotion/browser-pool.ts';

type Fake = {
	id: number;
	key: string;
	alive: boolean;
	closed: boolean;
	pages: number;
	reset?: 'fail' | 'hang';
};

function setup(o: { maxIdle?: number; idleMs?: number; maxUses?: number } = {}) {
	const launched: Fake[] = [];
	const warmed: number[] = [];
	const pool = new BrowserPool<Fake>({
		healthy: async (b) => b.alive,
		reset: (b) =>
			b.reset === 'hang'
				? new Promise<void>(() => undefined)
				: b.reset === 'fail'
					? Promise.reject(new Error('page close failed'))
					: Promise.resolve(void (b.pages = 0)),
		dispose: async (b) => {
			b.closed = true;
		},
		maxIdle: o.maxIdle ?? 2,
		idleMs: o.idleMs ?? 60_000,
		maxUses: o.maxUses ?? 10,
		resetMs: 1000,
	});
	const spec = (key = 'gl=default'): BrowserSpec<Fake> => ({
		key,
		launch: async () => {
			const b: Fake = { id: launched.length + 1, key, alive: true, closed: false, pages: 0 };
			launched.push(b);
			return b;
		},
		warm: async (b) => {
			warmed.push(b.id);
		},
	});
	return { pool, launched, warmed, spec };
}

afterEach(() => {
	vi.useRealTimers();
});

describe('render browser pool', () => {
	it('gives a returned browser to the next holder, blank and warmed once, instead of launching another', async () => {
		const { pool, launched, warmed, spec } = setup();
		const first = await pool.acquire(spec());
		first.instance.pages = 3;
		await first.close();
		await first.close(); // idempotent
		const second = await pool.acquire(spec());
		expect(second.instance).toBe(first.instance);
		expect(second.instance.pages).toBe(0);
		await second.close();
		expect(launched).toHaveLength(1);
		expect(warmed).toEqual([1]);
		expect(pool.stats).toMatchObject({ launched: 1, reused: 1 });
	});

	it('replaces an idle browser that crashed with a new launch and closes the dead one', async () => {
		const { pool, launched, spec } = setup();
		const a = await pool.acquire(spec());
		await a.close();
		launched[0]!.alive = false; // the process died while idle
		const b = await pool.acquire(spec());
		expect(b.instance).not.toBe(a.instance);
		expect(launched[0]!.closed).toBe(true);
		expect(launched).toHaveLength(2);
		await b.close();
	});

	it('hands a browser only to holders of its launch options', async () => {
		const { pool, launched, spec } = setup();
		const render = await pool.acquire(spec('gl=angle-egl'));
		await render.close();
		const page = await pool.acquire(spec('html'));
		expect(page.instance).not.toBe(render.instance);
		expect(page.instance.key).toBe('html');
		await page.close();
		// both stay warm for their own kind
		expect((await pool.acquire(spec('gl=angle-egl'))).instance).toBe(render.instance);
		expect(launched.every((x) => !x.closed)).toBe(true);
	});

	it('closes a browser whose reset fails or hangs, and one that served maxUses holders', async () => {
		vi.useFakeTimers();
		const { pool, launched, spec } = setup({ maxUses: 2 });
		const a = await pool.acquire(spec());
		a.instance.reset = 'fail';
		await a.close();
		expect(launched[0]!.closed).toBe(true);

		const h = await pool.acquire(spec());
		h.instance.reset = 'hang';
		const returned = h.close();
		await vi.advanceTimersByTimeAsync(1000);
		await returned;
		expect(h.instance.closed).toBe(true);

		const b = await pool.acquire(spec());
		await b.close();
		const b2 = await pool.acquire(spec()); // second use: the last one
		expect(b2.instance).toBe(b.instance);
		await b2.close();
		expect(b.instance.closed).toBe(true);
	});

	it('keeps at most maxIdle browsers (least recently used out) and closes an idle one after idleMs', async () => {
		vi.useFakeTimers();
		const { pool, launched, spec } = setup({ maxIdle: 1, idleMs: 1000 });
		const [a, b] = [await pool.acquire(spec()), await pool.acquire(spec())];
		await a.close();
		await b.close();
		expect(pool.idleCount).toBe(1);
		expect(launched.map((x) => x.closed)).toEqual([true, false]);
		await vi.advanceTimersByTimeAsync(1000);
		expect(pool.idleCount).toBe(0);
		expect(launched.every((x) => x.closed)).toBe(true);
	});

	it('stop closes idle and handed-out browsers, and refuses new holders', async () => {
		const { pool, launched, spec } = setup();
		const idle = await pool.acquire(spec());
		const held = await pool.acquire(spec());
		await idle.close();
		await pool.stop();
		expect(launched.map((x) => x.closed)).toEqual([true, true]);
		await held.close(); // after stop: nothing to give back
		expect(pool.idleCount).toBe(0);
		await expect(pool.acquire(spec())).rejects.toThrow(/stopped/);
	});

	it('a maxIdle of 0 closes every browser when its holder is done', async () => {
		const { pool, launched, spec } = setup({ maxIdle: 0 });
		const a = await pool.acquire(spec());
		await a.close();
		expect(launched[0]!.closed).toBe(true);
		expect(pool.idleCount).toBe(0);
	});
});
