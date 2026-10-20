import { workerCommand } from '../../tools/worker-command.ts';

export const CLAP_BUNDLE = 'jasper-clap.mjs';
const entry = {
	moduleUrl: import.meta.url,
	envKey: 'JASPER_CLAP',
	bundle: CLAP_BUNDLE,
	source: ['worker/cli.ts', '../src/sounds/semantic/worker/cli.ts'],
};

/** How to start the `jasper-clap` worker (WP-E9): its source under tsx in a checkout, else the bundle next to engine.mjs. */
export function clapCommand(env: NodeJS.ProcessEnv = process.env) {
	return workerCommand(entry, env);
}
