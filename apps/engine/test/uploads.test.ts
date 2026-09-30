// Resumable chunked uploads (S04:IN-005, SC-005).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RegisteredMediaSchema } from '@jasper/api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fingerprintFile } from '../src/media/fingerprint.ts';
import { coreServices } from '../src/tools/services.ts';
import { UploadService } from '../src/uploads/service.ts';
import {
	closeApps,
	ensureFixtures,
	fixture,
	H,
	JSON_H,
	makeApp,
	type TestApp,
	tempAppdir,
} from './helpers.ts';

let app: TestApp;
beforeAll(async () => {
	ensureFixtures();
	app = await makeApp();
});
afterAll(closeApps);

const put = (uploadId: string, offset: number, chunk: Buffer) =>
	app.inject({
		method: 'PUT',
		url: `/api/uploads/${uploadId}?offset=${offset}`,
		headers: { ...H, 'content-type': 'application/octet-stream' },
		payload: chunk,
	});

describe('uploads (S04:IN-005)', () => {
	it('uploads clip-b in 3 chunks, rejects a wrong offset with the expected one, and registers the media', async () => {
		const bytes = readFileSync(fixture('clip-b.mp4'));
		const created = await app.inject({
			method: 'POST',
			url: '/api/uploads',
			headers: JSON_H,
			payload: {
				projectId: 'prj_0000000000000001',
				fileName: 'clip-b.mp4',
				byteSize: bytes.length,
				mimeType: 'video/mp4',
			},
		});
		expect(created.statusCode).toBe(201);
		const { uploadId, chunkSize, offset } = created.json();
		expect(uploadId).toMatch(/^up_[0-9a-f]{24}$/);
		expect(chunkSize).toBe(8 * 1024 * 1024);
		expect(offset).toBe(0);

		const third = Math.ceil(bytes.length / 3);
		const c1 = bytes.subarray(0, third);
		const c2 = bytes.subarray(third, 2 * third);
		const c3 = bytes.subarray(2 * third);

		const r1 = await put(uploadId, 0, c1);
		expect(r1.statusCode).toBe(200);
		expect(r1.json()).toEqual({ offset: c1.length });

		// Wrong offset (a replayed chunk): 409 with the engine's offset (S04:IN-005, QA-011 tampering).
		const wrong = await put(uploadId, 0, c1);
		expect(wrong.statusCode).toBe(409);
		expect(wrong.json()).toMatchObject({
			code: 'UPLOAD_OFFSET_MISMATCH',
			detail: { expectedOffset: c1.length },
		});
		const ahead = await put(uploadId, c1.length + 5, c2);
		expect(ahead.json()).toMatchObject({
			code: 'UPLOAD_OFFSET_MISMATCH',
			detail: { expectedOffset: c1.length },
		});

		// Completing early fails with the size mismatch.
		const early = await app.inject({ method: 'POST', url: `/api/uploads/${uploadId}/complete`, headers: H });
		expect(early.statusCode).toBe(409);
		expect(early.json().code).toBe('UPLOAD_SIZE_MISMATCH');

		expect((await put(uploadId, c1.length, c2)).json()).toEqual({ offset: c1.length + c2.length });
		// A chunk larger than the declared size is refused and the file rolled back.
		const tooBig = await put(uploadId, c1.length + c2.length, Buffer.concat([c3, Buffer.alloc(10)]));
		expect(tooBig.statusCode).toBe(400);
		expect(tooBig.json().code).toBe('UPLOAD_SIZE_MISMATCH');
		expect((await put(uploadId, c1.length + c2.length, c3)).json()).toEqual({ offset: bytes.length });

		const done = await app.inject({ method: 'POST', url: `/api/uploads/${uploadId}/complete`, headers: H });
		expect(done.statusCode).toBe(200);
		const media = RegisteredMediaSchema.parse(done.json());
		expect(media).toMatchObject({
			originalName: 'clip-b.mp4',
			sizeBytes: bytes.length,
			kind: 'video',
			browserPlayable: 'yes',
		});
		expect(media.fingerprint).toBe((await fingerprintFile(fixture('clip-b.mp4'))).fingerprint);
		expect(media.locators).toEqual([expect.objectContaining({ type: 'engine-store', key: media.mediaKey })]);
		const stored = join(app.appdir, 'media', media.mediaKey, 'clip-b.mp4');
		expect(readFileSync(stored).equals(bytes)).toBe(true);
		// Derivatives were queued automatically (S04:IN-011).
		const jobs = coreServices(app)
			.queue.list()
			.filter((j) => j.assetId === media.mediaKey);
		expect(jobs.map((j) => j.kind).sort()).toEqual(
			expect.arrayContaining(['keyframes', 'peaks', 'poster', 'sprite']),
		);
		// The session is gone.
		expect((await put(uploadId, bytes.length, Buffer.alloc(1))).statusCode).toBe(404);
		// The upload is served like any media.
		const served = await app.inject({
			method: 'GET',
			url: `/media/${media.mediaKey}`,
			headers: { ...H, range: 'bytes=0-7' },
		});
		expect(served.statusCode).toBe(206);
		expect(served.rawPayload.equals(bytes.subarray(0, 8))).toBe(true);
	});

	it('aborts sessions and validates ids', async () => {
		const created = (
			await app.inject({
				method: 'POST',
				url: '/api/uploads',
				headers: JSON_H,
				payload: {
					projectId: 'prj_0000000000000001',
					fileName: '../../evil.mp4',
					byteSize: 10,
					mimeType: 'video/mp4',
				},
			})
		).json();
		expect(
			(await app.inject({ method: 'DELETE', url: `/api/uploads/${created.uploadId}`, headers: H })).json(),
		).toEqual({ ok: true });
		expect(
			(await app.inject({ method: 'DELETE', url: `/api/uploads/${created.uploadId}`, headers: H }))
				.statusCode,
		).toBe(404);
		expect((await app.inject({ method: 'DELETE', url: '/api/uploads/..%2F..', headers: H })).statusCode).toBe(
			404,
		);
	});

	it('checks free disk space (DISK_FULL) and expires idle sessions after 24 h (S04:SC-005)', async () => {
		let now = Date.now();
		const dir = join(tempAppdir('jasper-up-'), '.uploads');
		const svc = new UploadService({
			dir,
			media: coreServices(app).media,
			now: () => now,
			freeBytes: async () => 1024,
		});
		await expect(
			svc.create({
				projectId: 'prj_0000000000000001',
				fileName: 'x.mp4',
				byteSize: 10_000,
				mimeType: 'video/mp4',
			}),
		).rejects.toMatchObject({ code: 'DISK_FULL' });
		const svc2 = new UploadService({
			dir,
			media: coreServices(app).media,
			now: () => now,
			freeBytes: async () => null,
		});
		const s = await svc2.create({
			projectId: 'prj_0000000000000001',
			fileName: 'x.mp4',
			byteSize: 10,
			mimeType: 'video/mp4',
		});
		expect(existsSync(join(dir, s.uploadId))).toBe(true);
		now += 25 * 3600 * 1000;
		expect(await svc2.sweep()).toBe(1);
		expect(existsSync(join(dir, s.uploadId))).toBe(false);
	});
});
