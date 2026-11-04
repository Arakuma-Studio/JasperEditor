import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, onTestFinished } from 'vitest';
import { procCommand } from '../src/processing/proc-entry.ts';

it.skipIf(process.platform === 'win32')(
	'cancels a processor whose detached FFmpeg ignores SIGTERM',
	async () => {
		const dir = mkdtempSync(join(tmpdir(), 'jasper-proc-cancel-'));
		const tool = join(dir, 'ffmpeg.mjs');
		const pidFile = join(dir, 'ffmpeg.pid');
		const output = join(dir, 'out.mov');
		const specFile = join(dir, 'spec.json');
		writeFileSync(
			tool,
			`#!${process.execPath}
import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('-show_streams')) {
  console.log(JSON.stringify({ streams: [{ codec_type: 'video', width: 4, height: 4, r_frame_rate: '30/1', nb_frames: '1', pix_fmt: 'rgb48le' }] }));
} else if (args.includes('-filters')) {
  console.log(' ... null V->V');
} else {
  process.on('SIGTERM', () => {});
  writeFileSync(${JSON.stringify(output)}, 'partial');
  writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
  process.stdout.write('frame=1\\n');
  setInterval(() => {}, 1000);
}
`,
			{ mode: 0o755 },
		);
		writeFileSync(
			specFile,
			JSON.stringify({
				input: join(dir, 'input.mov'),
				output,
				steps: [{ op: 'deblock', filter: 'weak' }],
				ffmpeg: tool,
				ffprobe: tool,
				scratch: dir,
			}),
		);
		const command = procCommand();
		const child = spawn(command.command, [...command.args, 'run', '--spec', specFile], {
			stdio: ['ignore', 'ignore', 'pipe'],
			detached: true,
		});
		let cleaned = false;
		const cleanup = async () => {
			if (cleaned) return;
			cleaned = true;
			const exited =
				child.pid && child.exitCode === null && child.signalCode === null ? once(child, 'exit') : undefined;
			child.kill('SIGKILL');
			if (existsSync(pidFile)) {
				try {
					process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL');
				} catch {
					// The processor already reaped its child.
				}
			}
			await exited;
			rmSync(dir, { recursive: true, force: true });
		};
		onTestFinished(cleanup);
		try {
			await new Promise<void>((resolve, reject) => {
				let stderr = '';
				child.stderr.on('data', (chunk: Buffer) => {
					stderr += chunk.toString();
					if (stderr.includes('"event":"progress"')) resolve();
				});
				child.once('error', reject);
				child.once('exit', (code) =>
					reject(new Error(`processor exited before processing (${code}): ${stderr}`)),
				);
			});
			const exited = once(child, 'exit');
			child.kill('SIGTERM');
			const [code] = await exited;
			expect(code).toBe(3);
			expect(existsSync(output)).toBe(false);
			expect(() => process.kill(Number(readFileSync(pidFile, 'utf8')), 0)).toThrow('ESRCH');
		} finally {
			await cleanup();
		}
	},
	30_000,
);
