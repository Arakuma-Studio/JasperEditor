import { workerBundle, workerCommand } from '../tools/worker-command.ts';

const PROC_BUNDLE = 'jasper-proc.mjs';
const entry = {
	moduleUrl: import.meta.url,
	envKey: 'JASPER_PROC',
	bundle: PROC_BUNDLE,
	source: ['proc/cli.ts', '../src/processing/proc/cli.ts'],
};

export function procCommand(env: NodeJS.ProcessEnv = process.env) {
	return workerCommand(entry, env);
}

export function procBundle(env: NodeJS.ProcessEnv = process.env): string | null {
	return workerBundle(entry, env);
}
