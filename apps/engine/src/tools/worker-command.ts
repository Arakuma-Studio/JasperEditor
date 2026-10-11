import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { nodeExecPath } from './node-runtime.ts';

export type WorkerCommand = { command: string; args: string[] };

type WorkerEntry = {
	moduleUrl: string;
	envKey: string;
	bundle: string;
	source: string[];
};

export function workerBundle(entry: WorkerEntry, env: NodeJS.ProcessEnv): string | null {
	const explicit = env[entry.envKey];
	if (explicit && /\.m?js$/.test(explicit)) return existsSync(explicit) ? resolve(explicit) : null;
	const here = dirname(fileURLToPath(entry.moduleUrl));
	return [join(here, entry.bundle), join(here, '..', '..', 'dist', entry.bundle)].find(existsSync) ?? null;
}

export function workerCommand(entry: WorkerEntry, env: NodeJS.ProcessEnv): WorkerCommand {
	const here = dirname(fileURLToPath(entry.moduleUrl));
	const explicit = env[entry.envKey];
	const source = entry.source.map((path) => resolve(here, path)).find(existsSync);
	const tsx = (file: string): WorkerCommand => ({
		command: nodeExecPath(env),
		args: ['--import', pathToFileURL(createRequire(entry.moduleUrl).resolve('tsx/esm')).href, file],
	});
	if (explicit) {
		const file = resolve(explicit);
		if (!existsSync(file)) throw new Error(`${entry.envKey} worker entry does not exist: ${file}`);
		if (file.endsWith('.ts')) return tsx(file);
		if (/\.m?js$/.test(file)) return { command: nodeExecPath(env), args: [file] };
		throw new Error(`${entry.envKey} must name a .ts, .js or .mjs worker entry`);
	}
	if (source) return tsx(source);
	const bundle = workerBundle(entry, env);
	if (bundle) return { command: nodeExecPath(env), args: [bundle] };
	throw new Error(`${entry.bundle.replace(/\.mjs$/, '')} is not available (no bundle and no source)`);
}
