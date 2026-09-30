// jasper-mg binary resolution and startup probe (ARCHITECTURE §10.2):
// JASPER_MG → native/mg/target/release/jasper-mg (dev checkout) → packaged resources/bin/jasper-mg.
import { execFile } from 'node:child_process';
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENV } from '@jasper/config';

export const MG_EXE = process.platform === 'win32' ? 'jasper-mg.exe' : 'jasper-mg';

export type MgBinaryResolution =
	| { path: string; source: 'env' | 'dev' | 'packaged' }
	| { path: null; reason: string; tried: string[] };

/** Walks up from `start` looking for a checkout containing native/mg/Cargo.toml. */
export function findRepoRoot(start: string, maxLevels = 8): string | null {
	let dir = resolve(start);
	for (let i = 0; i <= maxLevels; i++) {
		if (existsSync(join(dir, 'native', 'mg', 'Cargo.toml'))) return dir;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

function isExecutableFile(p: string): boolean {
	try {
		if (!statSync(p).isFile()) return false;
		if (process.platform !== 'win32') accessSync(p, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

export type ResolveMgOptions = {
	env?: Record<string, string | undefined>;
	/** Directories to search for a dev checkout (default: this module's dir and the cwd). */
	searchFrom?: string[];
	/** Electron `process.resourcesPath` (packaged builds ship `resources/bin/jasper-mg`). */
	resourcesPath?: string | null;
};

export function resolveMgBinary(opts: ResolveMgOptions = {}): MgBinaryResolution {
	const env = opts.env ?? process.env;
	const tried: string[] = [];
	const fromEnv = env[ENV.MG];
	if (fromEnv) {
		// An explicit JASPER_MG is authoritative: never silently fall back to another binary.
		if (isExecutableFile(fromEnv)) return { path: fromEnv, source: 'env' };
		return {
			path: null,
			reason: `${ENV.MG}=${fromEnv} is not an executable file`,
			tried: [fromEnv],
		};
	}
	const here = dirname(fileURLToPath(import.meta.url));
	const roots = new Set<string>();
	for (const start of opts.searchFrom ?? [here, process.cwd()]) {
		const root = findRepoRoot(start);
		if (root) roots.add(root);
	}
	for (const root of roots) {
		const candidate = join(root, 'native', 'mg', 'target', 'release', MG_EXE);
		tried.push(candidate);
		if (isExecutableFile(candidate)) return { path: candidate, source: 'dev' };
	}
	const resources =
		opts.resourcesPath ?? (process as unknown as { resourcesPath?: string }).resourcesPath ?? null;
	if (resources) {
		const candidate = join(resources, 'bin', MG_EXE);
		tried.push(candidate);
		if (isExecutableFile(candidate)) return { path: candidate, source: 'packaged' };
	}
	return {
		path: null,
		reason:
			roots.size > 0
				? 'jasper-mg is not built (run `pnpm mg:build`; needs cargo)'
				: `jasper-mg not found (set ${ENV.MG})`,
		tried,
	};
}

export type MgVersionInfo = {
	name: string;
	version: string;
	fframes: string;
	renderer: string;
	templates: string[];
};

export type MgNativeTemplate = {
	id: string;
	version: number;
	name: string;
	category: string;
	paramsSchema: Record<string, unknown>;
	defaults: Record<string, unknown>;
	introFrames: number;
	outroFrames: number;
	defaultDurationSeconds: number;
	canvases: string[];
};

export type MgProbe =
	| {
			status: 'ready';
			binary: string;
			source: 'env' | 'dev' | 'packaged';
			version: MgVersionInfo;
			templates: MgNativeTemplate[];
	  }
	| { status: 'unavailable'; reason: string; binary: string | null };

function run(file: string, args: string[], timeoutMs: number): Promise<string> {
	return new Promise((resolvePromise, reject) => {
		execFile(file, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
			if (err) reject(new Error(`${[file, ...args].join(' ')} failed: ${stderr?.trim() || err.message}`));
			else resolvePromise(stdout);
		});
	});
}

/** Runs `--version` and `schema`; any failure yields `unavailable` with a reason (never throws). */
export async function probeMgBinary(resolution: MgBinaryResolution, timeoutMs = 10_000): Promise<MgProbe> {
	if (resolution.path === null) return { status: 'unavailable', reason: resolution.reason, binary: null };
	const binary = resolution.path;
	try {
		const version = JSON.parse(await run(binary, ['--version'], timeoutMs)) as MgVersionInfo;
		if (version?.name !== 'jasper-mg' || typeof version.renderer !== 'string')
			throw new Error('unexpected --version output');
		const schema = JSON.parse(await run(binary, ['schema'], timeoutMs)) as { templates?: MgNativeTemplate[] };
		if (!Array.isArray(schema.templates) || schema.templates.length === 0)
			throw new Error('`schema` returned no templates');
		return { status: 'ready', binary, source: resolution.source, version, templates: schema.templates };
	} catch (e) {
		return { status: 'unavailable', reason: e instanceof Error ? e.message : String(e), binary };
	}
}
