import { workerCommand } from '../tools/worker-command.ts';

export const CAMTRACK_BUNDLE = 'jasper-camtrack.mjs';
const entry = {
	moduleUrl: import.meta.url,
	envKey: 'JASPER_CAMTRACK',
	bundle: CAMTRACK_BUNDLE,
	source: ['worker/cli.ts', '../src/camtrack/worker/cli.ts'],
};

export function camtrackCommand(env: NodeJS.ProcessEnv = process.env) {
	return workerCommand(entry, env);
}
