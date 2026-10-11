// Scale benchmark (golden-fuzz; docs/testing.md §Scale benchmark): the operations people do all day, on a large
// generated project — 200 sequences, ~5,000 clips with GPU effects, Lumetri, keyframes, transitions, text, shapes
// and markers (packages/project/bench/scale-project.ts, built through the real command system). EffectCraft's
// `bench --ops` (architecture §7) is the model.
//
//   pnpm exec tsx packages/session/bench/scale.ts            # measure, check budgets, write scale.results.json
//   SCALE_SEQUENCES=20 pnpm exec tsx …                       # a smaller project (quick look; results not written)
//   PERF=1 …                                                  # documented budgets exactly (no load scaling)
//   JASPER_PERF_NO_BUDGET=1 …                                 # measure only, never fail
//
// Budgets are wall-clock milliseconds on the reference machine (12-core x86-64, Node 20, idle); without PERF=1 they
// are scaled by the host's measured slowdown (`loadFactor` of scripts/perf/budget.ts, the test gate's policy), so a
// shared machine does not fail them while an order-of-magnitude regression still does.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { cpus, loadavg } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import {
	buildRenderSnapshot,
	checkInvariants,
	createCounterIdSource,
	defaultRegistries,
	loadProject,
	makeEnvelope,
	migrate,
	type ProjectDocument,
	resolveSceneAt,
} from '@jasper/project';
import { loadFactor, PERF_STRICT as STRICT } from '../../../scripts/perf/budget.ts';
import { buildScaleProject, countClips } from '../../project/bench/scale-project.ts';
import { EditorSession } from '../src/session.ts';

const here = dirname(fileURLToPath(import.meta.url));
const SEQUENCES = Number(process.env.SCALE_SEQUENCES ?? 200);
const FULL = SEQUENCES === 200;
const NO_BUDGET = process.env.JASPER_PERF_NO_BUDGET === '1';

// ---------------------------------------------------------------- measuring

type Result = {
	op: string;
	what: string;
	runs: number;
	medianMs: number;
	p95Ms: number;
	cpuMedianMs: number;
	budgetMs: number;
	pass: boolean;
};
const results: Result[] = [];
let factor = 1;

const quantile = (xs: number[], q: number) => {
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1) + 0.5))]!;
};

/** Times `fn` `runs` times after `warm` warm-ups (`setup` runs untimed before each call). */
function measure<T>(
	op: string,
	what: string,
	budget: number,
	fn: (input: T) => void,
	opts: { runs?: number; warm?: number; setup?: () => T } = {},
): void {
	const runs = opts.runs ?? 9;
	for (let i = 0; i < (opts.warm ?? 2); i++) fn(opts.setup?.() as T);
	const wall: number[] = [];
	const cpu: number[] = [];
	for (let i = 0; i < runs; i++) {
		const input = opts.setup?.() as T;
		const c0 = process.cpuUsage();
		const t0 = performance.now();
		fn(input);
		wall.push(performance.now() - t0);
		const c = process.cpuUsage(c0);
		cpu.push((c.user + c.system) / 1000);
	}
	const budgetMs = STRICT ? budget : budget * factor;
	const r: Result = {
		op,
		what,
		runs,
		medianMs: quantile(wall, 0.5),
		p95Ms: quantile(wall, 0.95),
		cpuMedianMs: quantile(cpu, 0.5),
		budgetMs: Math.round(budgetMs),
		pass: quantile(wall, 0.5) <= budgetMs,
	};
	results.push(r);
	console.log(
		`${r.pass ? 'ok  ' : 'OVER'} ${op.padEnd(22)} median ${r.medianMs.toFixed(1).padStart(8)} ms  p95 ${r.p95Ms.toFixed(1).padStart(8)} ms  cpu ${r.cpuMedianMs.toFixed(1).padStart(8)} ms  budget ${r.budgetMs} ms`,
	);
}

// ---------------------------------------------------------------- the workload

factor = loadFactor();
console.log(
	`load factor ${factor.toFixed(2)} (load average ${loadavg()[0]!.toFixed(1)}, ${cpus().length} CPUs)`,
);
const tGen = performance.now();
const doc = buildScaleProject({ sequences: SEQUENCES });
const generateMs = performance.now() - tGen;
const clips = countClips(doc);
const seqIds = Object.keys(doc.sequences);
let effects = 0;
let keyframes = 0;
for (const s of Object.values(doc.sequences))
	for (const c of Object.values(s.clips)) {
		const fx = 'effects' in c ? c.effects : [];
		effects += fx.length;
		for (const f of fx) for (const p of Object.values(f.params)) keyframes += p.keyframes?.length ?? 0;
		keyframes += 'opacity' in c ? c.opacity.keyframes.length : 0;
	}
const envelope = () =>
	makeEnvelope(doc, { revision: 1, savedAt: '2026-10-08T00:00:00.000Z', platform: 'bench' });
const json = JSON.stringify(envelope());
console.log(
	`project: ${seqIds.length} sequences, ${clips} clips, ${effects} effects, ${keyframes} keyframes, ${(json.length / 1e6).toFixed(1)} MB JSON (generated in ${(generateMs / 1000).toFixed(1)} s)`,
);
const registries = defaultRegistries();

// Load: what opening a project does (parse the file, migrate, validate, invariants, repair when needed).
measure('load', 'JSON.parse + loadProject (migrate, zod, invariants)', 2500, () =>
	loadProject(JSON.parse(json), { ids: createCounterIdSource(1), effects: registries.effects }),
);
// Migrate: the whole migration pipeline from the oldest schema (v1 → current).
const v1 = JSON.stringify({ ...envelope(), document: { ...doc, schemaVersion: 1 } });
measure(
	'migrate v1→current',
	'migrate() of the same project stamped schema v1',
	1500,
	(raw: unknown) => migrate(raw),
	{
		setup: () => JSON.parse(v1),
	},
);
measure('invariants', 'checkInvariants of the whole document (every transaction runs it)', 600, () =>
	checkInvariants(doc, { effects: registries.effects }),
);

// Editing through the session (history, selection, revision bookkeeping), as the editor and agents do.
const ids = createCounterIdSource(1_000_000);
const session = new EditorSession({
	projectId: 'scale-bench',
	document: doc as ProjectDocument,
	ctx: { ids, now: () => '2026-10-08T00:00:00.000Z', registries },
});
const seq = doc.sequences[seqIds[Math.floor(seqIds.length / 2)]!]!;
const text = Object.values(seq.clips).find((c) => c.kind === 'text')!;
let v = 0;
measure('small edit', 'session.apply: one Opacity value of one clip', 250, () =>
	session.apply({
		label: 'opacity',
		origin: 'user',
		sequenceId: seq.id,
		commands: [
			{ type: 'param.set', target: ['clip', text.id, 'opacity'], value: 20 + (v++ % 60), at: { frames: 30 } },
		],
	}),
);
const many = Object.values(doc.sequences)
	.flatMap((s) => Object.values(s.clips).filter((c) => c.kind === 'text'))
	.slice(0, 300);
measure(
	'large edit',
	`session.apply: Opacity of ${many.length} clips across sequences in one transaction`,
	2000,
	() =>
		session.apply({
			label: 'opacity ×300',
			origin: 'user',
			commands: many.map((c) => ({
				type: 'param.set',
				target: ['clip', c.id, 'opacity'],
				value: 10 + (v++ % 80),
			})),
		}),
	{ runs: 5 },
);
measure('undo', 'session.undo() of the last edit', 50, () => session.undo(), {
	setup: () =>
		session.apply({
			label: 'opacity',
			origin: 'user',
			sequenceId: seq.id,
			commands: [{ type: 'param.set', target: ['clip', text.id, 'opacity'], value: 33, at: { frames: 30 } }],
		}),
});
measure('redo', 'session.redo() of the undone edit', 50, () => session.redo(), {
	setup: () => {
		session.apply({
			label: 'opacity',
			origin: 'user',
			sequenceId: seq.id,
			commands: [{ type: 'param.set', target: ['clip', text.id, 'opacity'], value: 44, at: { frames: 30 } }],
		});
		session.undo();
	},
});

// Rendering inputs.
const opts = { resolveMedia: () => null, resolveFont: () => null };
measure('render snapshot', 'buildRenderSnapshot of one sequence (preview / export input)', 40, () =>
	buildRenderSnapshot(session.getCommitted(), seq.id, opts),
);
measure(
	'render snapshots ×200',
	'buildRenderSnapshot of every sequence',
	3000,
	() => {
		const d = session.getCommitted();
		for (const id of seqIds) buildRenderSnapshot(d, id, opts);
	},
	{ runs: 3, warm: 1 },
);
const snap = buildRenderSnapshot(session.getCommitted(), seq.id, opts);
measure('scene at a frame', 'resolveSceneAt (the layers of one frame)', 5, () => resolveSceneAt(snap, 30), {
	runs: 50,
});

// Autosave: the main-thread work of a save — the envelope and its JSON (the engine store writes it off-thread).
measure('autosave serialise', 'makeEnvelope + JSON.stringify of the committed document', 1200, () =>
	JSON.stringify(makeEnvelope(session.getCommitted(), { revision: 2, savedAt: 'x', platform: 'bench' })),
);

// ---------------------------------------------------------------- report

const over = results.filter((r) => !r.pass);
if (FULL) {
	let revision = 'unknown';
	try {
		revision = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
	} catch {
		// not a git checkout
	}
	writeFileSync(
		join(here, 'scale.results.json'),
		`${JSON.stringify(
			{
				revision,
				node: process.version,
				date: new Date().toISOString().slice(0, 10),
				machine: {
					cpus: cpus().length,
					model: cpus()[0]?.model ?? null,
					loadAverage: loadavg()[0],
					loadFactor: factor,
				},
				workload: {
					sequences: seqIds.length,
					clips,
					effects,
					keyframes,
					jsonBytes: json.length,
					generateMs: Math.round(generateMs),
				},
				method:
					'packages/session/bench/scale.ts: wall-clock median and p95 (and process CPU median) after warm-up runs; budgets are reference-machine milliseconds scaled by the measured load factor unless PERF=1.',
				results,
			},
			null,
			2,
		)}\n`,
	);
}
if (over.length && !NO_BUDGET) {
	console.error(`\n${over.length} operation(s) over budget: ${over.map((r) => r.op).join(', ')}`);
	process.exit(1);
}
