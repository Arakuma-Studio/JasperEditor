// Remotion project directories (S08:MGC-010): version pinning (D-19, exactly 4.0.499), the project's own
// `remotion bundle` CLI (its remotion.config.ts, Tailwind and webpack overrides apply), bundle-directory checks.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { MG_REMOTION_VERSION } from '@jasper/project';
import { terminateTree } from '../tools/process.ts';

export class MgBundleError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly status = 400,
		readonly detail?: unknown,
		/** Actionable next step for users and agents (S08:MGA-002). */
		readonly hint?: string,
	) {
		super(message);
		this.name = 'MgBundleError';
	}
}

export type ProjectPackage = {
	name: string;
	dependencies: Record<string, string>;
	jasper?: { schemas?: string };
};

const REMOTION_PACKAGES = /^(remotion|@remotion\/.+)$/;

/** Reads `<dir>/package.json` (MG_NOT_A_BUNDLE when missing or invalid). */
export async function readProjectPackage(dir: string): Promise<ProjectPackage> {
	let raw: Record<string, unknown>;
	try {
		raw = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as Record<string, unknown>;
	} catch {
		throw new MgBundleError(
			'MG_NOT_A_BUNDLE',
			`${dir} has no readable package.json: import a Remotion project folder or a built bundle (index.html + bundle.js)`,
		);
	}
	const deps = {
		...((raw.devDependencies as Record<string, string> | undefined) ?? {}),
		...((raw.dependencies as Record<string, string> | undefined) ?? {}),
	};
	const jasper =
		raw.jasper && typeof raw.jasper === 'object' ? (raw.jasper as { schemas?: string }) : undefined;
	return {
		name: typeof raw.name === 'string' && raw.name ? raw.name : basename(dir),
		dependencies: deps,
		...(jasper ? { jasper } : {}),
	};
}

const versionHint = (found: string) =>
	`The project uses remotion ${found}; JasperEditor needs ${MG_REMOTION_VERSION} — pin every remotion and @remotion/* package to "${MG_REMOTION_VERSION}" (no ^ or ~) in package.json and reinstall.`;

/**
 * Checks the Remotion pin (D-19): `remotion` (or `@remotion/cli`) must be declared, and every Remotion package
 * declared exactly `4.0.499`; the installed `remotion` must be 4.0.499 too. MG_REMOTION_VERSION otherwise.
 */
export async function checkRemotionVersion(dir: string, pkg: ProjectPackage): Promise<void> {
	const declared = Object.entries(pkg.dependencies).filter(([n]) => REMOTION_PACKAGES.test(n));
	if (!declared.some(([n]) => n === 'remotion' || n === '@remotion/cli'))
		throw new MgBundleError(
			'MG_NOT_A_BUNDLE',
			`${dir} is not a Remotion project (package.json has no remotion / @remotion/cli dependency)`,
		);
	for (const [name, spec] of declared) {
		const v = spec.trim().replace(/^=/, '');
		if (v !== MG_REMOTION_VERSION)
			throw new MgBundleError(
				'MG_REMOTION_VERSION',
				`${name} is "${spec}" in package.json; JasperEditor needs exactly ${MG_REMOTION_VERSION}`,
				422,
				{ package: name, found: spec, required: MG_REMOTION_VERSION },
				versionHint(spec),
			);
	}
	const installed = join(dir, 'node_modules', 'remotion', 'package.json');
	if (!existsSync(installed) || !existsSync(remotionBin(dir)))
		throw new MgBundleError(
			'MG_NOT_INSTALLED',
			`The project's dependencies are not installed (${dir}/node_modules)`,
			422,
			undefined,
			'Run `pnpm install` (or `npm install`) in the project folder, then import again.',
		);
	const version = (JSON.parse(await readFile(installed, 'utf8')) as { version?: string }).version ?? '?';
	if (version !== MG_REMOTION_VERSION)
		throw new MgBundleError(
			'MG_REMOTION_VERSION',
			`node_modules has remotion ${version}; JasperEditor needs ${MG_REMOTION_VERSION}`,
			422,
			{ package: 'remotion', found: version, required: MG_REMOTION_VERSION },
			versionHint(version),
		);
}

/** The project's `remotion` CLI launcher. */
export function remotionBin(dir: string): string {
	return join(dir, 'node_modules', '.bin', process.platform === 'win32' ? 'remotion.cmd' : 'remotion');
}

export const BUNDLE_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Runs `<dir>/node_modules/.bin/remotion bundle --out-dir <outDir>` with a timeout; the combined output is
 * written to `logFile`. MG_BUNDLE_FAILED (with the log tail) on failure.
 */
export async function bundleProject(
	dir: string,
	outDir: string,
	opts: {
		signal?: AbortSignal;
		logFile: string;
		timeoutMs?: number;
		env?: Record<string, string | undefined>;
		onLog?(line: string): void;
		onSpawn?(child: import('node:child_process').ChildProcess): void;
	},
): Promise<void> {
	const bin = remotionBin(dir);
	const args = ['bundle', '--out-dir', outDir, '--log=info'];
	const log: string[] = [];
	const child = spawn(bin, args, {
		cwd: dir,
		env: { ...process.env, ...(opts.env ?? {}), CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' },
		stdio: ['ignore', 'pipe', 'pipe'],
		shell: process.platform === 'win32',
		detached: process.platform !== 'win32',
	});
	opts.onSpawn?.(child);
	const onData = (b: Buffer) => {
		const text = b.toString('utf8');
		log.push(text);
		for (const line of text.split(/\r?\n/)) if (line.trim()) opts.onLog?.(line.trim());
	};
	child.stdout?.on('data', onData);
	child.stderr?.on('data', onData);
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		void terminateTree(child);
	}, opts.timeoutMs ?? BUNDLE_TIMEOUT_MS);
	const onAbort = () => void terminateTree(child);
	opts.signal?.addEventListener('abort', onAbort, { once: true });
	const code: number | null = await new Promise((resolve) => {
		child.once('error', (e) => {
			log.push(String(e));
			resolve(-1);
		});
		child.once('close', (c) => resolve(c));
	});
	clearTimeout(timer);
	opts.signal?.removeEventListener('abort', onAbort);
	const text = log.join('');
	await writeFile(opts.logFile, `$ ${bin} ${args.join(' ')}\n(cwd ${dir})\n\n${text}`).catch(() => undefined);
	if (opts.signal?.aborted) throw new MgBundleError('JOB_CANCELLED', 'Cancelled', 499);
	if (code !== 0 || !existsSync(join(outDir, 'index.html'))) {
		const tail = text.trim().split('\n').slice(-25).join('\n');
		throw new MgBundleError(
			'MG_BUNDLE_FAILED',
			timedOut
				? `remotion bundle timed out after ${Math.round((opts.timeoutMs ?? BUNDLE_TIMEOUT_MS) / 1000)} s`
				: `remotion bundle failed (exit ${code}): ${tail.slice(-1500)}`,
			422,
			{ log: opts.logFile },
			'Fix the error in the project (run `npx remotion bundle` there to reproduce), then import or rebuild again.',
		);
	}
}

/** A built bundle directory: `index.html` + `bundle.js` from Remotion's bundler. */
export async function isBuiltBundle(dir: string): Promise<boolean> {
	try {
		const s = await stat(join(dir, 'index.html'));
		if (!s.isFile()) return false;
		const html = await readFile(join(dir, 'index.html'), 'utf8');
		return /window\.siteVersion\s*=/.test(html) && existsSync(join(dir, 'bundle.js'));
	} catch {
		return false;
	}
}

/** `window.remotion_version` and `window.siteVersion` written into a bundle's index.html. */
export async function bundleVersions(dir: string): Promise<{ remotion: string | null; site: string | null }> {
	const html = await readFile(join(dir, 'index.html'), 'utf8').catch(() => '');
	return {
		remotion: /window\.remotion_version\s*=\s*['"]([^'"]+)['"]/.exec(html)?.[1] ?? null,
		site: /window\.siteVersion\s*=\s*['"]([^'"]+)['"]/.exec(html)?.[1] ?? null,
	};
}

/** MG_REMOTION_VERSION unless a built bundle was made by Remotion 4.0.499. */
export async function checkBundleVersion(dir: string): Promise<string> {
	const v = await bundleVersions(dir);
	if (v.remotion !== MG_REMOTION_VERSION)
		throw new MgBundleError(
			'MG_REMOTION_VERSION',
			`The bundle was built with remotion ${v.remotion ?? 'unknown'}; JasperEditor needs ${MG_REMOTION_VERSION}`,
			422,
			{ found: v.remotion, required: MG_REMOTION_VERSION },
			versionHint(v.remotion ?? 'unknown'),
		);
	return v.remotion;
}
