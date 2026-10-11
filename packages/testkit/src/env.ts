import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Whether an environment variable is set to a true value (`1`, `true`, `yes`, `on`; case-insensitive). */
export function envFlag(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
	return ['1', 'true', 'yes', 'on'].includes((env[name] ?? '').trim().toLowerCase());
}

let root: string | undefined;

/** The monorepo root (the directory holding `pnpm-workspace.yaml`). */
export function repoRoot(): string {
	if (root) return root;
	let dir = dirname(fileURLToPath(import.meta.url));
	for (;;) {
		if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return (root = dir);
		const up = resolve(dir, '..');
		if (up === dir) throw new Error('testkit: no pnpm-workspace.yaml above packages/testkit');
		dir = up;
	}
}

/** `<repo>/test-results/<sub>` (gitignored), or `$JASPER_TEST_RESULTS/<sub>` when set. */
export function testResultsDir(sub: string): string {
	return join(process.env.JASPER_TEST_RESULTS || join(repoRoot(), 'test-results'), sub);
}
