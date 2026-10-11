import { workerCommand } from '../tools/worker-command.ts';

export const ROTO_BUNDLE = 'jasper-roto.mjs';
const entry = {
	moduleUrl: import.meta.url,
	envKey: 'JASPER_ROTO',
	bundle: ROTO_BUNDLE,
	source: ['worker/cli.ts', '../src/roto/worker/cli.ts'],
};

export function rotoCommand(env: NodeJS.ProcessEnv = process.env) {
	return workerCommand(entry, env);
}
