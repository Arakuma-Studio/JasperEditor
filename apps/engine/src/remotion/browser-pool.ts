// Warm render browsers (wp-note export-performance §16): the render browser a bake, a still, a render or an HTML
// composition used is kept open for the next one instead of being closed. A new page in a warm browser loads the
// compositions bundle from its HTTP cache, with V8's code cache, in about a third of a cold page's time (the bundle is
// ≈ 12 MB of script: compile and evaluation took 2.5–4 s of the 4.5–6.6 s a cold page needed before its first frame on
// a loaded host), and the launch itself (≈ 1–2 s) is saved.
//
// A browser is handed to one holder at a time (`acquire`); its `close()` gives it back. Every browser carries the key
// of its launch options: `acquire(spec)` reuses only an idle browser of `spec.key` (callers with other options — the
// Remotion renders' probed `gl`, the HTML pages' own — never get each other's browsers) and launches one otherwise.
// Back in the pool a browser is reset (its pages closed, within `resetMs`); it is closed for good when the reset fails
// or hangs, it served `maxUses` holders, the pool is stopped, or it stayed idle `idleMs`; beyond `maxIdle` idle
// browsers the least recently used one is closed. A browser that crashed or stopped answering while idle is found by
// the health check of the next `acquire`, closed and replaced by a new launch. Nothing outlives `stop()`.

/** A browser handed out by the pool; `close()` returns it (idempotent). */
export type PooledBrowser<B> = { readonly instance: B; close(): Promise<void> };

/** What `acquire` asks for: the launch options' identity, how to launch with them, and the optional warm-up. */
export type BrowserSpec<B> = {
	key: string;
	launch(): Promise<B>;
	/** Runs once per browser when it first becomes idle (fills its caches); its failure is ignored. */
	warm?(browser: B): Promise<void>;
};

export type BrowserPoolOptions<B> = {
	/** Whether an idle browser still answers (a crashed or hung one is closed and replaced). */
	healthy(browser: B): Promise<boolean>;
	/** Puts a returned browser back to a blank state (its pages closed). A rejection closes it. */
	reset(browser: B): Promise<void>;
	/** Closes a browser for good (never rejects the pool's work: errors are swallowed). */
	dispose(browser: B): Promise<void>;
	/** Idle browsers kept at most (0: none — every `close()` closes). */
	maxIdle: number;
	/** An idle browser is closed after this long (ms). */
	idleMs: number;
	/** A browser is closed after serving this many holders (bounds what a long-lived browser accumulates). */
	maxUses: number;
	/** A reset that takes longer (a hung browser) closes the browser instead (default 10 s). */
	resetMs?: number;
	log?(line: string): void;
};

type Entry<B> = {
	browser: B;
	key: string;
	warm: ((browser: B) => Promise<void>) | undefined;
	uses: number;
	warmed: boolean;
	closed: boolean;
	timer: ReturnType<typeof setTimeout> | null;
};

const RESET_MS = 10_000;

export class BrowserPool<B> {
	/** Idle browsers, least recently used first. */
	private readonly idle: Entry<B>[] = [];
	/** Browsers handed out or being reset / warmed, closed by `stop()`. */
	private readonly busy = new Set<Entry<B>>();
	private stopped = false;
	readonly stats = { launched: 0, reused: 0, replaced: 0, closed: 0 };

	constructor(private readonly o: BrowserPoolOptions<B>) {}

	/** Idle browsers right now. */
	get idleCount(): number {
		return this.idle.length;
	}

	/** A warm browser of `spec.key` when a healthy one is idle, else a new launch. */
	async acquire(spec: BrowserSpec<B>): Promise<PooledBrowser<B>> {
		if (this.stopped) throw new Error('The render browser pool is stopped');
		for (;;) {
			let i = this.idle.length - 1;
			while (i >= 0 && this.idle[i]!.key !== spec.key) i--;
			if (i < 0) break;
			const [e] = this.idle.splice(i, 1);
			if (e!.timer) clearTimeout(e!.timer);
			e!.timer = null;
			this.busy.add(e!);
			if ((await this.o.healthy(e!.browser).catch(() => false)) && !this.stopped) {
				this.stats.reused++;
				return this.handOut(e!);
			}
			this.stats.replaced++;
			this.o.log?.('[remotion] an idle render browser did not answer: relaunching');
			await this.drop(e!);
			if (this.stopped) throw new Error('The render browser pool is stopped');
		}
		const browser = await spec.launch();
		this.stats.launched++;
		const e: Entry<B> = {
			browser,
			key: spec.key,
			warm: spec.warm,
			uses: 0,
			warmed: false,
			closed: false,
			timer: null,
		};
		this.busy.add(e);
		if (this.stopped) {
			await this.drop(e);
			throw new Error('The render browser pool is stopped');
		}
		return this.handOut(e);
	}

	/** Closes every browser, idle or handed out; later `close()`s of handed-out browsers are no-ops. */
	async stop(): Promise<void> {
		this.stopped = true;
		const all = [...this.idle.splice(0), ...this.busy];
		this.busy.clear();
		await Promise.all(
			all.map((e) => {
				if (e.timer) clearTimeout(e.timer);
				return this.dispose(e);
			}),
		);
	}

	private handOut(e: Entry<B>): PooledBrowser<B> {
		e.uses++;
		let returned: Promise<void> | null = null;
		return {
			instance: e.browser,
			close: () => {
				returned ??= this.giveBack(e);
				return returned;
			},
		};
	}

	private async giveBack(e: Entry<B>): Promise<void> {
		if (!this.busy.has(e)) return; // stopped meanwhile: already closed
		const keep = !this.stopped && this.o.maxIdle > 0 && e.uses < this.o.maxUses;
		if (!keep || !(await this.resetWithin(e.browser))) {
			await this.drop(e);
			return;
		}
		if (!e.warmed && e.warm) {
			e.warmed = true;
			await e.warm(e.browser).catch(() => undefined);
		}
		// Re-check: the pool may have been stopped while this browser was reset / warmed.
		if (!this.busy.has(e)) return;
		if (this.stopped) {
			await this.drop(e);
			return;
		}
		this.busy.delete(e);
		e.timer = setTimeout(() => {
			const i = this.idle.indexOf(e);
			if (i < 0) return;
			this.idle.splice(i, 1);
			void this.dispose(e);
		}, this.o.idleMs);
		e.timer.unref?.();
		this.idle.push(e);
		// Least recently used out.
		while (this.idle.length > this.o.maxIdle) {
			const old = this.idle.shift()!;
			if (old.timer) clearTimeout(old.timer);
			await this.dispose(old);
		}
	}

	private async resetWithin(browser: B): Promise<boolean> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timedOut = new Promise<boolean>((resolve) => {
			timer = setTimeout(() => resolve(false), this.o.resetMs ?? RESET_MS);
			timer.unref?.();
		});
		try {
			return await Promise.race([
				this.o.reset(browser).then(
					() => true,
					() => false,
				),
				timedOut,
			]);
		} finally {
			clearTimeout(timer);
		}
	}

	private async drop(e: Entry<B>): Promise<void> {
		this.busy.delete(e);
		await this.dispose(e);
	}

	private async dispose(e: Entry<B>): Promise<void> {
		if (e.closed) return;
		e.closed = true;
		this.stats.closed++;
		await this.o.dispose(e.browser).catch(() => undefined);
	}
}
