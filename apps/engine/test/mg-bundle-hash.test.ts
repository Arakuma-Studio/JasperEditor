import { mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { hashBundleDir } from '../src/mg-bundles/hash.ts';

vi.mock('node:fs/promises', async (importOriginal) => {
	const fs = await importOriginal<typeof import('node:fs/promises')>();
	return { ...fs, stat: vi.fn(fs.stat) };
});

const dirs: string[] = [];
afterEach(async () => {
	vi.mocked(stat).mockClear();
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

async function bundle(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'jasper-bundle-hash-'));
	dirs.push(dir);
	await writeFile(join(dir, 'bundle.js'), 'export const value = 1;');
	return dir;
}

it('reports a filesystem failure instead of hashing an incomplete bundle', async () => {
	const dir = await bundle();
	const error = Object.assign(new Error('permission denied'), { code: 'EACCES' });
	vi.mocked(stat).mockRejectedValueOnce(error);
	await expect(hashBundleDir(dir)).rejects.toBe(error);
});

it('ignores dangling links without omitting readable bundle files', async () => {
	const dir = await bundle();
	const before = await hashBundleDir(dir);
	await symlink(join(dir, 'missing'), join(dir, 'dangling'));
	await expect(hashBundleDir(dir)).resolves.toEqual(before);
	expect(before.files).toBe(1);
});
