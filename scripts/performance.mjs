#!/usr/bin/env node
// Run synthetic hot-path benchmarks sequentially to avoid competing with one another.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
for (const benchmark of [
	'packages/project/bench/render-snapshot.ts',
	'packages/project/bench/scene-props.ts',
	'packages/session/bench/selection.ts',
	'apps/web/bench/timeline-transitions.ts',
	'apps/engine/bench/cache-references.ts',
]) {
	console.log(`\n${benchmark}`);
	const result = spawnSync(process.execPath, ['--import', 'tsx', benchmark], {
		cwd: root,
		stdio: 'inherit',
	});
	if (result.error) throw result.error;
	if (result.status !== 0) process.exit(result.status ?? 1);
}
