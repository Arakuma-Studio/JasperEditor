// Where the jasper-proc CLI is (S07:PRC-011): JASPER_PROC, the bundle next to the engine bundle
// (dist/jasper-proc.mjs, packaged resources), or the TypeScript source run through tsx (dev, tests).
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { nodeExecPath } from '../tools/node-runtime.ts';

const PROC_ENV = 'JASPER_PROC';
const PROC_BUNDLE = 'jasper-proc.mjs';

const here = dirname(fileURLToPath(import.meta.url));

type ProcCommand = { command: string; args: string[] };

/** The source entry (checkout only). */
function procSourceEntry(): string | null {
	const candidates = [join(here, 'proc', 'cli.ts'), join(here, '..', 'src', 'processing', 'proc', 'cli.ts')];
	return candidates.find((c) => existsSync(c)) ?? null;
}

/** The built bundle, if any: env, next to this module (engine bundle), apps/engine/dist. */
export function procBundle(env: Record<string, string | undefined> = process.env): string | null {
	const explicit = env[PROC_ENV];
	if (explicit && /\.m?js$/.test(explicit)) return existsSync(explicit) ? resolve(explicit) : null;
	for (const c of [join(here, PROC_BUNDLE), join(here, '..', '..', 'dist', PROC_BUNDLE)])
		if (existsSync(c)) return c;
	return null;
}

/** How to start jasper-proc with `node`. Prefers the source in a checkout (always current), then the bundle. */
export function procCommand(env: Record<string, string | undefined> = process.env): ProcCommand {
	const explicit = env[PROC_ENV];
	if (explicit?.endsWith('.ts')) return tsxCommand(resolve(explicit));
	const src = procSourceEntry();
	if (src && !explicit) return tsxCommand(src);
	const bundle = procBundle(env);
	if (bundle) return { command: nodeExecPath(env), args: [bundle] };
	if (src) return tsxCommand(src);
	throw new Error('jasper-proc is not available (no bundle and no source)');
}

function tsxCommand(entry: string): ProcCommand {
	const req = createRequire(join(here, 'x.js'));
	let loader: string;
	try {
		loader = pathToFileURL(req.resolve('tsx/esm')).href;
	} catch {
		loader = 'tsx/esm';
	}
	return { command: nodeExecPath(), args: ['--import', loader, entry] };
}
