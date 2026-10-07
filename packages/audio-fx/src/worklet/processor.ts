// AudioWorklet processor hosting a clip's ClipChain in the preview (docs/wp-notes/audio-fx.md §Preview). The input is
// the clip's decoded audio as Remotion schedules it (shifted earlier by the chain latency); the output goes to the
// shared Remotion gain node. The position of each render quantum inside the clip is derived from the context time
// and Remotion's audio sync anchor, so automation is sample-placed like in the export; a jump in that position
// (seek, play from elsewhere) restarts the chain with fresh state, exactly like an export starting there.
import { ClipChain } from '../chain/clip-chain.ts';
import { CLIP_CHAIN_PROCESSOR, type FromWorklet, type ToWorklet } from './protocol.ts';

// Minimal AudioWorkletGlobalScope typing (not in TypeScript's DOM lib).
declare const sampleRate: number;
declare const currentTime: number;
declare class AudioWorkletProcessor {
	readonly port: MessagePort;
	constructor(options?: unknown);
}
declare function registerProcessor(name: string, ctor: new (options?: unknown) => AudioWorkletProcessor): void;

/** Positions within this many samples of the expected continuation count as continuous (float jitter). */
const JITTER = 2;
const METER_INTERVAL = 4800;

class ClipChainProcessor extends AudioWorkletProcessor {
	private chain: ClipChain | null = null;
	private timing: { anchor: number; rate: number; startSec: number } | null = null;
	private next: number | null = null;
	private alive = true;
	private meters = false;
	private sinceMeters = 0;
	private latency = -1;
	private readonly l = new Float32Array(128);
	private readonly r = new Float32Array(128);

	constructor(options?: unknown) {
		super(options);
		this.port.onmessage = (e: MessageEvent<ToWorklet>) => this.onMessage(e.data);
	}

	private onMessage(m: ToWorklet): void {
		switch (m.type) {
			case 'config': {
				const cfg = { ...m.config, sampleRate };
				if (this.chain) this.chain.update(cfg);
				else this.chain = new ClipChain(cfg);
				this.reportLatency();
				break;
			}
			case 'timing':
				this.timing = { anchor: m.anchor, rate: m.rate, startSec: m.startSec };
				break;
			case 'meters':
				this.meters = m.on;
				break;
			case 'dispose':
				this.alive = false;
				break;
		}
	}

	private reportLatency(): void {
		const l = this.chain?.latency() ?? 0;
		if (l === this.latency) return;
		this.latency = l;
		this.port.postMessage({ type: 'latency', samples: l } satisfies FromWorklet);
	}

	process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
		if (!this.alive) return false;
		const out = outputs[0];
		if (!out || out.length === 0) return true;
		const n = out[0]!.length;
		const chain = this.chain;
		const t = this.timing;
		if (!chain || !t || n > this.l.length) {
			for (const o of out) o.fill(0);
			return true;
		}
		const L = chain.latency();
		const derived = Math.round(((currentTime - t.anchor) * t.rate - t.startSec) * sampleRate) + L;
		let pos = derived;
		if (this.next !== null) {
			const step = Math.abs(derived - this.next);
			if (t.rate === 1 && step <= JITTER) pos = this.next;
			else if (t.rate === 1 || derived < this.next - JITTER || step > n * Math.max(1, t.rate) * 4) chain.reset();
		} else chain.reset();
		const inp = inputs[0];
		const il = inp?.[0];
		const ir = inp?.[1] ?? il;
		const l = this.l;
		const r = this.r;
		if (il && ir) {
			l.set(il.subarray(0, n));
			r.set(ir.subarray(0, n));
		} else {
			l.fill(0, 0, n);
			r.fill(0, 0, n);
		}
		chain.process([l, r], 0, n, pos);
		this.next = pos + n;
		out[0]!.set(l.subarray(0, n));
		if (out[1]) out[1].set(r.subarray(0, n));
		if (this.meters) {
			this.sinceMeters += n;
			if (this.sinceMeters >= METER_INTERVAL) {
				this.sinceMeters = 0;
				const values: Record<string, number[]> = {};
				for (const p of chain.effects.processors())
					if (p.processor.meters) values[p.instanceId] = [...p.processor.meters()];
				this.port.postMessage({ type: 'meters', latency: L, values } satisfies FromWorklet);
			}
		}
		return true;
	}
}

registerProcessor(CLIP_CHAIN_PROCESSOR, ClipChainProcessor as unknown as new (o?: unknown) => AudioWorkletProcessor);
