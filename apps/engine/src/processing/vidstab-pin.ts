// The pinned post-relicense vid.stab commit (mirror of scripts/ffmpeg/manifest.json `vidstab`, checked by
// test/processing-*.test.ts). The engine only uses FFmpeg's vid.stab filters when the FFmpeg directory's
// BUILDINFO.json records exactly this commit (S07:PST-003); the WASM module is built from it too.
export const VIDSTAB_PIN = {
	commit: 'e2445c4081658318223762a696eb1c645c2d7168',
	date: '2026-08-14T20:12:27Z',
	version: '1.4.0',
	license: 'LGPL-2.1-or-later',
	repository: 'https://github.com/georgmartius/vid.stab',
	relicenseRecord:
		'https://github.com/georgmartius/vid.stab/blob/e2445c4081658318223762a696eb1c645c2d7168/RELICENSE.md',
	relicenseIssue: 'https://github.com/georgmartius/vid.stab/issues/165',
} as const;
