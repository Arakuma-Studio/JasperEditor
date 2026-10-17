// Benchmark of the review preview of a large sound-design proposal (WP6.5b item 15): N place items (+ their bin,
// 25 sounds and N new cues as setup items, ≈ 2N + 26 items), as the WP3.2 plan builds them, previewed by the session's
// proposals slice with manual timers (each timer callback is one main-thread task). Reports, per phase (opening the
// review, after an unrelated edit, after a reject), the wall time, the CPU time of this process (`process.cpuUsage`:
// what the work costs whatever the machine's load), the number of tasks and the longest ones, and the load average.
//
//   node --import tsx packages/session/bench/proposals-preview.ts [N=500] [runs=3]
//
// Run it on two builds on the same host, one after the other, to compare (the wp-note's before / after).
import { cpus, loadavg } from 'node:os';
import { proposalsFor } from '../src/index.ts';
import { bigProposal, bigSession } from '../test/big-proposal.ts';

const N = Number(process.argv[2] ?? 500);
const RUNS = Number(process.argv[3] ?? 3);

type Phase = { wallMs: number; cpuMs: number; tasks: number; longestMs: number; p95Ms: number };

async function once() {
	const { session, engine, seqId } = bigSession(N);
	const p = bigProposal(session, engine, N);
	const queue: (() => void)[] = [];
	const c = proposalsFor(session, {
		engine,
		setTimer: (fn) => {
			queue.push(fn);
			return queue.length;
		},
		clearTimer: () => {},
	});
	const drain = (): Phase => {
		const t = performance.now();
		const cpu0 = process.cpuUsage();
		const tasks: number[] = [];
		while (queue.length && tasks.length < 1_000_000) {
			const f = queue.shift()!;
			const t1 = performance.now();
			f();
			tasks.push(performance.now() - t1);
		}
		const cpu = process.cpuUsage(cpu0);
		const sorted = [...tasks].sort((a, b) => a - b);
		return {
			wallMs: Math.round(performance.now() - t),
			cpuMs: Math.round((cpu.user + cpu.system) / 1000),
			tasks: tasks.length,
			longestMs: Math.round(sorted.at(-1) ?? 0),
			p95Ms: Math.round(sorted[Math.floor(0.95 * (sorted.length - 1))] ?? 0),
		};
	};
	await c.setActive(p.id);
	const open = drain();
	if (c.getState().preview?.heard.length !== p.items.length)
		throw new Error('the preview did not apply every item');
	session.apply({
		label: 'Edit',
		origin: 'user',
		sequenceId: seqId,
		commands: [{ type: 'marker.add', frame: 5, name: 'x' }] as never[],
	});
	const edit = drain();
	const place = p.items.filter((it) => it.id.startsWith('sfx:'));
	await c.setItemDecision([place[10]!.id], 'reject');
	await new Promise((r) => setTimeout(r, 0));
	const reject = drain();
	c.dispose();
	return { items: p.items.length, open, edit, reject };
}

const results = [];
for (let i = 0; i < RUNS; i++) {
	const load = loadavg()[0]!;
	const r = await once();
	results.push({ ...r, loadBefore: Math.round(load), loadAfter: Math.round(loadavg()[0]!) });
}
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const summary = (k: 'open' | 'edit' | 'reject') => ({
	wallMs: median(results.map((r) => r[k].wallMs)),
	cpuMs: median(results.map((r) => r[k].cpuMs)),
	longestMs: median(results.map((r) => r[k].longestMs)),
	p95Ms: median(results.map((r) => r[k].p95Ms)),
	tasks: median(results.map((r) => r[k].tasks)),
});
console.log(
	JSON.stringify(
		{
			n: N,
			items: results[0]?.items,
			runs: RUNS,
			machine: { cpu: cpus()[0]?.model ?? 'unknown', cores: cpus().length, node: process.version },
			median: { open: summary('open'), edit: summary('edit'), reject: summary('reject') },
			runsDetail: results,
		},
		null,
		1,
	),
);
