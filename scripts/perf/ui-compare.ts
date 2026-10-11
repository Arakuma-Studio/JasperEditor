// Compare editor UI scenarios on the same host (docs/performance.md §5): two web builds served by the built engine on two ports, the scenarios run alternately
// (A, B, A, B…) so both see the same host load; prints the median of each metric per build.
//
//   pnpm exec tsx scripts/perf/ui-compare.ts <webDirA> <webDirB> [--rounds 3] [--only drag,scroll]
//   (build A from another commit: `git worktree add --detach /tmp/base <commit>`, install, `vite build --outDir …`)
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { runUiScenarios, type UiScenarioResult } from './ui-run.ts';
import { harnessEngineEnv } from './ui-scenarios.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const args = process.argv.slice(2);
const opt = (name: string, dflt: string) => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 ? args[i + 1]! : dflt;
};
const [dirA, dirB] = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
if (!dirA || !dirB) {
	console.error(
		'usage: tsx scripts/perf/ui-compare.ts <webDirA> <webDirB> [--rounds 3] [--only drag,scroll]',
	);
	process.exit(2);
}
const rounds = Number(opt('rounds', '3'));
const only = opt('only', '').split(',').filter(Boolean);
const basePort = Number(process.env.PERF_PORT ?? 49465);

async function serve(webDir: string, port: number): Promise<{ base: string; stop(): void }> {
	const appdir = mkdtempSync(join(tmpdir(), 'jasper-uicmp-'));
	const child: ChildProcess = spawn(
		process.execPath,
		[join(root, 'apps/engine/dist/engine.mjs'), '--port', String(port), '--appdir', appdir],
		{
			cwd: root,
			env: { ...process.env, JASPER_APPDIR: appdir, JASPER_WEB_DIR: webDir, ...harnessEngineEnv() },
			stdio: 'ignore',
		},
	);
	const base = `http://127.0.0.1:${port}`;
	for (let i = 0; i < 120; i++) {
		try {
			if ((await fetch(`${base}/health`)).ok) break;
		} catch {
			// starting
		}
		await new Promise((r) => setTimeout(r, 500));
	}
	return {
		base,
		stop() {
			child.kill('SIGTERM');
			rmSync(appdir, { recursive: true, force: true });
		},
	};
}

const a = await serve(dirA, basePort);
const b = await serve(dirB, basePort + 3);
const browser = await chromium.launch({
	headless: true,
	...(existsSync('/usr/bin/google-chrome') ? { executablePath: '/usr/bin/google-chrome' } : {}),
	args: ['--enable-features=CanvasDrawElement', '--autoplay-policy=no-user-gesture-required'],
});
const results: Record<'A' | 'B', UiScenarioResult[]> = { A: [], B: [] };
try {
	for (let r = 0; r < rounds; r++)
		for (const [name, s] of [
			['A', a],
			['B', b],
		] as const) {
			console.log(`round ${r + 1} build ${name}`);
			results[name].push(...(await runUiScenarios({ browser, base: s.base }, only)));
		}
} finally {
	await browser.close();
	a.stop();
	b.stop();
}
const median = (xs: number[]) => [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)] ?? Number.NaN;
const metrics = ['fps', 'p50', 'p95', 'mean', 'busy', 'dragWallMs', 'openMs'] as const;
const scenarios = [...new Set(results.A.map((r) => r.scenario))];
console.log(`\n| Scenario | Metric | A (${dirA}) | B (${dirB}) |\n|---|---|---|---|`);
for (const sc of scenarios)
	for (const m of metrics) {
		const va = results.A.filter((r) => r.scenario === sc).map((r) => r[m] as number | undefined);
		const vb = results.B.filter((r) => r.scenario === sc).map((r) => r[m] as number | undefined);
		if (va.every((v) => typeof v !== 'number')) continue;
		const fa = median(va.filter((v): v is number => typeof v === 'number'));
		const fb = median(vb.filter((v): v is number => typeof v === 'number'));
		console.log(`| ${sc} | ${m} | ${fa} | ${fb} |`);
	}
