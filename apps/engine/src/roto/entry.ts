// Where the jasper-roto CLI is (parity roto): JASPER_ROTO (a .ts or .mjs path), the bundle next to the engine
// bundle (dist/jasper-roto.mjs, packaged resources), or the TypeScript source run through tsx (checkout, tests).
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROTO_ENV = 'JASPER_ROTO';
export const ROTO_BUNDLE = 'jasper-roto.mjs';
const here = dirname(fileURLToPath(import.meta.url));

function sourceEntry(): string | null {
	const candidates = [join(here, 'worker', 'cli.ts'), join(here, '..', 'src', 'roto', 'worker', 'cli.ts')];
	return candidates.find((c) => existsSync(c)) ?? null;
}

function bundle(env: Record<string, string | undefined>): string | null {
	const explicit = env[ROTO_ENV];
	if (explicit && /\.m?js$/.test(explicit)) return existsSync(explicit) ? resolve(explicit) : null;
	for (const c of [join(here, ROTO_BUNDLE), join(here, '..', '..', 'dist', ROTO_BUNDLE)])
		if (existsSync(c)) return c;
	return null;
}

/** How to start jasper-roto with `node`: the source in a checkout (always current), else the bundle. */
export function rotoCommand(env: Record<string, string | undefined> = process.env): {
	command: string;
	args: string[];
} {
	const explicit = env[ROTO_ENV];
	if (explicit?.endsWith('.ts')) return tsx(resolve(explicit));
	const src = sourceEntry();
	if (src && !explicit) return tsx(src);
	const b = bundle(env);
	if (b) return { command: process.execPath, args: [b] };
	if (src) return tsx(src);
	throw new Error('jasper-roto is not available (no bundle and no source)');
}

function tsx(entry: string): { command: string; args: string[] } {
	const req = createRequire(join(here, 'x.js'));
	let loader: string;
	try {
		loader = pathToFileURL(req.resolve('tsx/esm')).href;
	} catch {
		loader = 'tsx/esm';
	}
	return { command: process.execPath, args: ['--import', loader, entry] };
}
