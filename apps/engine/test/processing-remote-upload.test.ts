import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { SshRemote } from '../src/processing/remote.ts';
import { SSH_SHIM } from './ssh-shim.ts';

it('uploads a symlink source as file bytes without leaving a partial file', async () => {
	// Require the real rsync transfer: a fallback would not reproduce the library-alias regression.
	execFileSync('rsync', ['--version'], { stdio: 'ignore' });
	const root = mkdtempSync(join(tmpdir(), 'jasper-ssh-upload-'));
	try {
		const ssh = join(root, 'ssh');
		writeFileSync(ssh, SSH_SHIM, { mode: 0o755 });
		const bytes = Buffer.from('the selected library bytes\0\n');
		writeFileSync(join(root, 'libavcodec.so.61'), bytes);
		const source = join(root, 'libavcodec.so');
		symlinkSync('libavcodec.so.61', source);
		const remoteDir = join(root, 'remote');
		const remote = new SshRemote(
			{
				enabled: true,
				host: 'gpu-box.test',
				port: 22,
				user: 'jasper',
				identityFile: null,
				remoteDir,
				useFor: ['denoise'],
				strictHostKeyChecking: 'accept-new',
			},
			join(root, 'control'),
			{ JASPER_SSH: ssh, JASPER_RSYNC: 'rsync' },
		);
		const dest = join(remoteDir, 'ffmpeg', 'libavcodec.so');
		await remote.upload(source, dest);
		expect(readFileSync(dest)).toEqual(bytes);
		expect(existsSync(`${dest}.part`)).toBe(false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}, 30_000);
