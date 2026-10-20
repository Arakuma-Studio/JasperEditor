// The picture wait of a primed start (sound-design Phase 0 close-out), as the output timestamp Remotion 4.0.499 polls.
//
// On Play, Remotion's `waitUntilActuallyResumed` reads `currentTime` and `getOutputTimestamp()` once (the start
// reading), then polls `getOutputTimestamp()` every animation frame and starts the picture once the output's context
// time passes the start reading's `currentTime` (and its performance time advanced). A primed start's program reaches
// the output `wait` seconds after the context's resume time `startAt`, so the timestamp is reported that much early
// until the output passes `end = startAt + wait`: Remotion then starts the picture with the program's first sample.
//
// The offset is fixed by the start reading: `end − (currentTime at the first call after arming)`. Chrome starts the
// audio clock before the main thread sees the `running` state (measured: `currentTime` 21–85 ms past the resume time
// while `state` still read `suspended`), so the state cannot tell the start reading from later polls; an offset taken
// from a later poll waited too little, or not at all (the picture then led the program by up to the read-ahead).
// After a stall during the wait (the context suspended again before the program reached the output), `rearm()` makes
// the next start reading count again, so the resumed wait is only what is left of it.

/** What `AudioContext.getOutputTimestamp()` returns. */
export type OutputTimestamp = { contextTime?: number; performanceTime?: number };

export class PrimedStartClock {
	private end = 0;
	private waiting = false;
	/** `currentTime` of Remotion's start reading (the first call after arming); null until it happens. */
	private from: number | null = null;

	/** A primed start resumes at context time `startAt`; the program reaches the output `wait` seconds later. */
	arm(startAt: number, wait: number): void {
		this.waiting = Number.isFinite(wait) && wait > 0 && Number.isFinite(startAt);
		this.end = this.waiting ? startAt + wait : 0;
		this.from = null;
	}

	/** The context stalled during the wait: the next resume's start reading counts (it waits for what is left). */
	rearm(): void {
		if (this.waiting) this.from = null;
	}

	/** No wait any more (a seek during playback, a plain suspend). */
	clear(): void {
		this.waiting = false;
		this.from = null;
	}

	/** The picture still waits for the program to reach the output. */
	get active(): boolean {
		return this.waiting;
	}

	/** Context time at which the program reaches the output (0 when not waiting). */
	get endTime(): number {
		return this.waiting ? this.end : 0;
	}

	/** The timestamp to report for a native one read at `currentTime`. */
	report(native: OutputTimestamp, currentTime: number): OutputTimestamp {
		if (!this.waiting) return native;
		const { contextTime, performanceTime } = native;
		if (contextTime === undefined || performanceTime === undefined) return native;
		// The program has reached the output: the start is over. Chrome briefly answers `{currentTime, 0}` right after
		// a resume; only a real reading (a performance time) ends the wait.
		if (performanceTime > 0 && contextTime >= this.end) {
			this.clear();
			return native;
		}
		if (this.from === null) this.from = Number.isFinite(currentTime) ? currentTime : this.end;
		const off = Math.max(0, this.end - this.from);
		return { contextTime: contextTime - off, performanceTime: performanceTime - off * 1000 };
	}
}
