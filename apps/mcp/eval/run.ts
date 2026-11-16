// The MCP tool-use eval's runner (see README.md). Every sample is a real `claude` or `codex exec` chat against the
// server's current text with only the engine faked. It calls paid models, so CI never runs it.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
	type Agent,
	canStartSample,
	claudeSessionDir,
	credentialState,
	type EvalAccount,
	isAuthFailure,
	isQuotaFailure,
	MIN_TOKEN_MINUTES,
	resolveAccount,
	resolveAppdir,
	SAMPLE_TIMEOUT_MS,
	sampleEnv,
} from './accounts.ts';
import { type EvalCase, fillVars, loadCases } from './case.ts';
import { createFakeEngine } from './fake-engine.ts';
import {
	casePasses,
	compareToBaseline,
	type Grade,
	grade,
	type McpCall,
	needsThirdSample,
	type ResultRow,
} from './grade.ts';
import {
	claudeLaunch,
	codexLaunch,
	EVAL_DIR,
	makeRepo,
	type ParsedRun,
	parseClaude,
	parseCodex,
	writeShellShims,
} from './harness.ts';
import { historyAsText, historyLines } from './history.ts';

const DEFAULT_MODEL: Record<Agent, string> = { claude: 'claude-sonnet-5-5', codex: 'gpt-6-astra' };
const REPO_ROOT = resolve(EVAL_DIR, '..', '..', '..');

const { values: flags } = parseArgs({
	options: {
		harness: { type: 'string', default: 'claude' },
		account: { type: 'string' },
		appdir: { type: 'string' },
		model: { type: 'string' },
		effort: { type: 'string' },
		case: { type: 'string' },
		samples: { type: 'string', default: '2' },
		concurrency: { type: 'string', default: '4' },
		'max-turns': { type: 'string', default: '30' },
		out: { type: 'string' },
		baseline: { type: 'string' },
		'source-root': { type: 'string' },
		'dry-run': { type: 'boolean', default: false },
	},
});

export type ResultLine = ResultRow & {
	sample: number;
	kind: string;
	account: string;
	harness: string;
	model: string;
	sourceRoot: string;
	failures: string[];
	invalid?: string;
	error?: string;
	calls: McpCall[];
	shell: string[];
	reply: string;
	toolSearches: string[];
	costUsd?: number;
	inputTokens?: number;
	ms: number;
};

type Abort = { stop: boolean; reason?: string };

function ensureAccountReady(account: EvalAccount): 'ok' | 'wait' {
	return canStartSample(credentialState(account)) ? 'ok' : 'wait';
}

async function runChild(
	launch: { command: string; args: string[]; stdin?: string },
	cwd: string,
	env: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean }> {
	return await new Promise((done, fail) => {
		const child = spawn(launch.command, launch.args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
		let stdout = '';
		let stderr = '';
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill('SIGKILL');
		}, SAMPLE_TIMEOUT_MS);
		child.stdout.on('data', (d: Buffer) => {
			stdout += d.toString('utf8');
		});
		child.stderr.on('data', (d: Buffer) => {
			stderr += d.toString('utf8');
		});
		child.on('error', fail);
		child.on('close', (code) => {
			clearTimeout(timer);
			done({ stdout, stderr, code, timedOut });
		});
		child.stdin.end(launch.stdin ?? '');
	});
}

async function runSample(input: {
	testCase: EvalCase;
	sample: number;
	account: EvalAccount;
	harness: Agent;
	model: string;
	effort?: string;
	sourceRoot: string;
	maxTurns: number;
	outDir: string;
}): Promise<ResultLine> {
	const { testCase, sample, account, harness, model, sourceRoot, outDir } = input;
	const started = Date.now();
	const cwd = realpathSync(mkdtempSync('/tmp/jasper-mcp-eval-'));
	const workDir = mkdtempSync('/tmp/jasper-mcp-evalwork-');
	const sessionDir = harness === 'claude' ? claudeSessionDir(account.home, cwd) : null;
	const log = join(workDir, 'calls.ndjson');
	const shellLog = join(workDir, 'shell.ndjson');
	writeFileSync(log, '');
	try {
		const engine = {
			...(testCase.setup?.project ? { project: testCase.setup.project } : {}),
			...(testCase.setup?.projectName ? { projectName: testCase.setup.projectName } : {}),
			...(testCase.setup?.preset ? { preset: testCase.setup.preset } : {}),
			...(testCase.setup?.faults ? { faults: testCase.setup.faults } : {}),
			...(testCase.setup?.review ? { review: testCase.setup.review } : {}),
			...(testCase.setup?.brief ? { brief: testCase.setup.brief } : {}),
			...(testCase.setup?.seed ? { seed: testCase.setup.seed } : {}),
			...(testCase.setup?.exportPolls ? { exportPolls: testCase.setup.exportPolls } : {}),
			...(testCase.setup?.outputExists ? { outputExists: true } : {}),
			...(testCase.setup?.pendingTranscription
				? { pendingTranscription: testCase.setup.pendingTranscription }
				: {}),
			...(testCase.setup?.analysisPolls ? { analysisPolls: testCase.setup.analysisPolls } : {}),
			...(testCase.setup?.verify ? { verify: testCase.setup.verify } : {}),
			...(testCase.setup?.pastExport ? { pastExport: testCase.setup.pastExport } : {}),
			...(testCase.setup?.logo ? { logo: true } : {}),
		};
		// The ids are deterministic, so the same setup here gives the stub's ids to the prompt and history.
		const vars = { ...createFakeEngine(engine).vars, cwd };
		const filled = fillVars(testCase, vars);
		makeRepo(cwd, filled.setup?.files ?? {});
		const stubConfig = join(workDir, 'stub.json');
		writeFileSync(
			stubConfig,
			JSON.stringify({
				sourceRoot,
				engine,
				...(filled.setup?.toolsets ? { toolsets: filled.setup.toolsets } : {}),
				log,
			}),
		);
		const policyFile = join(workDir, 'policy.json');
		writeFileSync(policyFile, JSON.stringify({ cwd, shellLog, shell: filled.setup?.shell ?? [] }));
		let prompt = filled.prompt;
		let resumeSession: string | undefined;
		if (filled.priorTurns?.length) {
			if (harness === 'claude') {
				resumeSession = randomUUID();
				mkdirSync(sessionDir!, { recursive: true });
				writeFileSync(
					join(sessionDir!, `${resumeSession}.jsonl`),
					`${historyLines(resumeSession, cwd, filled.priorTurns).join('\n')}\n`,
				);
			} else prompt = `${historyAsText(filled.priorTurns)}${prompt}`;
		}
		const base = {
			account,
			model,
			...(input.effort ? { effort: input.effort } : {}),
			cwd,
			workDir,
			stubConfig,
			maxTurns: input.maxTurns,
			prompt,
			...(resumeSession ? { resumeSession } : {}),
		};
		let launch: { command: string; args: string[]; stdin?: string };
		if (harness === 'claude') launch = claudeLaunch(base, policyFile);
		else {
			const shimDir = join(workDir, 'shims');
			writeShellShims(shimDir, policyFile);
			launch = codexLaunch(base, shimDir);
		}
		const child = await runChild(launch, cwd, sampleEnv(account, process.env));
		const run: ParsedRun =
			harness === 'claude' ? parseClaude(child.stdout, shellLog) : parseCodex(child.stdout);
		writeFileSync(join(outDir, 'raw', `${testCase.id}.${sample}.jsonl`), child.stdout);
		const calls = readFileSync(log, 'utf8')
			.split('\n')
			.filter(Boolean)
			.map((l) => JSON.parse(l) as McpCall);
		const record = { calls, shell: run.shell, reply: run.reply };
		const g: Grade = grade(record, filled.checks);
		const error = child.timedOut
			? 'sample timed out'
			: (run.error ?? (child.code ? `exit ${child.code}: ${child.stderr.slice(-300)}` : undefined));
		return {
			caseId: testCase.id,
			sample,
			kind: testCase.kind,
			pass: g.pass && !error,
			failures: error ? [error, ...g.failures] : g.failures,
			...(g.invalid ? { invalid: g.invalid } : {}),
			...(error ? { error } : {}),
			account: account.label,
			harness,
			model: run.model ?? model,
			sourceRoot,
			calls,
			shell: run.shell,
			reply: run.reply,
			toolSearches: run.toolSearches,
			...(run.costUsd !== undefined ? { costUsd: run.costUsd } : {}),
			...(run.inputTokens !== undefined ? { inputTokens: run.inputTokens } : {}),
			ms: Date.now() - started,
		};
	} finally {
		rmSync(cwd, { recursive: true, force: true });
		rmSync(workDir, { recursive: true, force: true });
		if (sessionDir) rmSync(sessionDir, { recursive: true, force: true });
	}
}

async function main(): Promise<void> {
	const harness = flags.harness as Agent;
	if (harness !== 'claude' && harness !== 'codex') throw new Error('--harness is claude or codex');
	let cases = loadCases();
	if (flags.case) {
		const wanted = new Set(flags.case.split(','));
		const unknown = [...wanted].filter((id) => !cases.some((c) => c.id === id));
		if (unknown.length) throw new Error(`Unknown case: ${unknown.join(', ')}`);
		cases = cases.filter((c) => wanted.has(c.id));
	}
	if (flags['dry-run']) {
		for (const c of cases) fillVars(c, { ...createFakeEngine(c.setup ?? {}).vars, cwd: '/tmp/x' });
		console.log(`${cases.length} cases build`);
		return;
	}
	if (!flags.account)
		throw new Error('Name a managed account: --account <label or id>[,<label or id>…]. There is no default.');
	if (!flags.out) throw new Error('--out <dir> outside the repository');
	const outDir = resolve(flags.out);
	if (outDir.startsWith(`${REPO_ROOT}/`)) throw new Error('--out must be outside the repository');
	mkdirSync(join(outDir, 'raw'), { recursive: true });
	const resultsFile = join(outDir, 'results.jsonl');
	const appdir = resolveAppdir(flags.appdir);
	const accounts = flags.account.split(',').map((a) => resolveAccount(appdir, harness, a));
	const before = new Map(accounts.map((a) => [a.id, credentialState(a)]));
	for (const a of accounts) {
		const s = before.get(a.id)!;
		console.log(`account ${a.label}: token ${s.minutesLeft ?? '?'} min left`);
	}
	const model = flags.model ?? DEFAULT_MODEL[harness];
	const sourceRoot = resolve(flags['source-root'] ?? REPO_ROOT);
	if (!existsSync(join(sourceRoot, 'apps/mcp/src/server.ts'))) throw new Error(`No server in ${sourceRoot}`);
	const samples = Number(flags.samples);
	const concurrency = Number(flags.concurrency);
	const abort: Abort = { stop: false };
	let next = 0;
	const results: ResultLine[] = [];

	const accountFor = async (): Promise<EvalAccount | null> => {
		for (let waited = 0; waited < 3; waited++) {
			const pick = accounts[next++ % accounts.length]!;
			for (let i = 0; i < accounts.length; i++) {
				const candidate = accounts[(accounts.indexOf(pick) + i) % accounts.length]!;
				if (ensureAccountReady(candidate) === 'ok') return candidate;
			}
			await new Promise((r) => setTimeout(r, 60_000));
		}
		return null;
	};

	const one = async (testCase: EvalCase, sample: number): Promise<ResultLine | null> => {
		if (abort.stop) return null;
		const account = await accountFor();
		if (!account) {
			abort.stop = true;
			abort.reason = `No account has ${MIN_TOKEN_MINUTES} minutes of token left; the daemon renews them, try again later.`;
			return null;
		}
		const line = await runSample({
			testCase,
			sample,
			account,
			harness,
			model,
			...(flags.effort ? { effort: flags.effort } : {}),
			sourceRoot,
			maxTurns: Number(flags['max-turns']),
			outDir,
		});
		if (line.error && isAuthFailure(line.error)) {
			abort.stop = true;
			abort.reason = `Login failure on ${account.label}; stopped so nothing retries a dead login. Check it in Orquester.`;
			return null;
		}
		if (line.error && isQuotaFailure(line.error)) {
			abort.stop = true;
			abort.reason = `Usage limit on ${account.label}: ${line.error.slice(0, 200)}`;
			return null;
		}
		appendFileSync(resultsFile, `${JSON.stringify(line)}\n`);
		results.push(line);
		const mark = line.invalid ? '?' : line.pass ? '.' : 'F';
		console.log(
			`${mark} ${testCase.id}#${sample} ${Math.round(line.ms / 1000)}s ${line.calls
				.map((c) => c.tool)
				.join(' ')
				.slice(0, 110)}${line.pass ? '' : ` :: ${line.failures[0]?.slice(0, 120)}`}`,
		);
		return line;
	};

	const queue: { testCase: EvalCase; sample: number }[] = cases.flatMap((testCase) =>
		Array.from({ length: samples }, (_, i) => ({ testCase, sample: i + 1 })),
	);
	const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
		for (;;) {
			const job = queue.shift();
			if (!job || abort.stop) return;
			const line = await one(job.testCase, job.sample);
			if (!line || samples !== 2) continue;
			const passes = results.filter((r) => r.caseId === job.testCase.id).map((r) => r.pass);
			if (needsThirdSample(passes)) queue.push({ testCase: job.testCase, sample: 3 });
		}
	});
	await Promise.all(workers);

	for (const a of accounts) {
		const was = before.get(a.id)!;
		const now = credentialState(a);
		const index = JSON.parse(readFileSync(join(appdir, 'daemon', 'agent-accounts.json'), 'utf8')) as {
			accounts: { id: string; needsReauth?: boolean }[];
		};
		const reauth = index.accounts.find((x) => x.id === a.id)?.needsReauth === true;
		console.log(
			`account ${a.label}: ${now.mtimeMs === was.mtimeMs ? 'credentials untouched' : 'credentials renewed in place'}, mode ${now.mode.toString(8)}, needsReauth ${reauth}`,
		);
		if (reauth) abort.reason = `${a.label} now needs a new login.`;
	}
	const byCase = new Map<string, ResultLine[]>();
	for (const r of results) byCase.set(r.caseId, [...(byCase.get(r.caseId) ?? []), r]);
	const rows = [...byCase.entries()].map(([id, lines]) => ({
		id,
		kind: lines[0]!.kind,
		passes: lines.filter((l) => l.pass).length,
		samples: lines.length,
		pass: casePasses(lines.map((l) => l.pass)),
		invalid: lines.some((l) => l.invalid),
	}));
	for (const r of rows) if (!r.pass) console.log(`FAIL ${r.id} (${r.kind}) ${r.passes}/${r.samples}`);
	const total = rows.filter((r) => r.pass).length;
	const cost = results.reduce((s, r) => s + (r.costUsd ?? 0), 0);
	console.log(
		`${total}/${rows.length} cases pass; notional cost $${cost.toFixed(2)}; invalid samples ${results.filter((r) => r.invalid).length}`,
	);
	writeFileSync(
		join(outDir, 'summary.json'),
		JSON.stringify({ harness, model, sourceRoot, rows, cost }, null, 1),
	);
	if (flags.baseline) {
		const baseline = readFileSync(flags.baseline, 'utf8')
			.split('\n')
			.filter(Boolean)
			.map((l) => JSON.parse(l) as ResultRow);
		const cmp = compareToBaseline(baseline, results);
		console.log(
			`regressions: ${cmp.regressions.join(', ') || 'none'}; fixed: ${cmp.fixed.join(', ') || 'none'}`,
		);
	}
	if (abort.reason) {
		console.error(`STOPPED: ${abort.reason}`);
		process.exitCode = 1;
	}
}

await main();
