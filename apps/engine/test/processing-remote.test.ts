// SSH/SCP shims execute in a local temporary remote directory; JASPER_TEST_SSH also exercises a real SSH host.
// CUDA is unavailable in the fixture, so ONNX runs on the CPU.
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EngineJob, ProcessResult, RemoteProbeResult } from '@jasper/api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SshRemote } from '../src/processing/remote.ts';
import {
	closeApps,
	ensureFixtures,
	fixture,
	JSON_H,
	makeApp,
	register,
	type TestApp,
	until,
} from './helpers.ts';
import { SSH_SHIM } from './ssh-shim.ts';

const H = { host: '127.0.0.1:47900' };

/** scp shim: copies local ⇄ "remote" paths (user@host:/path → /path). */
const SCP_SHIM = `#!/usr/bin/env bash
args=(); skip=0
for a in "$@"; do
  if [ $skip = 1 ]; then skip=0; continue; fi
  case "$a" in -o|-P|-i|-F) skip=1;; -*) ;; *) args+=("\${a#*@*:}");; esac
done
exec cp "\${args[0]}" "\${args[1]}"
`;

let app: TestApp;
let remoteDir: string;
let shimDir: string;

function writeShim(name: string, text: string): string {
	const p = join(shimDir, name);
	writeFileSync(p, text);
	chmodSync(p, 0o755);
	return p;
}

async function waitJob(id: string, timeoutMs = 300_000): Promise<EngineJob> {
	return until(
		async () => {
			const j = (await app.inject({ method: 'GET', url: `/api/jobs/${id}`, headers: H })).json() as EngineJob;
			return ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(j.state) ? j : null;
		},
		timeoutMs,
		200,
	);
}

async function expectProcessedArtifact(result: ProcessResult) {
	const artifact = await app.inject({
		method: 'GET',
		url: `/media/${result.registered.mediaKey}`,
		headers: { ...H, range: 'bytes=0-31' },
	});
	expect(artifact.statusCode).toBe(206);
	expect(artifact.rawPayload.subarray(4, 8).toString()).toBe('ftyp');
}

async function putRemote() {
	const r = await app.inject({
		method: 'PUT',
		url: '/api/settings/processing',
		headers: JSON_H,
		payload: {
			remote: {
				enabled: true,
				host: 'gpu-box.test',
				port: 22,
				user: 'jasper',
				identityFile: null,
				remoteDir,
				useFor: ['denoise', 'upscale'],
				strictHostKeyChecking: 'accept-new',
			},
		},
	});
	expect(r.statusCode).toBe(200);
}

beforeAll(async () => {
	ensureFixtures();
	shimDir = mkdtempSync(join(tmpdir(), 'jasper-ssh-shim-'));
	remoteDir = mkdtempSync(join(tmpdir(), 'jasper-remote-'));
	process.env.JASPER_SSH = writeShim('ssh', SSH_SHIM);
	process.env.JASPER_SCP = writeShim('scp', SCP_SHIM);
	// The shimmed "remote" is this machine: skip npm install; the runtime resolves onnxruntime-node lazily.
	process.env.JASPER_REMOTE_NPM = 'true';
	app = await makeApp({ totalSlots: 8 });
}, 60_000);

afterAll(async () => {
	for (const k of ['JASPER_SSH', 'JASPER_SCP', 'JASPER_RSYNC', 'JASPER_REMOTE_NPM']) delete process.env[k];
	await closeApps();
	if (shimDir) rmSync(shimDir, { recursive: true, force: true });
	if (remoteDir) rmSync(remoteDir, { recursive: true, force: true });
});

describe('remote executor (shims)', () => {
	it('probe before setup reports the runtime is not installed', async () => {
		await putRemote();
		const r = await app.inject({ method: 'POST', url: '/api/processing/remote/probe', headers: H });
		expect(r.statusCode).toBe(200);
		const p = r.json() as RemoteProbeResult;
		expect(p.node).toMatch(/^v\d+/);
		expect(p.runtimeReady).toBe(false);
		expect(p.ok).toBe(false);
	});

	it('setup installs an executable runtime that the probe reports ready', async () => {
		const r = await app.inject({ method: 'POST', url: '/api/processing/remote/setup', headers: H });
		expect(r.statusCode).toBe(200);
		const job = await waitJob((r.json() as EngineJob).id);
		expect(job.error).toBeUndefined();
		expect(job.state).toBe('succeeded');
		const p = (
			await app.inject({ method: 'POST', url: '/api/processing/remote/probe', headers: H })
		).json() as RemoteProbeResult;
		expect(p.runtimeReady).toBe(true);
		expect(p.ok).toBe(true);
		const caps = (await app.inject({ method: 'GET', url: '/api/capabilities', headers: H })).json();
		expect(caps.features.processing.remote.configured).toBe(true);
		expect(caps.features.processing.remote.lastProbe.ok).toBe(true);
	}, 300_000);

	it('auto executor runs remotely; the input is cached by fingerprint; the job dir is removed', async () => {
		const m = await register(app, fixture('clip-b.mp4'));
		const r = await app.inject({
			method: 'POST',
			url: `/api/media/${m.mediaKey}/process`,
			headers: JSON_H,
			payload: { steps: [{ op: 'denoise', method: 'fftdnoiz', strength: 0.2 }], executor: 'auto' },
		});
		const job = await waitJob((r.json() as EngineJob).id);
		expect(job.error).toBeUndefined();
		const res = job.result as ProcessResult;
		expect(res.executor).toBe('remote');
		expect(readdirSync(join(remoteDir, 'jobs'))).toEqual([]);
		const cache = readdirSync(join(remoteDir, 'cache'));
		expect(cache).toHaveLength(1);
		expect(readFileSync(join(remoteDir, 'cache', cache[0])).equals(readFileSync(fixture('clip-b.mp4')))).toBe(
			true,
		);
		await expectProcessedArtifact(res);
		const r2 = await app.inject({
			method: 'POST',
			url: `/api/media/${m.mediaKey}/process`,
			headers: JSON_H,
			payload: { steps: [{ op: 'deblock', filter: 'strong' }], executor: 'remote' },
		});
		const job2 = await waitJob((r2.json() as EngineJob).id);
		expect(job2.error).toBeUndefined();
		expect(readdirSync(join(remoteDir, 'cache'))).toEqual(cache);
		await expectProcessedArtifact(job2.result as ProcessResult);
	}, 300_000);

	it('an interrupted upload retries to the exact source bytes without leaving a partial file', async () => {
		const big = join(shimDir, 'big.bin');
		writeFileSync(big, Buffer.alloc(24 * 1024 * 1024, 7));
		const slow = writeShim('rsync-slow', '#!/usr/bin/env bash\nexec rsync --bwlimit=4000 "$@"\n');
		const settings = JSON.parse(readFileSync(join(app.appdir, 'engine', 'engine.json'), 'utf8')).processing
			.remote;
		const slowRemote = new SshRemote(settings, join(app.appdir, 'tmp', 'ssh'), {
			...process.env,
			JASPER_RSYNC: slow,
		});
		const dest = join(remoteDir, 'cache', 'resume-test.bin');
		const ac = new AbortController();
		const first = slowRemote.upload(big, dest, { signal: ac.signal });
		await until(() => existsSync(`${dest}.part`) && statSync(`${dest}.part`).size > 0, 20_000, 20);
		ac.abort();
		await expect(first).rejects.toMatchObject({ code: 'CANCELLED' });
		const partial = statSync(`${dest}.part`).size;
		expect(partial).toBeGreaterThan(0);
		expect(partial).toBeLessThan(24 * 1024 * 1024);
		const fast = new SshRemote(settings, join(app.appdir, 'tmp', 'ssh'), process.env);
		await fast.upload(big, dest);
		expect(statSync(dest).size).toBe(24 * 1024 * 1024);
		expect(readFileSync(dest).equals(readFileSync(big))).toBe(true);
		expect(existsSync(`${dest}.part`)).toBe(false);
	}, 120_000);

	it('cancel kills the remote process group and leaves no job directory', async () => {
		const m = await register(app, fixture('clip-a.mp4'));
		const r = await app.inject({
			method: 'POST',
			url: `/api/media/${m.mediaKey}/process`,
			headers: JSON_H,
			payload: { steps: [{ op: 'denoise', method: 'nlmeans', strength: 1 }], executor: 'remote' },
		});
		const id = (r.json() as EngineJob).id;
		const pidFile = join(remoteDir, 'jobs', id, 'pid');
		await until(() => existsSync(pidFile), 60_000, 50);
		const pid = Number(readFileSync(pidFile, 'utf8').trim());
		// jasper-proc is running remotely once it reported its start event (stage "Remote · Processing N frames").
		const running = await until(
			async () => {
				const j = (
					await app.inject({ method: 'GET', url: `/api/jobs/${id}`, headers: H })
				).json() as EngineJob;
				return /Processing|Step/.test(j.stage ?? '') || j.state !== 'running' ? j : null;
			},
			60_000,
			100,
		);
		expect(running.error).toBeUndefined();
		expect(running.state).toBe('running');
		await app.inject({ method: 'POST', url: `/api/jobs/${id}/cancel`, headers: H });
		const done = await waitJob(id, 30_000);
		expect(done.state).toBe('cancelled');
		await until(() => !existsSync(join(remoteDir, 'jobs', id)), 20_000, 100);
		let alive = true;
		try {
			process.kill(pid, 0);
		} catch {
			alive = false;
		}
		expect(alive).toBe(false);
	}, 180_000);

	it('a broken connection fails with REMOTE_CONNECTION_LOST (retryable), never falls back to local', async () => {
		const dead = writeShim(
			'ssh-dead',
			'#!/usr/bin/env bash\necho "ssh: connect to host gpu-box.test port 22: Connection refused" >&2\nexit 255\n',
		);
		const saved = process.env.JASPER_SSH;
		process.env.JASPER_SSH = dead;
		try {
			const m = await register(app, fixture('clip-b.mp4'));
			const r = await app.inject({
				method: 'POST',
				url: `/api/media/${m.mediaKey}/process`,
				headers: JSON_H,
				payload: { steps: [{ op: 'deblock', filter: 'weak', block: 16 }], executor: 'remote' },
			});
			const job = await waitJob((r.json() as EngineJob).id);
			expect(job.state).toBe('failed');
			expect(job.error?.code).toBe('REMOTE_CONNECTION_LOST');
			expect(job.error?.retryable).toBe(true);
		} finally {
			process.env.JASPER_SSH = saved;
		}
	}, 60_000);
});

const REAL = process.env.JASPER_TEST_SSH;
describe.skipIf(!REAL)('remote executor over real SSH (JASPER_TEST_SSH)', () => {
	it('probe, setup, process, cleanup', async () => {
		const [userHost, port] = (REAL as string).split(/:(?=\d+$)/);
		const [user, host] = userHost.split('@');
		const saved = { ssh: process.env.JASPER_SSH, scp: process.env.JASPER_SCP };
		delete process.env.JASPER_SSH;
		delete process.env.JASPER_SCP;
		const dir = `/tmp/jasper-remote-real-${Date.now()}`;
		try {
			const put = await app.inject({
				method: 'PUT',
				url: '/api/settings/processing',
				headers: JSON_H,
				payload: {
					remote: {
						enabled: true,
						host,
						port: Number(port ?? 22),
						user,
						identityFile: process.env.JASPER_TEST_SSH_KEY ?? null,
						remoteDir: dir,
						useFor: ['denoise'],
						strictHostKeyChecking: 'accept-new',
					},
				},
			});
			expect(put.statusCode).toBe(200);
			const setup = await app.inject({ method: 'POST', url: '/api/processing/remote/setup', headers: H });
			const sj = await waitJob((setup.json() as EngineJob).id, 600_000);
			expect(sj.error).toBeUndefined();
			const m = await register(app, fixture('clip-b.mp4'));
			const r = await app.inject({
				method: 'POST',
				url: `/api/media/${m.mediaKey}/process`,
				headers: JSON_H,
				payload: { steps: [{ op: 'denoise', method: 'atadenoise', strength: 0.3 }], executor: 'remote' },
			});
			const job = await waitJob((r.json() as EngineJob).id);
			expect(job.error).toBeUndefined();
			expect((job.result as ProcessResult).executor).toBe('remote');
			await expectProcessedArtifact(job.result as ProcessResult);
		} finally {
			process.env.JASPER_SSH = saved.ssh;
			process.env.JASPER_SCP = saved.scp;
		}
	}, 900_000);
});
