import { describe, expect, it } from 'vitest';
import { fixtureH264Args } from './fixture-encoding.mjs';

describe('fixture H.264 encoding', () => {
	it('uses OpenH264 in LGPL-only mode even when x264 is available', () => {
		expect(fixtureH264Args(' V..... libx264\n V..... libopenh264', true)).toContain('libopenh264');
	});

	it('uses either supported encoder in development', () => {
		expect(fixtureH264Args(' V..... libx264\n V..... libopenh264', false)).toContain('libx264');
		expect(fixtureH264Args(' V..... libopenh264', false)).toContain('libopenh264');
	});

	it('refuses missing or disallowed encoders before generating any media', () => {
		expect(() => fixtureH264Args(' V..... libx264', true)).toThrow(/needs libopenh264/);
		expect(() => fixtureH264Args(' V..... h264_nvenc', false)).toThrow(/set JASPER_FFMPEG/);
		expect(() => fixtureH264Args(' V..... libx264rgb', false)).toThrow(/set JASPER_FFMPEG/);
	});
});
