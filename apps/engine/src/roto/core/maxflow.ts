// Min-cut / max-flow on sparse graphs with source and sink terminals, by the Boykov–Kolmogorov algorithm
// (Y. Boykov and V. Kolmogorov, "An Experimental Comparison of Min-Cut/Max-Flow Algorithms for Energy Minimization
// in Vision", IEEE PAMI 26(9), 2004). Ported from EffectCraft `crates/track/src/roto/maxflow.rs` (MIT OR Apache-2.0,
// licenses/ported/roto.md).
//
// Two search trees grow from the terminals (S from the source, T from the sink) through non-saturated edges; when
// they touch, the path found is augmented; saturated tree edges turn the nodes below them into orphans, which the
// adoption stage re-attaches to their tree (or frees). Trees are reused between augmentations, which is what makes
// the method fast on the grid graphs of image segmentation. The timestamp/distance heuristic of §3.2.3 keeps
// adoption paths short.
//
// Capacities are integers (callers scale their energies; terminal capacities up to 2^52, edge capacities 32-bit),
// so saturation tests are exact and the result is deterministic. Storage is typed arrays (no per-node objects).

const NONE = -1;
const TERMINAL = -2;
const ORPHAN = -3;

/** Which side of the cut a node ended on. */
export const SOURCE = 0;
export const SINK = 1;

/** A FIFO of node indices (each node is queued at most once at a time). */
class Fifo {
	private buf: Int32Array;
	private head = 0;
	private tail = 0;
	private size = 0;
	constructor(cap: number) {
		this.buf = new Int32Array(Math.max(4, cap));
	}
	push(v: number): void {
		if (this.size === this.buf.length) {
			const next = new Int32Array(this.buf.length * 2);
			for (let i = 0; i < this.size; i++) next[i] = this.buf[(this.head + i) % this.buf.length]!;
			this.buf = next;
			this.head = 0;
			this.tail = this.size;
		}
		this.buf[this.tail] = v;
		this.tail = (this.tail + 1) % this.buf.length;
		this.size++;
	}
	shift(): number {
		if (this.size === 0) return NONE;
		const v = this.buf[this.head]!;
		this.head = (this.head + 1) % this.buf.length;
		this.size--;
		return v;
	}
}

/** A graph for one min-cut computation. */
export class Graph {
	readonly nodeCount: number;
	private readonly first: Int32Array;
	private readonly parent: Int32Array;
	/** Residual terminal capacity: > 0 towards the source, < 0 towards the sink. */
	private readonly trCap: Float64Array;
	private readonly isSink: Uint8Array;
	private readonly active: Uint8Array;
	private readonly ts: Uint32Array;
	private readonly dist: Uint32Array;
	private head: Int32Array;
	private next: Int32Array;
	private rCap: Int32Array;
	private arcCount = 0;
	private flow = 0;
	private time = 0;
	private readonly queue: Fifo;
	private readonly orphans: Fifo;

	constructor(nodes: number, edgesHint = nodes * 4) {
		this.nodeCount = nodes;
		this.first = new Int32Array(nodes).fill(NONE);
		this.parent = new Int32Array(nodes).fill(NONE);
		this.trCap = new Float64Array(nodes);
		this.isSink = new Uint8Array(nodes);
		this.active = new Uint8Array(nodes);
		this.ts = new Uint32Array(nodes);
		this.dist = new Uint32Array(nodes);
		const arcs = Math.max(8, edgesHint * 2);
		this.head = new Int32Array(arcs);
		this.next = new Int32Array(arcs);
		this.rCap = new Int32Array(arcs);
		this.queue = new Fifo(nodes + 1);
		this.orphans = new Fifo(Math.min(nodes + 1, 1 << 16));
	}

	/** Terminal capacities of node `i`: `source` is paid when `i` ends on the sink side, `sink` on the source side. */
	addTWeights(i: number, source: number, sink: number): void {
		const d = this.trCap[i]!;
		let s = source;
		let t = sink;
		if (d > 0) s += d;
		else t -= d;
		this.flow += Math.min(s, t);
		this.trCap[i] = s - t;
	}

	/** An edge between `i` and `j` with capacity `cap` from i to j and `rev` from j to i. */
	addEdge(i: number, j: number, cap: number, rev: number): void {
		if (this.arcCount + 2 > this.head.length) {
			const n = this.head.length * 2;
			const grow = (a: Int32Array) => {
				const b = new Int32Array(n);
				b.set(a);
				return b;
			};
			this.head = grow(this.head);
			this.next = grow(this.next);
			this.rCap = grow(this.rCap);
		}
		const a = this.arcCount;
		this.head[a] = j;
		this.next[a] = this.first[i]!;
		this.rCap[a] = cap;
		this.first[i] = a;
		this.head[a + 1] = i;
		this.next[a + 1] = this.first[j]!;
		this.rCap[a + 1] = rev;
		this.first[j] = a + 1;
		this.arcCount += 2;
	}

	private setActive(i: number): void {
		if (!this.active[i]) {
			this.active[i] = 1;
			this.queue.push(i);
		}
	}

	/** Computes the maximum flow (= the minimum cut's cost). */
	maxflow(): number {
		const { parent, isSink, ts, dist, head, next, rCap, trCap, first } = this;
		for (let i = 0; i < this.nodeCount; i++) {
			if (trCap[i] !== 0) {
				isSink[i] = trCap[i]! < 0 ? 1 : 0;
				parent[i] = TERMINAL;
				ts[i] = 0;
				dist[i] = 1;
				this.setActive(i);
			}
		}
		let current = NONE;
		for (;;) {
			let i: number;
			if (current !== NONE && parent[current] !== NONE) i = current;
			else {
				current = NONE;
				for (;;) {
					i = this.queue.shift();
					if (i === NONE) return this.flow;
					this.active[i] = 0;
					if (parent[i] !== NONE) break;
				}
			}
			// Growth.
			let found = NONE;
			let a = first[i]!;
			const iTs = ts[i]!;
			const iDist = dist[i]!;
			if (!isSink[i]) {
				while (a !== NONE) {
					if (rCap[a]! > 0) {
						const j = head[a]!;
						if (parent[j] === NONE) {
							isSink[j] = 0;
							parent[j] = a ^ 1;
							ts[j] = iTs;
							dist[j] = iDist + 1;
							this.setActive(j);
						} else if (isSink[j]) {
							found = a;
							break;
						} else if (ts[j]! <= iTs && dist[j]! > iDist) {
							parent[j] = a ^ 1;
							ts[j] = iTs;
							dist[j] = iDist + 1;
						}
					}
					a = next[a]!;
				}
			} else {
				while (a !== NONE) {
					if (rCap[a ^ 1]! > 0) {
						const j = head[a]!;
						if (parent[j] === NONE) {
							isSink[j] = 1;
							parent[j] = a ^ 1;
							ts[j] = iTs;
							dist[j] = iDist + 1;
							this.setActive(j);
						} else if (!isSink[j]) {
							found = a ^ 1;
							break;
						} else if (ts[j]! <= iTs && dist[j]! > iDist) {
							parent[j] = a ^ 1;
							ts[j] = iTs;
							dist[j] = iDist + 1;
						}
					}
					a = next[a]!;
				}
			}
			this.time = (this.time + 1) >>> 0;
			if (found !== NONE) {
				// Keep `i` current: it may have more paths.
				current = i;
				this.augment(found);
				this.adopt();
			} else current = NONE;
		}
	}

	private augment(middle: number): void {
		const { parent, head, rCap, trCap } = this;
		let b = rCap[middle]!;
		// Source side.
		let i = head[middle ^ 1]!;
		for (;;) {
			const a = parent[i]!;
			if (a === TERMINAL) break;
			b = Math.min(b, rCap[a ^ 1]!);
			i = head[a]!;
		}
		b = Math.min(b, trCap[i]!);
		// Sink side.
		i = head[middle]!;
		for (;;) {
			const a = parent[i]!;
			if (a === TERMINAL) break;
			b = Math.min(b, rCap[a]!);
			i = head[a]!;
		}
		b = Math.min(b, -trCap[i]!);
		rCap[middle ^ 1] = rCap[middle ^ 1]! + b;
		rCap[middle] = rCap[middle]! - b;
		// Source side.
		i = head[middle ^ 1]!;
		for (;;) {
			const a = parent[i]!;
			if (a === TERMINAL) break;
			rCap[a] = rCap[a]! + b;
			rCap[a ^ 1] = rCap[a ^ 1]! - b;
			if (rCap[a ^ 1] === 0) this.makeOrphan(i);
			i = head[a]!;
		}
		trCap[i] = trCap[i]! - b;
		if (trCap[i] === 0) this.makeOrphan(i);
		// Sink side.
		i = head[middle]!;
		for (;;) {
			const a = parent[i]!;
			if (a === TERMINAL) break;
			rCap[a ^ 1] = rCap[a ^ 1]! + b;
			rCap[a] = rCap[a]! - b;
			if (rCap[a] === 0) this.makeOrphan(i);
			i = head[a]!;
		}
		trCap[i] = trCap[i]! + b;
		if (trCap[i] === 0) this.makeOrphan(i);
		this.flow += b;
	}

	private makeOrphan(i: number): void {
		this.parent[i] = ORPHAN;
		this.orphans.push(i);
	}

	/** Whether node `j`'s path to its terminal is intact; returns its distance (marking the path) or -1. */
	private originDist(j: number): number {
		const { parent, ts, dist, head } = this;
		let d = 0;
		let k = j;
		for (;;) {
			if (ts[k] === this.time) {
				d += dist[k]!;
				break;
			}
			const a = parent[k]!;
			d++;
			if (a === TERMINAL) {
				ts[k] = this.time;
				dist[k] = 1;
				break;
			}
			if (a === ORPHAN || a === NONE) return -1;
			k = head[a]!;
		}
		// Mark the path.
		let dd = d;
		k = j;
		while (ts[k] !== this.time) {
			ts[k] = this.time;
			dist[k] = dd;
			dd--;
			k = head[parent[k]!]!;
		}
		return d;
	}

	private adopt(): void {
		const { parent, isSink, ts, dist, head, next, rCap, first } = this;
		for (;;) {
			const i = this.orphans.shift();
			if (i === NONE) return;
			const sink = isSink[i]!;
			let best = NONE;
			let bestD = Number.MAX_SAFE_INTEGER;
			let a = first[i]!;
			while (a !== NONE) {
				// S orphan: the parent must push flow into i (residual on j→i); T orphan: i into the parent.
				const cap = sink ? rCap[a]! : rCap[a ^ 1]!;
				if (cap > 0) {
					const j = head[a]!;
					if (isSink[j] === sink && parent[j] !== NONE) {
						const d = this.originDist(j);
						if (d >= 0 && d < bestD) {
							best = a;
							bestD = d;
						}
					}
				}
				a = next[a]!;
			}
			if (best !== NONE) {
				parent[i] = best;
				ts[i] = this.time;
				dist[i] = bestD + 1;
				continue;
			}
			// No parent: free the node; its children become orphans, neighbours that could reach it become active.
			ts[i] = 0;
			a = first[i]!;
			while (a !== NONE) {
				const j = head[a]!;
				if (isSink[j] === sink && parent[j] !== NONE) {
					const cap = sink ? rCap[a]! : rCap[a ^ 1]!;
					if (cap > 0) this.setActive(j);
					const pa = parent[j]!;
					if (pa !== TERMINAL && pa !== ORPHAN && head[pa] === i) this.makeOrphan(j);
				}
				a = next[a]!;
			}
			parent[i] = NONE;
		}
	}

	/** The side of node `i` after `maxflow()` (free nodes go to the sink). */
	segment(i: number): typeof SOURCE | typeof SINK {
		return this.parent[i] !== NONE && !this.isSink[i] ? SOURCE : SINK;
	}
}
