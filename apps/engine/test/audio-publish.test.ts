import { copyFile, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { publishNormalizedAudio } from '../src/audio/publish.ts';

vi.mock('node:fs/promises', async (importOriginal) => {
	const fs = await importOriginal<typeof import('node:fs/promises')>();
	return { ...fs, rename: vi.fn(fs.rename), copyFile: vi.fn(fs.copyFile) };
});

const dirs: string[] = [];
afterEach(async () => {
	vi.mocked(rename).mockClear();
	vi.mocked(copyFile).mockClear();
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

async function files(): Promise<{ source: string; destination: string }> {
	const dir = await mkdtemp(join(tmpdir(), 'jasper-audio-publish-'));
	dirs.push(dir);
	const source = join(dir, 'normalized.wav');
	const destination = join(dir, 'published.wav');
	await writeFile(source, 'complete audio');
	await writeFile(destination, 'previous audio');
	return { source, destination };
}

it('preserves existing audio if a cross-device copy runs out of disk space', async () => {
	const { source, destination } = await files();
	vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error('cross-device'), { code: 'EXDEV' }));
	const error = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
	vi.mocked(copyFile).mockImplementationOnce(async (_source, target) => {
		await writeFile(target, 'incomplete audio');
		throw error;
	});
	await expect(publishNormalizedAudio(source, destination)).rejects.toBe(error);
	expect(await readFile(destination, 'utf8')).toBe('previous audio');
	expect(await readFile(source, 'utf8')).toBe('complete audio');
});

it('reports a rename permission failure and preserves both files', async () => {
	const { source, destination } = await files();
	const error = Object.assign(new Error('permission denied'), { code: 'EACCES' });
	vi.mocked(rename).mockRejectedValueOnce(error);
	await expect(publishNormalizedAudio(source, destination)).rejects.toBe(error);
	expect(await readFile(destination, 'utf8')).toBe('previous audio');
	expect(await readFile(source, 'utf8')).toBe('complete audio');
});

it('publishes the complete audio across filesystems and removes its scratch file', async () => {
	const { source, destination } = await files();
	vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error('cross-device'), { code: 'EXDEV' }));
	await publishNormalizedAudio(source, destination);
	expect(await readFile(destination, 'utf8')).toBe('complete audio');
	await expect(readFile(source)).rejects.toMatchObject({ code: 'ENOENT' });
});
