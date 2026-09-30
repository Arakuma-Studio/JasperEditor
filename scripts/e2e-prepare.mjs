#!/usr/bin/env node
// `pnpm e2e` pre-step (WP-3I): the E2E server runs the *built* engine and web app, so build both (unless
// E2E_SKIP_BUILD=1) and make sure the fixture media exist and are current.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const run = (cmd, args) => {
	const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit' });
	if (r.status !== 0) process.exit(r.status ?? 1);
};

// Creates missing fixtures and regenerates ones whose recipe changed (a no-op when they are current).
run('node', ['scripts/make-fixtures.mjs']);
if (process.env.E2E_SKIP_BUILD !== '1') {
	run('pnpm', ['--filter', '@jasper/engine', 'build']);
	run('pnpm', ['--filter', '@jasper/web', 'build']);
}
