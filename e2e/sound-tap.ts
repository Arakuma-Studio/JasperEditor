// The Program monitor's audio, tapped for the sound-design Phase 0 specs (sound-p0-preview, sound-p0-transport).
//
// Every AudioContext destination gets one bus per context; an AudioWorklet records channel 0 of whatever reaches the
// speakers with its context frame (`currentFrame`), on the audio thread, so times are exact context times and a busy
// main thread loses nothing (a ScriptProcessor tap, the earlier one of sound-p0-preview, runs on the main thread:
// under load it dropped or repeated whole buffers, which read as clicks 1024–2048 samples apart).
//
// Remotion schedules each media player's decoded audio as AudioBufferSourceNodes on the shared context. When the main
// thread is starved (a loaded host) it falls behind: it starts buffers after their time (they play late), or
// re-anchors and stops every queued buffer to schedule again (the new anchor is frame-based, so clicks then land at a
// sub-sample phase). Such a play measures Remotion's scheduling, not the mix graph: the tap logs both events
// (`stops`, `late`) so a spec can tell and play again.
import { loadavg } from 'node:os';
import type { Page } from '@playwright/test';

/** Init script: install with `page.addInitScript(TAP)` before the app loads. */
export const TAP = () => {
	type Block = { f: number; d: Float32Array };
	type Tap = {
		on: boolean;
		ctxs: { ctx: BaseAudioContext; node: AudioWorkletNode | null; blocks: Block[]; starts: number }[];
		stops: { t: number; player: number }[];
		late: { t: number; by: number }[];
		starts: { t: number; player: number }[];
		/** Media buffers connected (Remotion schedules each right after): context time, state, player. */
		connects: { t: number; suspended: boolean; player: number }[];
	};
	const w = window as unknown as { __tap: Tap };
	// Which player a buffer source belongs to: the node it is first connected to (each Remotion media player has its
	// own gain node). A reschedule stops the buffers of every player at once; a clip that ends stops only its own.
	const players = new WeakMap<AudioNode, number>();
	const playerOf = new WeakMap<AudioBufferSourceNode, number>();
	let nextPlayer = 0;
	w.__tap = { on: false, ctxs: [], stops: [], late: [], starts: [], connects: [] };
	const code = `class T extends AudioWorkletProcessor {
		constructor() { super(); this.on = false; this.buf = [];
			this.port.onmessage = (e) => { this.on = e.data.on; if (!this.on) { this.port.postMessage(this.buf); this.buf = []; } }; }
		process(inputs) { const x = inputs[0] && inputs[0][0];
			if (this.on) { this.buf.push({ f: currentFrame, d: x ? new Float32Array(x) : new Float32Array(128) });
				if (this.buf.length >= 256) { this.port.postMessage(this.buf); this.buf = []; } }
			return true; } }
	registerProcessor('jasper-e2e-tap', T);`;
	const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
	const buses = new WeakMap<BaseAudioContext, GainNode>();
	const connect = AudioNode.prototype.connect as (this: AudioNode, ...a: unknown[]) => unknown;
	const busOf = (dest: AudioDestinationNode): GainNode => {
		const ctx = dest.context;
		let bus = buses.get(ctx);
		if (bus) return bus;
		bus = ctx.createGain();
		buses.set(ctx, bus);
		connect.call(bus, dest);
		const entry = { ctx, node: null as AudioWorkletNode | null, blocks: [] as Block[], starts: 0 };
		w.__tap.ctxs.push(entry);
		void ctx.audioWorklet.addModule(url).then(() => {
			const node = new AudioWorkletNode(ctx, 'jasper-e2e-tap', {
				channelCount: 2,
				channelCountMode: 'explicit',
			});
			node.port.onmessage = (e: MessageEvent<Block[]>) => entry.blocks.push(...e.data);
			const mute = ctx.createGain();
			mute.gain.value = 0;
			connect.call(bus!, node);
			connect.call(node, mute);
			connect.call(mute, dest);
			entry.node = node;
		});
		return bus;
	};
	AudioNode.prototype.connect = function (this: AudioNode, ...args: unknown[]) {
		const dest = args[0];
		if (this instanceof AudioBufferSourceNode && dest instanceof AudioNode && !playerOf.has(this)) {
			let id = players.get(dest);
			if (id === undefined) {
				id = nextPlayer++;
				players.set(dest, id);
			}
			playerOf.set(this, id);
			if (w.__tap.on)
				w.__tap.connects.push({
					t: this.context.currentTime,
					suspended: this.context.state !== 'running',
					player: id,
				});
			(w.__tap as unknown as { all?: unknown[] }).all?.push([
				'connect',
				+this.context.currentTime.toFixed(5),
				this.context.state === 'running' ? 'r' : 's',
				id,
			]);
		}
		if (dest instanceof AudioDestinationNode) return connect.apply(this, [busOf(dest), ...args.slice(1)]);
		return connect.apply(this, args);
	} as typeof AudioNode.prototype.connect;
	const stop = AudioScheduledSourceNode.prototype.stop;
	AudioScheduledSourceNode.prototype.stop = function (this: AudioScheduledSourceNode, when?: number) {
		if (w.__tap.on)
			w.__tap.stops.push({
				t: this.context.currentTime,
				player: this instanceof AudioBufferSourceNode ? (playerOf.get(this) ?? -1) : -1,
			});
		return stop.call(this, when);
	};
	const start = AudioBufferSourceNode.prototype.start;
	AudioBufferSourceNode.prototype.start = function (this: AudioBufferSourceNode, ...a: number[]) {
		const when = a[0] ?? 0;
		const ctx = this.context;
		// diagnostics (a spec sets `__tap.all` to an array): every media buffer start, also while suspended
		(w.__tap as unknown as { all?: unknown[] }).all?.push([
			'start',
			+ctx.currentTime.toFixed(5),
			+when.toFixed(5),
			+(a[1] ?? 0).toFixed(5),
			ctx.state === 'running' ? 'r' : 's',
			playerOf.get(this) ?? -1,
		]);
		const entry = w.__tap.ctxs.find((c) => c.ctx === ctx);
		if (entry) entry.starts++;
		if (w.__tap.on && ctx.state === 'running')
			w.__tap.starts.push({ t: ctx.currentTime, player: playerOf.get(this) ?? -1 });
		// A start time already past (by more than a render quantum) on a running context: the buffer plays late.
		// `0` means "now" (not a scheduled time).
		if (w.__tap.on && when > 0 && ctx.state === 'running' && when < ctx.currentTime - 128 / ctx.sampleRate)
			w.__tap.late.push({ t: ctx.currentTime, by: ctx.currentTime - when });
		return start.apply(this, a as Parameters<typeof start>);
	} as typeof AudioBufferSourceNode.prototype.start;
};

export type Recording = {
	rate: number;
	/** Context time (s) when the tap was armed (the frozen time of a suspended context = where playback resumes). */
	armed: number;
	/** First context frame of each 128-frame block, and the samples of channel 0 (gaps while suspended are not filled). */
	frames: number[];
	data: number[];
	/** `stop()` calls: context time and the player of the buffer (-1: not a media buffer). */
	stops: { t: number; player: number }[];
	/** Context times at which a buffer was started after its time, and by how much (s). */
	late: { t: number; by: number }[];
	/** Every media buffer start while the context ran: context time and player. */
	starts: { t: number; player: number }[];
	/** Every media buffer Remotion scheduled (connected), also while suspended. */
	connects: { t: number; suspended: boolean; player: number }[];
	marks: Record<string, number>;
};

/** Starts recording every context (and the scheduling logs). */
export async function arm(p: Page): Promise<void> {
	await p.evaluate(() => {
		const t = (
			window as unknown as {
				__tap: {
					on: boolean;
					ctxs: { ctx: BaseAudioContext; node: AudioWorkletNode | null; blocks: unknown[]; starts: number }[];
					stops: unknown[];
					late: unknown[];
					starts: unknown[];
					connects: unknown[];
					armedAll?: number[];
				};
			}
		).__tap;
		for (const c of t.ctxs) {
			c.blocks.length = 0;
			// buffers started during this play tell the program context (Remotion's) from the others
			c.starts = 0;
			c.node?.port.postMessage({ on: true });
		}
		t.stops.length = 0;
		t.late.length = 0;
		t.starts.length = 0;
		t.connects.length = 0;
		// the program context is suspended while paused: its frozen time is where the next Play starts
		t.armedAll = t.ctxs.map((c) => c.ctx.currentTime);
		t.on = true;
	});
}

/** Marks the current context time of the program context under `name`. */
export async function mark(p: Page, name: string): Promise<void> {
	await p.evaluate((n) => {
		const t = (
			window as unknown as {
				__tap: { ctxs: { ctx: BaseAudioContext; starts: number }[]; marks?: Record<string, number> };
			}
		).__tap;
		t.marks ??= {};
		// the program context: the one Remotion schedules media buffers on (running ones first)
		const ctx = [...t.ctxs].sort(
			(a, b) => Number(b.ctx.state === 'running') - Number(a.ctx.state === 'running') || b.starts - a.starts,
		)[0]?.ctx;
		t.marks[n] = ctx?.currentTime ?? -1;
	}, name);
}

/** Stops recording; returns the loudest context's recording (the program's; others are silent). */
export async function disarm(p: Page): Promise<Recording> {
	await p.evaluate(() => {
		const t = (window as unknown as { __tap: { on: boolean; ctxs: { node: AudioWorkletNode | null }[] } })
			.__tap;
		t.on = false;
		for (const c of t.ctxs) c.node?.port.postMessage({ on: false });
	});
	await p.waitForTimeout(300);
	return p.evaluate(() => {
		const t = (
			window as unknown as {
				__tap: {
					ctxs: { ctx: BaseAudioContext; blocks: { f: number; d: Float32Array }[] }[];
					stops: { t: number; player: number }[];
					late: { t: number; by: number }[];
					starts: { t: number; player: number }[];
					connects: { t: number; suspended: boolean; player: number }[];
					marks?: Record<string, number>;
					armedAll?: number[];
				};
			}
		).__tap;
		const peakOf = (bs: { d: Float32Array }[]) =>
			bs.reduce((m, b) => b.d.reduce((x, v) => Math.max(x, Math.abs(v)), m), 0);
		const bestIndex = t.ctxs.reduce((a, b, i) => (peakOf(b.blocks) > peakOf(t.ctxs[a]!.blocks) ? i : a), 0);
		const best = t.ctxs[bestIndex]!;
		const frames: number[] = [];
		const data: number[] = [];
		// Chrome's worklet `currentFrame` advances once per device callback, which may render several quanta (measured:
		// five blocks with the same frame, then a jump of 640), so it can lag the block it is read in. Every quantum the
		// context renders is recorded (silent ones too) and the context's frames stand still while it is suspended: block
		// `i` is at `first + 128 i`, `first` the largest `f − 128 i` read (a lagging read is only ever too small). A click
		// read with the lagging frame looked up to 512 samples early.
		let first = Number.NEGATIVE_INFINITY;
		best.blocks.forEach((b, i) => {
			first = Math.max(first, b.f - 128 * i);
		});
		best.blocks.forEach((b, i) => {
			frames.push(first + 128 * i);
			for (const v of b.d) data.push(v);
		});
		const marks = t.marks ?? {};
		t.marks = {};
		return {
			rate: best.ctx.sampleRate,
			armed: t.armedAll?.[bestIndex] ?? -1,
			frames,
			data,
			stops: t.stops.map((s) => ({ t: s.t, player: s.player })),
			late: t.late.map((l) => ({ t: l.t, by: l.by })),
			starts: t.starts.map((x) => ({ t: x.t, player: x.player })),
			connects: t.connects.map((x) => ({ t: x.t, suspended: x.suspended, player: x.player })),
			marks,
		};
	});
}

/** Context time (s) of sample `i` of a recording (blocks are 128 frames). */
export function timeOf(r: Recording, i: number): number {
	const b = Math.floor(i / 128);
	return (r.frames[b]! + (i - b * 128)) / r.rate;
}

/** Context frame of sample `i` of a recording. */
export function frameOf(r: Recording, i: number): number {
	const b = Math.floor(i / 128);
	return r.frames[b]! + (i - b * 128);
}

/** Local maxima of |x| above `min`, merged within 5 ms, as context times. */
export function peaks(r: Recording, min = 0.05): { t: number; v: number }[] {
	const out: { t: number; v: number; i: number }[] = [];
	for (let i = 0; i < r.data.length; i++) {
		const v = Math.abs(r.data[i]!);
		if (v < min) continue;
		const last = out[out.length - 1];
		if (last && i - last.i < r.rate * 0.005) {
			if (v > last.v) Object.assign(last, { i, v, t: timeOf(r, i) });
		} else out.push({ i, v, t: timeOf(r, i) });
	}
	return out.map(({ t, v }) => ({ t, v }));
}

/**
 * Context times inside [from, to] where Remotion rescheduled a player: it stopped that player's queued buffers and
 * started new ones (in the same task or within 2 s: after a seek the new position may take a while to decode) — a seek,
 * or its re-anchoring when the picture and the audio clock drift apart. Buffers that play out end without `stop()`; a
 * clip that ends stops its player's buffers and starts none.
 */
export function reschedules(r: Recording, from: number, to: number): number[] {
	const out = new Set<number>();
	for (const s of r.stops) {
		// At `from` itself (the context still at its frozen resume time) every Play reschedules on purpose: since
		// sound-design Phase 6 each Play starts primed at the picture, its sources scheduled again before any audio plays.
		if (s.t <= from + 0.001 || s.t > to || s.player < 0) continue;
		if (r.starts.some((x) => x.player === s.player && x.t >= s.t - 0.05 && x.t <= s.t + 2))
			out.add(Number(s.t.toFixed(4)));
	}
	return [...out].sort((a, b) => a - b);
}

/**
 * What disturbed Remotion's scheduling inside [from, to] (context times): reschedules, and buffers started after
 * their time. Empty for a play that measures the graph.
 */
export function disturbances(r: Recording, from: number, to: number): string[] {
	return [
		...reschedules(r, from, to).map((t) => `reschedule at ${(t - from).toFixed(3)} s`),
		...r.late
			.filter((l) => l.t >= from && l.t <= to)
			.map((l) => `buffer started ${(l.by * 1000).toFixed(1)} ms late at ${(l.t - from).toFixed(3)} s`),
	];
}

/**
 * Plays measured by the Phase 0 specs: a play whose scheduling Remotion lost (a loaded host starves the page's main
 * thread) is played again, at most this many times in all.
 */
export const ATTEMPTS = 8;

/**
 * After the attempts: a test whose every play was disturbed measured nothing — it fails saying so (with the host load)
 * instead of judging the graph on a play Remotion lost.
 */
export function requireUndisturbed(clean: boolean, last: string[]): void {
	if (clean) return;
	throw new Error(
		`Every one of ${ATTEMPTS} plays was disturbed by the host (load average ${loadavg()
			.map((x) => x.toFixed(1))
			.join(' ')}), so nothing was measured; last: ${last.join('; ')}`,
	);
}
