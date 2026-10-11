import { workerCommand } from '../tools/worker-command.ts';

export const SPEECH_BUNDLE = 'jasper-speech.mjs';
const entry = {
	moduleUrl: import.meta.url,
	envKey: 'JASPER_SPEECH',
	bundle: SPEECH_BUNDLE,
	source: ['worker/cli.ts', '../src/speech/worker/cli.ts'],
};

export function speechCommand(env: NodeJS.ProcessEnv = process.env) {
	return workerCommand(entry, env);
}
