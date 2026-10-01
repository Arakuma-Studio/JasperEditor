// New composition project (S08:MGC-015, P1, local mode): copies the template into `<dir>/<name>`, installs its
// dependencies with pnpm (or npm) and hands the folder to the importer (which watches it).
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { terminateTree } from '../tools/process.ts';
import { MgBundleError } from './project.ts';
import { TEMPLATE_FILES } from './template/files.ts';

const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

function onPath(name: string): string | null {
	const exts = process.platform === 'win32' ? ['.cmd', '.exe', ''] : [''];
	for (const d of (process.env.PATH ?? '').split(delimiter))
		for (const e of exts) if (d && existsSync(join(d, name + e))) return join(d, name + e);
	return null;
}

/** Writes the template into `<parent>/<name>` (must not exist or be empty); optionally installs it. */
export async function scaffoldProject(
	parent: string,
	name: string,
	opts: { install: boolean },
): Promise<string> {
	if (!isAbsolute(parent)) throw new MgBundleError('BAD_REQUEST', 'dir must be an absolute path');
	const dir = join(parent, name);
	if (existsSync(dir) && (await readdir(dir)).length > 0)
		throw new MgBundleError('BAD_REQUEST', `${dir} already exists and is not empty`, 409);
	for (const [rel, content] of Object.entries(TEMPLATE_FILES)) {
		const file = join(dir, rel);
		await mkdir(dirname(file), { recursive: true });
		await writeFile(file, content.replaceAll('{{name}}', name));
	}
	if (opts.install) {
		const pm = onPath('pnpm') ?? onPath('npm');
		if (!pm)
			throw new MgBundleError(
				'MG_NOT_INSTALLED',
				`Created ${dir}, but neither pnpm nor npm was found to install it`,
				422,
				{ dir },
				`Run \`npm install\` in ${dir}, then import the folder.`,
			);
		const args = /pnpm/.test(pm) ? ['install', '--ignore-workspace'] : ['install', '--no-audit', '--no-fund'];
		const code = await new Promise<number | null>((resolve) => {
			const child = spawn(pm, args, {
				cwd: dir,
				env: { ...process.env, CI: '1' },
				stdio: 'ignore',
				shell: process.platform === 'win32',
			});
			const timer = setTimeout(() => void terminateTree(child), INSTALL_TIMEOUT_MS);
			child.once('error', () => resolve(-1));
			child.once('close', (c) => {
				clearTimeout(timer);
				resolve(c);
			});
		});
		if (code !== 0)
			throw new MgBundleError(
				'MG_NOT_INSTALLED',
				`Created ${dir}, but \`${args.join(' ')}\` failed (exit ${code})`,
				422,
				{ dir },
				`Run the install in ${dir} yourself, then import the folder.`,
			);
	}
	return dir;
}
