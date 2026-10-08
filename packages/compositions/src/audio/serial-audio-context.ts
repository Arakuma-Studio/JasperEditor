// previews workstream (playback robustness): the root cause of the Remotion Player "stall after seeks" (M1-STATUS,
// docs/research/remotion-4.0.499-notes.md) — measured in the editor and reduced to a page of its own:
//
// 1. Chrome leaves `AudioContext.resume()` pending forever when `suspend()` is called before the resume settled
//    (headless Chrome 150, 0–2 ms apart: the resume promise never settles; the state reads 'running').
// 2. The Player (4.0.499 `use-playback`) waits for the shared AudioContext to *actually* resume before it advances
//    a frame: `waitUntilActuallyResumed` polls `getOutputTimestamp()` until the audio clock moved. A suspend that
//    lands right after a resume (a seek's buffering, a pause/play toggle, mute changes re-running the playback
//    effect) leaves the clock frozen, so that wait — and the Player — never continue: the store says playing, the
//    frame stands still (2 of 20 seek-and-play cycles in the built editor on this host), until play() is issued again.
//
// The fix serialises each context's state changes: a `resume()` or `suspend()` waits for the previous one to settle,
// and a suspend right after a resume first lets the clock advance (at most 250 ms), so every "actually resumed" wait
// started by that resume ends. Installed once per page by the compositions; idempotent; a no-op without Web Audio.
// Self-contained (no module state), so tests can run its source in a page.
export function installSerialAudioContext(): void {
	const AC = (globalThis as { AudioContext?: { prototype: AudioContext } }).AudioContext;
	if (!AC) return;
	const proto = AC.prototype as AudioContext & { __jasperSerial?: true };
	if (proto.__jasperSerial) return;
	const nativeResume = proto.resume;
	const nativeSuspend = proto.suspend;
	type Track = {
		chain: Promise<unknown>;
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
			const t0 = performance.now();
			const check = () => {
				const now = stamp(ctx);
				if (
					(now.contextTime > since.contextTime && now.performanceTime > since.performanceTime) ||
					ctx.state !== 'running' ||
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
