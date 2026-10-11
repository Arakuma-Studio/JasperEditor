import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { atomicCopyFile, atomicWriteFile, readJsonOrNull } from '../src/tools/fs.ts';
import { tempAppdir } from './temp.ts';

vi.mock('node:fs/promises', async (importOriginal) => {
	const original = await importOriginal<typeof import('node:fs/promises')>();
	return { ...original, readFile: vi.fn(original.readFile), open: vi.fn(original.open) };
});
const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');

afterEach(() => {
	vi.restoreAllMocks();
	vi.mocked(fs.open).mockImplementation(actual.open);
	vi.mocked(fs.readFile).mockImplementation(actual.readFile);
});

function ioError(code: string): NodeJS.ErrnoException {
	return Object.assign(new Error(code), { code });
}

describe('JSON reads', () => {
	it('reads valid JSON and treats absent or malformed files as unavailable', async () => {
		const file = join(tempAppdir('jasper-json-'), 'metadata.json');
		expect(await readJsonOrNull(file)).toBeNull();
		await fs.writeFile(file, '{');
		expect(await readJsonOrNull(file)).toBeNull();
		await fs.writeFile(file, '{"value":3}');
		expect(await readJsonOrNull(file)).toEqual({ value: 3 });
	});

	it.each(['EACCES', 'EIO', 'ENOSPC'])('propagates %s instead of presenting missing data', async (code) => {
		const error = ioError(code);
		vi.mocked(fs.readFile).mockRejectedValueOnce(error);
		await expect(readJsonOrNull('metadata.json')).rejects.toBe(error);
	});

	it('round-trips arbitrary JSON values', async () => {
		await fc.assert(
			fc.asyncProperty(fc.jsonValue(), async (value) => {
				vi.mocked(fs.readFile).mockResolvedValueOnce(JSON.stringify(value));
				expect(await readJsonOrNull('metadata.json')).toEqual(value);
			}),
			{ numRuns: 50 },
		);
	});
});

describe('directory durability', () => {
	it.each(['EIO', 'ENOSPC'])('reports %s after an atomic rename', async (code) => {
		const dir = tempAppdir('jasper-durability-');
		const file = join(dir, 'metadata.json');
		const error = ioError(code);
		vi.mocked(fs.open).mockImplementation(async (...args) => {
			const handle = await actual.open(...args);
			if (args[0] === dir) vi.spyOn(handle, 'sync').mockRejectedValueOnce(error);
			return handle;
		});
		await expect(atomicWriteFile(file, 'complete')).rejects.toBe(error);
		expect(await fs.readFile(file, 'utf8')).toBe('complete');
		const copy = join(dir, 'copy.json');
		await expect(atomicCopyFile(file, copy)).rejects.toBe(error);
		expect(await fs.readFile(copy, 'utf8')).toBe('complete');
	});

	it('supports filesystems that reject directory fsync', async () => {
		const dir = tempAppdir('jasper-durability-');
		vi.mocked(fs.open).mockImplementation(async (...args) => {
			const handle = await actual.open(...args);
			if (args[0] === dir) vi.spyOn(handle, 'sync').mockRejectedValueOnce(ioError('EINVAL'));
			return handle;
		});
		const file = join(dir, 'metadata.json');
		await atomicWriteFile(file, 'complete');
		expect(await fs.readFile(file, 'utf8')).toBe('complete');
	});
});
