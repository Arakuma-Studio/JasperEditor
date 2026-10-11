// Chrome can leave resume() pending when suspend() overlaps it. Remotion also waits for the audio clock
// to advance after resume(), so suspend() must wait for that advance (bounded to 250 ms).
// This function is self-contained so browser tests can evaluate its source.
export function installSerialAudioContext(): void {
	const AC = (globalThis as { AudioContext?: { prototype: AudioContext } }).AudioContext;
	if (!AC) return;
	const proto = AC.prototype as AudioContext & { __jasperSerial?: true };
	if (proto.__jasperSerial) return;
	const nativeResume = proto.resume;
	const nativeSuspend = proto.suspend;
	type Track = {
		chain: Promise<void>;
		resumedAt: { contextTime: number; performanceTime: number } | null;
	};
	const tracks = new WeakMap<AudioContext, Track>();
	const trackOf = (ctx: AudioContext): Track => {
		let t = tracks.get(ctx);
		if (!t) {
			t = { chain: Promise.resolve(), resumedAt: null };
			tracks.set(ctx, t);
		}
		return t;
	};
	const stamp = (ctx: AudioContext) => {
		const o = ctx.getOutputTimestamp?.() ?? {};
		return { contextTime: o.contextTime ?? ctx.currentTime, performanceTime: o.performanceTime ?? 0 };
	};
	/** Resolves once the audio clock moved past `since` (or after `maxMs`). */
	const advanced = (
		ctx: AudioContext,
		since: { contextTime: number; performanceTime: number },
		maxMs: number,
	) =>
		new Promise<void>((resolve) => {
			// anime-allow: wall-clock bound of an AudioContext state change, never animation time
			const t0 = performance.now();
			const check = () => {
				const now = stamp(ctx);
				if (
					(now.contextTime > since.contextTime && now.performanceTime > since.performanceTime) ||
					ctx.state !== 'running' ||
					// anime-allow: wall-clock bound of an AudioContext state change, never animation time
					performance.now() - t0 >= maxMs
				)
					resolve();
				else setTimeout(check, 8);
			};
			check();
		});
	const run = (ctx: AudioContext, op: () => Promise<void>): Promise<void> => {
		const t = trackOf(ctx);
		const next = t.chain.then(op, op);
		t.chain = next.catch(() => undefined);
		return next;
	};
	const resume = function (this: AudioContext): Promise<void> {
		return run(this, async () => {
			await nativeResume.call(this);
			trackOf(this).resumedAt = stamp(this);
		});
	};
	const suspend = function (this: AudioContext): Promise<void> {
		return run(this, async () => {
			const t = trackOf(this);
			if (t.resumedAt && this.state === 'running') await advanced(this, t.resumedAt, 250);
			t.resumedAt = null;
			await nativeSuspend.call(this);
		});
	};
	Object.defineProperty(proto, 'resume', { value: resume, writable: true, configurable: true });
	Object.defineProperty(proto, 'suspend', { value: suspend, writable: true, configurable: true });
	Object.defineProperty(proto, '__jasperSerial', { value: true, configurable: true });
}
