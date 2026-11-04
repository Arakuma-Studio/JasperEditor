// The Program monitor's audio, tapped for the sound-design Phase 0 specs (sound-p0-preview, sound-p0-transport).
//
// Every AudioContext destination gets one bus per context; an AudioWorklet records channel 0 of whatever reaches the
// speakers with its context frame (`currentFrame`), on the audio thread, so times are exact context times and a busy
// main thread loses nothing (a ScriptProcessor tap, the earlier one of sound-p0-preview, runs on the main thread:
// under load it dropped or repeated whole buffers, which read as clicks 1024–2048 samples apart).
//
import type { Page } from '@playwright/test';

type Block = { f: number; d: Float32Array };
type Tap = {
	ctxs: {
		ctx: BaseAudioContext;
		node: AudioWorkletNode | null;
		blocks: Block[];
		starts: number;
		flush?: () => void;
		ready: Promise<void>;
	}[];
	armedAll?: number[];
	marks?: Record<string, number>;
	ready: Promise<void>;
	wait(ms: number, fromArm?: boolean): Promise<void>;
	program(): Promise<BaseAudioContext>;
	paused(): Promise<void>;
};
type TapWindow = Window & { __tap: Tap };

/** Init script: install with `page.addInitScript(TAP)` before the app loads. */
export const TAP = () => {
	const w = window as unknown as TapWindow;
	let ready!: () => void;
	let failed!: (error: unknown) => void;
	let nextReceipt = 1;
	const receipts = new Map<number, () => void>();
	const changed = new Set<() => void>();
	const emit = () => {
		for (const listener of [...changed]) listener();
	};
	let lastProgram: Tap['ctxs'][number] | undefined;
	const program = () =>
		new Promise<Tap['ctxs'][number]>((resolve) => {
			const check = () => {
				const entry = [...w.__tap.ctxs]
					.filter((c) => c.node && c.starts > 0 && c.ctx.state === 'running')
					.sort((a, b) => b.starts - a.starts)[0];
				const current = entry ?? (lastProgram?.ctx.state === 'running' ? lastProgram : undefined);
				if (!current) return;
				lastProgram = current;
				changed.delete(check);
				resolve(current);
			};
			changed.add(check);
			check();
		});
	w.__tap = {
		ctxs: [],
		ready: new Promise<void>((resolve, reject) => {
			ready = resolve;
			failed = reject;
		}),
		program: async () => (await program()).ctx,
		paused: async () => {
			const ctx = lastProgram?.ctx;
			if (ctx?.state !== 'running') return;
			await new Promise<void>((resolve) => {
				const changed = () => {
					if (ctx.state !== 'running') {
						ctx.removeEventListener('statechange', changed);
						resolve();
					}
				};
				ctx.addEventListener('statechange', changed);
				changed();
			});
		},
		wait: async (ms, fromArm = false) => {
			const entry = await program();
			const origin = fromArm ? w.__tap.armedAll?.[w.__tap.ctxs.indexOf(entry)] : entry.ctx.currentTime;
			if (origin === undefined) throw new Error('Audio tap was not armed for the Program context');
			return new Promise<void>((resolve) => {
				const id = nextReceipt++;
				receipts.set(id, resolve);
				entry.node!.port.postMessage({ until: Math.ceil((origin + ms / 1000) * entry.ctx.sampleRate), id });
			});
		},
	};
	const code = `class T extends AudioWorkletProcessor {
		constructor() { super(); this.on = false; this.buf = []; this.waits = [];
			this.port.onmessage = (e) => { if (e.data.until !== undefined) { this.waits.push(e.data); return; }
				this.on = e.data.on; if (!this.on) { this.port.postMessage({ blocks: this.buf, flushed: true }); this.buf = []; } }; }
		process(inputs) { const x = inputs[0] && inputs[0][0];
			if (this.on) { this.buf.push({ f: currentFrame, d: x ? new Float32Array(x) : new Float32Array(128) });
				if (this.buf.length >= 256) { this.port.postMessage(this.buf); this.buf = []; } }
			this.waits = this.waits.filter((w) => { if (currentFrame >= w.until) { this.port.postMessage({ advanced: w.id }); return false; } return true; });
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
		const entry = {
			ctx,
			node: null as AudioWorkletNode | null,
			blocks: [] as Block[],
			starts: 0,
			flush: undefined as (() => void) | undefined,
			ready: Promise.resolve(),
		};
		w.__tap.ctxs.push(entry);
		ctx.addEventListener('statechange', emit);
		entry.ready = ctx.audioWorklet.addModule(url).then(() => {
			const node = new AudioWorkletNode(ctx, 'jasper-e2e-tap', {
				channelCount: 2,
				channelCountMode: 'explicit',
			});
			node.port.onmessage = (
				e: MessageEvent<Block[] | { blocks: Block[]; flushed: true } | { advanced: number }>,
			) => {
				if (Array.isArray(e.data)) entry.blocks.push(...e.data);
				else if ('advanced' in e.data) {
					receipts.get(e.data.advanced)?.();
					receipts.delete(e.data.advanced);
				} else {
					entry.blocks.push(...e.data.blocks);
					entry.flush?.();
					entry.flush = undefined;
				}
			};
			const mute = ctx.createGain();
			mute.gain.value = 0;
			connect.call(bus!, node);
			connect.call(node, mute);
			connect.call(mute, dest);
			entry.node = node;
			ready();
			emit();
		});
		void entry.ready.catch(failed);
		return bus;
	};
	AudioNode.prototype.connect = function (this: AudioNode, ...args: unknown[]) {
		const dest = args[0];
		if (dest instanceof AudioDestinationNode) return connect.apply(this, [busOf(dest), ...args.slice(1)]);
		return connect.apply(this, args);
	} as typeof AudioNode.prototype.connect;
	const start = AudioBufferSourceNode.prototype.start;
	AudioBufferSourceNode.prototype.start = function (this: AudioBufferSourceNode, ...a: number[]) {
		// Select the program clock for picture/audio comparisons; no scheduling trace is asserted or filtered.
		const entry = w.__tap.ctxs.find((c) => c.ctx === this.context);
		if (entry) {
			entry.starts++;
			emit();
		}
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
	marks: Record<string, number>;
};

/** Waits for the existing output tap to finish installing its AudioWorklet. */
async function readyTap(p: Page): Promise<void> {
	await p.evaluate(async () => {
		const tap = (window as unknown as TapWindow).__tap;
		await tap.ready;
		await Promise.all(tap.ctxs.map((c) => c.ready));
	});
}

/** Waits for the Program output worklet to render the requested sample position. */
export async function recordedAudio(p: Page, ms: number, fromArm = false): Promise<void> {
	await p.evaluate(([duration, armed]) => (window as unknown as TapWindow).__tap.wait(duration, armed), [
		ms,
		fromArm,
	] as const);
}

/** Waits for the sampled Program context to suspend; initial priming has no playback to stop. */
export async function pausedAudio(p: Page): Promise<void> {
	await p.evaluate(() => (window as unknown as TapWindow).__tap.paused());
}

/** Starts recording every context. */
export async function arm(p: Page): Promise<void> {
	await readyTap(p);
	await p.evaluate(() => {
		const t = (window as unknown as TapWindow).__tap;
		for (const c of t.ctxs) {
			c.blocks.length = 0;
			// buffers started during this play tell the program context (Remotion's) from the others
			c.starts = 0;
			c.node?.port.postMessage({ on: true });
		}
		// the program context is suspended while paused: its frozen time is where the next Play starts
		t.armedAll = t.ctxs.map((c) => c.ctx.currentTime);
	});
}

/** Marks the current context time of the program context under `name`. */
export async function mark(p: Page, name: string): Promise<void> {
	await p.evaluate((n) => {
		const t = (window as unknown as TapWindow).__tap;
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
	await p.evaluate(async () => {
		const t = (window as unknown as TapWindow).__tap;
		await Promise.all(
			t.ctxs
				.filter((c) => c.node && c.ctx.state !== 'closed')
				.map(
					(c) =>
						new Promise<void>((resolve) => {
							c.flush = resolve;
							c.node!.port.postMessage({ on: false });
						}),
				),
		);
	});
	return p.evaluate(() => {
		const t = (window as unknown as TapWindow).__tap;
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
			marks,
		};
	});
}

/** Context time (s) of sample `i` of a recording (blocks are 128 frames). */
export function timeOf(r: Recording, i: number): number {
	const b = Math.floor(i / 128);
	return (r.frames[b]! + (i - b * 128)) / r.rate;
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
