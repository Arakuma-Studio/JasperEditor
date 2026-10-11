import { existsSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { RegisteredMediaSchema } from '@jasper/api';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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
}, 180_000); // a clean checkout generates the fixture media first (ffmpeg, ~10–30 s)
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

		const early = await app.inject({ method: 'POST', url: `/api/uploads/${uploadId}/complete`, headers: H });
		expect(early.statusCode).toBe(409);
		expect(early.json().code).toBe('UPLOAD_SIZE_MISMATCH');

		expect((await put(uploadId, c1.length, c2)).json()).toEqual({ offset: c1.length + c2.length });
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
		expect(media.locators).toEqual([expect.objectContaining({ type: 'engine-store', key: media.mediaKey })]);
		const stored = join(app.appdir, 'media', media.mediaKey, 'clip-b.mp4');
		expect(readFileSync(stored).equals(bytes)).toBe(true);
		const status = (
			await app.inject({ method: 'GET', url: `/api/media/${media.mediaKey}`, headers: H })
		).json();
		for (const kind of ['keyframes', 'peaks', 'poster', 'sprite']) {
			expect(status.derivatives[kind].state).not.toBe('none');
		}
		expect((await put(uploadId, bytes.length, Buffer.alloc(1))).statusCode).toBe(404);
		const served = await app.inject({
			method: 'GET',
			url: `/media/${media.mediaKey}`,
			headers: { ...H, range: 'bytes=0-7' },
		});
		expect(served.statusCode).toBe(206);
		expect(served.rawPayload.equals(bytes.subarray(0, 8))).toBe(true);
	});

	it('aborts an upload session', async () => {
		const created = (
			await app.inject({
				method: 'POST',
				url: '/api/uploads',
				headers: JSON_H,
				payload: {
					projectId: 'prj_0000000000000001',
					fileName: 'aborted.mp4',
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
	});

	it('refuses to recreate missing upload data as an empty file', async () => {
		const dir = join(tempAppdir('jasper-up-'), '.uploads');
		const svc = new UploadService({ dir, media: coreServices(app).media });
		const session = await svc.create({
			projectId: 'prj_0000000000000001',
			fileName: 'missing.mp4',
			byteSize: 10,
			mimeType: 'video/mp4',
		});
		unlinkSync(join(dir, session.uploadId, 'data.part'));
		await expect(svc.complete(session.uploadId)).rejects.toMatchObject({
			code: 'UPLOAD_NOT_FOUND',
			message: expect.stringContaining('start a new upload'),
		});
	});

	it('reports background sweep errors and starts only one sweep timer', async () => {
		vi.useFakeTimers();
		const error = new Error('Cannot remove expired upload');
		const onError = vi.fn();
		const svc = new UploadService({
			dir: join(tempAppdir('jasper-up-'), '.uploads'),
			media: coreServices(app).media,
			onError,
		});
		const sweep = vi.spyOn(svc, 'sweep').mockRejectedValue(error);
		try {
			svc.start();
			svc.start();
			await vi.advanceTimersByTimeAsync(0);
			expect(sweep).toHaveBeenCalledTimes(1);
			expect(onError).toHaveBeenLastCalledWith(error);
			await vi.advanceTimersByTimeAsync(3600_000);
			expect(sweep).toHaveBeenCalledTimes(2);
			svc.stop();
			svc.start();
			await vi.advanceTimersByTimeAsync(0);
			expect(sweep).toHaveBeenCalledTimes(3);
		} finally {
			svc.stop();
			vi.useRealTimers();
		}
	});

	it('checks free disk space (DISK_FULL) and expires idle sessions after 24 h (S04:SC-005)', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date('2026-09-30T10:00:00Z'));
		const dir = join(tempAppdir('jasper-up-'), '.uploads');
		const svc = new UploadService({
			dir,
			media: coreServices(app).media,
		});
		try {
			await expect(
				svc.create({
					projectId: 'prj_0000000000000001',
					fileName: 'huge.mp4',
					byteSize: Number.MAX_SAFE_INTEGER,
					mimeType: 'video/mp4',
				}),
			).rejects.toMatchObject({ code: 'DISK_FULL' });
			expect(readdirSync(dir)).toEqual([]);
			const s = await svc.create({
				projectId: 'prj_0000000000000001',
				fileName: 'x.mp4',
				byteSize: 10,
				mimeType: 'video/mp4',
			});
			expect(existsSync(join(dir, s.uploadId))).toBe(true);
			vi.setSystemTime(new Date('2026-10-01T11:00:00Z'));
			expect(await svc.sweep()).toBe(1);
			expect(existsSync(join(dir, s.uploadId))).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});
});
