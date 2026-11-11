// Warm render browsers (remotion/browser-pool.ts, wp-note export-performance §13): reuse, relaunch after a crash,
// bounded idle set and lifetime, and nothing left open after stop.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserPool } from '../src/remotion/browser-pool.ts';

type Fake = { id: number; alive: boolean; closed: boolean; pages: number; resetFails?: boolean };

function setup(o: { maxIdle?: number; idleMs?: number; maxUses?: number; key?: () => string } = {}) {
	const launched: Fake[] = [];
	const warmed: number[] = [];
	const pool = new BrowserPool<Fake>({
		launch: async () => {
			const b: Fake = { id: launched.length + 1, alive: true, closed: false, pages: 0 };
			launched.push(b);
			return b;
		},
		key: o.key ?? (() => 'gl=default'),
		healthy: async (b) => b.alive,
		reset: async (b) => {
			if (b.resetFails) throw new Error('page close failed');
			b.pages = 0;
		},
		dispose: async (b) => {
			b.closed = true;
		},
		warm: async (b) => {
			warmed.push(b.id);
		},
		maxIdle: o.maxIdle ?? 2,
		idleMs: o.idleMs ?? 60_000,
		maxUses: o.maxUses ?? 10,
	});
	return { pool, launched, warmed };
}

afterEach(() => {
	vi.useRealTimers();
});

describe('render browser pool', () => {
	it('gives a returned browser to the next holder, blank and warmed once, instead of launching another', async () => {
		const { pool, launched, warmed } = setup();
		const first = await pool.acquire();
		first.instance.pages = 3;
		await first.close();
		await first.close(); // idempotent
		const second = await pool.acquire();
		expect(second.instance).toBe(first.instance);
		expect(second.instance.pages).toBe(0);
		await second.close();
		expect(launched).toHaveLength(1);
		expect(warmed).toEqual([1]);
		expect(pool.stats).toMatchObject({ launched: 1, reused: 1 });
	});

	it('replaces an idle browser that crashed with a new launch and closes the dead one', async () => {
		const { pool, launched } = setup();
		const a = await pool.acquire();
		await a.close();
		launched[0]!.alive = false; // the process died while idle
		const b = await pool.acquire();
		expect(b.instance).not.toBe(a.instance);
		expect(launched[0]!.closed).toBe(true);
		expect(launched).toHaveLength(2);
		await b.close();
	});

	it('closes a browser whose reset fails, one that served maxUses holders, and one launched with other options', async () => {
		let key = 'gl=default';
		const { pool, launched } = setup({ maxUses: 2, key: () => key });
		const a = await pool.acquire();
		a.instance.resetFails = true;
		await a.close();
		expect(launched[0]!.closed).toBe(true);

		const b = await pool.acquire();
		await b.close();
		const b2 = await pool.acquire(); // second use: the last one
		expect(b2.instance).toBe(b.instance);
		await b2.close();
		expect(b.instance.closed).toBe(true);

		const c = await pool.acquire();
		await c.close();
		key = 'gl=angle-egl';
		const d = await pool.acquire();
		expect(d.instance).not.toBe(c.instance);
		expect(c.instance.closed).toBe(true);
		await d.close();
	});

	it('keeps at most maxIdle browsers and closes an idle one after idleMs', async () => {
		vi.useFakeTimers();
		const { pool, launched } = setup({ maxIdle: 1, idleMs: 1000 });
		const [a, b] = [await pool.acquire(), await pool.acquire()];
		await a.close();
		await b.close();
		expect(pool.idleCount).toBe(1);
		expect(launched.filter((x) => x.closed)).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1000);
		expect(pool.idleCount).toBe(0);
		expect(launched.every((x) => x.closed)).toBe(true);
	});

	it('stop closes idle and handed-out browsers, and refuses new holders', async () => {
		const { pool, launched } = setup();
		const idle = await pool.acquire();
		const held = await pool.acquire();
		await idle.close();
		await pool.stop();
		expect(launched.map((x) => x.closed)).toEqual([true, true]);
		await held.close(); // after stop: nothing to give back
		expect(pool.idleCount).toBe(0);
		await expect(pool.acquire()).rejects.toThrow(/stopped/);
	});

	it('a maxIdle of 0 closes every browser when its holder is done', async () => {
		const { pool, launched } = setup({ maxIdle: 0 });
		const a = await pool.acquire();
		await a.close();
		expect(launched[0]!.closed).toBe(true);
		expect(pool.idleCount).toBe(0);
	});
});
