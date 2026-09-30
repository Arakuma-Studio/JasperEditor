// TransportStore (ARCHITECTURE §6, S02:TL-155, S03:ARC-010): the playhead lives outside React state.
// Listeners are plain callbacks; components that must re-render use a throttled hook.

export type TransportState = { frame: number; playing: boolean; rate: number; loop: boolean };

/** What the Program monitor's Player exposes (WP-2C attaches it). */
export interface PlayerController {
	seekTo(frame: number): void;
	play(): void;
	pause(): void;
	setPlaybackRate?(rate: number): void;
}

export type TransportListener = (state: TransportState, prev: TransportState) => void;

export class TransportStore {
	private state: TransportState;
	private readonly listeners = new Set<TransportListener>();
	private player: PlayerController | null = null;
	/** Frame bounds used to clamp seeks (sequence duration, S02:TL-005). */
	private maxFrame = Number.POSITIVE_INFINITY;

	constructor(initial: Partial<TransportState> = {}) {
		this.state = { frame: 0, playing: false, rate: 1, loop: false, ...initial };
	}

	getState(): TransportState {
		return this.state;
	}
	subscribe(listener: TransportListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	private set(patch: Partial<TransportState>): void {
		const prev = this.state;
		const next = { ...prev, ...patch };
		if (
			next.frame === prev.frame &&
			next.playing === prev.playing &&
			next.rate === prev.rate &&
			next.loop === prev.loop
		)
			return;
		this.state = next;
		for (const l of [...this.listeners]) l(next, prev);
	}

	setMaxFrame(max: number): void {
		this.maxFrame = Math.max(0, max);
	}

	/** Moves the playhead; while paused the attached Player is seeked (store is the source of truth). */
	seek(frame: number): void {
		const f = Math.max(0, Math.min(this.maxFrame, Math.round(frame)));
		this.set({ frame: f });
		if (!this.state.playing) this.player?.seekTo(f);
	}
	/** Called by the Player while playing (the Player is the clock, S03:ARC-010). */
	reportFrame(frame: number): void {
		this.set({ frame: Math.max(0, Math.round(frame)) });
	}
	play(rate = this.state.rate): void {
		this.set({ playing: true, rate });
		this.player?.setPlaybackRate?.(rate);
		this.player?.play();
	}
	pause(): void {
		this.set({ playing: false });
		this.player?.pause();
	}
	toggle(): void {
		if (this.state.playing) this.pause();
		else this.play(1);
	}
	setRate(rate: number): void {
		this.set({ rate });
		this.player?.setPlaybackRate?.(rate);
	}
	setLoop(loop: boolean): void {
		this.set({ loop });
	}
	step(frames: number): void {
		if (this.state.playing) this.pause();
		this.seek(this.state.frame + frames);
	}
	attachPlayer(controller: PlayerController): () => void {
		this.player = controller;
		controller.seekTo(this.state.frame);
		return () => {
			if (this.player === controller) this.player = null;
		};
	}
}
