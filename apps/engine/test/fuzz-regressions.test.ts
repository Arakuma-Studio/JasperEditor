// Regressions for the bugs the engine fuzzing found (golden-fuzz).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { writeStoredZip } from '../src/imports/zip.ts';
import { mapProbe } from '../src/media/probe.ts';
import { extractZip, ZipError } from '../src/mg-bundles/zip.ts';
import { ToolError } from '../src/tools/process.ts';

const dir = mkdtempSync(join(tmpdir(), 'engine-fuzz-reg-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('mg-bundle zip reader', () => {
	it('an entry size or offset past the end of the file is a ZipError (it aborted the process natively)', async () => {
		const zip = writeStoredZip([{ name: 'a.txt', data: Buffer.from('hello world') }]);
		const cd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
		const huge = Buffer.from(zip);
		huge.writeUInt32LE(0x7fffffff, cd + 20); // compressed size
		const f = join(dir, 'huge.zip');
		writeFileSync(f, huge);
		await expect(extractZip(f, join(dir, 'out1'))).rejects.toThrow(ZipError);
		const far = Buffer.from(zip);
		far.writeUInt32LE(0xfffffff0, cd + 42); // local header offset
		writeFileSync(f, far);
		await expect(extractZip(f, join(dir, 'out2'))).rejects.toThrow(ZipError);
	});

	it('corrupt deflate data and NUL bytes in names are ZipErrors', async () => {
		const zip = writeStoredZip([{ name: 'bun.js', data: Buffer.from('x') }]);
		const nul = Buffer.from(zip);
		const at = nul.lastIndexOf(Buffer.from('bun.js'));
		nul[at + 3] = 0;
		const f = join(dir, 'nul.zip');
		writeFileSync(f, nul);
		await expect(extractZip(f, join(dir, 'out3'))).rejects.toThrow(ZipError);
	});
});

describe('ffprobe JSON mapping', () => {
	const ok = {
		streams: [
			{ index: 0, codec_type: 'video', codec_name: 'h264', width: 64, height: 36, r_frame_rate: '25/1' },
		],
		format: { format_name: 'mov,mp4', duration: '2.0' },
	};
	it('wrong-typed fields are dropped instead of crashing; absurd values are ignored', () => {
		const r = mapProbe({
			streams: [
				{
					...ok.streams[0],
					r_frame_rate: 25,
					tags: 'x',
					side_data_list: { rotation: 90 },
					bits_per_raw_sample: '1e308',
					duration: '1e300',
				},
				{ index: -3, codec_type: 'audio', codec_name: 'aac', sample_rate: 48000, channels: '2' },
				7,
			],
			format: { format_name: ['x'], duration: 9 },
		});
		expect(r.hasVideo && r.hasAudio).toBe(true);
		expect(r.probe.streams[0]).toMatchObject({ bitDepth: 8 });
		expect(r.probe.streams[1]).toMatchObject({ index: 1 });
		expect(r.durationSec).toBe(9);
	});
	it('no usable stream is UNSUPPORTED_MEDIA', () => {
		for (const bad of [null, 1, 'x', { streams: 'no' }, { streams: [{ codec_type: 5 }] }])
			expect(() => mapProbe(bad)).toThrow(ToolError);
	});
});
