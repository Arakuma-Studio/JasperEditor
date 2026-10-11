import { rename, rm } from 'node:fs/promises';
import { atomicCopyFile } from '../tools/fs.ts';

export async function publishNormalizedAudio(source: string, destination: string): Promise<void> {
	try {
		await rename(source, destination);
	} catch (error) {
		if (!(error instanceof Error && 'code' in error && error.code === 'EXDEV')) throw error;
		await atomicCopyFile(source, destination);
		await rm(source, { force: true });
	}
}
