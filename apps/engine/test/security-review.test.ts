// Regressions of the adversarial security review (docs/security-review.md). One `it` per confirmed finding.
import { existsSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ModelStore } from '../src/processing/models.ts';
import { SpeechModelStore } from '../src/speech/models.ts';
import { closeApps, H, makeApp, register, tempAppdir } from './helpers.ts';

/** An HTTP server whose every response is an endless body (stops after 256 MiB); counts the bytes it wrote. */
async function endlessServer(): Promise<{ url: string; sent: () => number; close: () => Promise<void> }> {
	let sent = 0;
	const chunk = Buffer.alloc(64 * 1024, 7);
	const server: Server = createHttpServer((_req, res) => {
		res.writeHead(200, { 'content-type': 'application/octet-stream' });
		const pump = () => {
			while (sent < 256 * 1024 * 1024) {
				sent += chunk.length;
				if (!res.write(chunk)) return void res.once('drain', pump);
			}
			res.end();
		};
		res.on('close', () => res.removeAllListeners('drain'));
		pump();
	});
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}/model.onnx`,
		sent: () => sent,
		close: () =>
			new Promise<void>((r) => {
				server.closeAllConnections();
				server.close(() => r());
			}),
	};
}

afterEach(async () => {
	await closeApps();
});

describe('ENG-1: served user content never runs script with the engine origin', () => {
	it('an imported SVG is served sandboxed and nosniff', async () => {
		const app = await makeApp();
		const dir = tempAppdir('jasper-svg-');
		const svg = join(dir, 'evil.svg');
		writeFileSync(
			svg,
			'<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>fetch("/api/projects")</script><rect width="10" height="10"/></svg>',
		);
		const reg = await register(app, svg);
		const r = await app.inject({ method: 'GET', url: `/media/${reg.mediaKey}`, headers: H });
		expect(r.statusCode).toBe(200);
		expect(r.headers['content-type']).toMatch(/svg/);
		expect(r.headers['x-content-type-options']).toBe('nosniff');
		expect(String(r.headers['content-security-policy'])).toMatch(/(^|;\s*)sandbox(;|$)/);
	});
});

describe('ENG-2: model downloads stop at the catalogue size', () => {
	it('processing models', async () => {
		const srv = await endlessServer();
		try {
			const dir = tempAppdir('jasper-models-');
			const store = new ModelStore({
				modelsDir: dir,
				bundledDir: dir,
				entries: [
					{
						id: 'm',
						name: 'M',
						architecture: 'x',
						scale: 2,
						file: 'm.onnx',
						license: 'MIT',
						attribution: null,
						sourceUrl: srv.url,
						downloadUrl: srv.url,
						sha256: '0'.repeat(64),
						sizeBytes: 100_000,
					},
				],
			});
			await expect(store.install('m')).rejects.toMatchObject({ code: 'MODEL_CHECKSUM' });
			expect(srv.sent()).toBeLessThan(32 * 1024 * 1024);
			expect(existsSync(join(dir, 'm.onnx'))).toBe(false);
			expect(existsSync(join(dir, 'm.onnx.partial'))).toBe(false);
		} finally {
			await srv.close();
		}
	});

	it('speech (and roto) models', async () => {
		const srv = await endlessServer();
		try {
			const dir = tempAppdir('jasper-speech-models-');
			const store = new SpeechModelStore(dir, [
				{
					id: 's',
					name: 'S',
					parameters: 1,
					multilingual: false,
					description: '',
					license: 'MIT',
					licenseUrl: '',
					attribution: '',
					sourceUrl: srv.url,
					upstreamUrl: srv.url,
					revision: 'r',
					files: [{ path: 'model.onnx', url: srv.url, sha256: '0'.repeat(64), sizeBytes: 100_000 }],
				},
			]);
			await expect(store.install('s')).rejects.toMatchObject({ code: 'SPEECH_MODEL_CHECKSUM' });
			expect(srv.sent()).toBeLessThan(32 * 1024 * 1024);
			expect(existsSync(join(dir, 's', 'model.onnx'))).toBe(false);
		} finally {
			await srv.close();
		}
	});
});
