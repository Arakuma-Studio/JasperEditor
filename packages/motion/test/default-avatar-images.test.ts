// social-comment §7.8: the platforms' remote default avatars are images of the remote-asset manifest; the manifest
// entries (served by the engine, `imageUrls`) and the glyph module's records describe the same files.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REMOTE_IMAGE_IDS } from '@jasper/mg-templates';
import { describe, expect, it } from 'vitest';
import { PLATFORM_DEFAULT_AVATARS } from '../src/templates/social/glyphs.ts';

const manifest = JSON.parse(
	readFileSync(
		join(dirname(fileURLToPath(import.meta.url)), '../../../apps/engine/src/remote-assets/manifest.json'),
		'utf8',
	),
) as {
	images?: { id: string; url: string; sha256: string; format: string; width?: number; height?: number }[];
};

describe('default avatar images', () => {
	it('match the glyph module records (url, sha256, format, size)', () => {
		const ids = {
			x: REMOTE_IMAGE_IDS.xDefaultAvatar,
			youtube: REMOTE_IMAGE_IDS.youtubeDefaultAvatar,
		} as const;
		for (const [platform, id] of Object.entries(ids)) {
			const rec = PLATFORM_DEFAULT_AVATARS[platform as keyof typeof ids];
			expect(rec.kind).toBe('remote');
			if (rec.kind !== 'remote') continue;
			const entry = manifest.images?.find((i) => i.id === id);
			expect(entry, id).toMatchObject({
				url: rec.image.url,
				sha256: rec.image.sha256,
				format: rec.image.format,
				width: rec.image.width,
				height: rec.image.height,
			});
		}
	});
});
