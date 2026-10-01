// @vitest-environment node
// Web bundle chunking (ARCHITECTURE §13; S11:ANM-023: anime.js in `vendor-anime`) and the notices asset of the
// Vite build (S11:FIX-010).
import { describe, expect, it } from 'vitest';
import { NOTICES_FILE, vendorChunk } from '../vite.config.ts';

const nm = (pkg: string, file = 'dist/index.js') =>
	`/repo/node_modules/.pnpm/${pkg}@1.0.0/node_modules/${pkg}/${file}`;

describe('vendor chunks', () => {
	it('puts anime.js (every subpath) in vendor-anime', () => {
		for (const f of [
			'dist/modules/timeline/index.js',
			'dist/modules/utils/random.js',
			'dist/modules/svg/index.js',
		])
			expect(vendorChunk(nm('animejs', f))).toBe('vendor-anime');
		expect(vendorChunk('C:\\repo\\node_modules\\animejs\\dist\\modules\\index.js')).toBe('vendor-anime');
	});
	it('keeps the other vendor chunks and first-party code out of them', () => {
		expect(
			vendorChunk('/repo/node_modules/.pnpm/remotion@4.0.499/node_modules/remotion/dist/esm/index.mjs'),
		).toBe('vendor-remotion');
		expect(vendorChunk(nm('react-dom'))).toBe('vendor-react');
		expect(vendorChunk(nm('zod'))).toBe('vendor-state');
		expect(vendorChunk(nm('some-lib'))).toBe('vendor');
		expect(vendorChunk('/repo/packages/project/src/index.ts')).toBe('app-project');
		expect(vendorChunk('/repo/packages/motion/src/runtime/index.ts')).toBeUndefined();
		expect(vendorChunk('/repo/apps/web/src/main.tsx')).toBeUndefined();
	});
	it('ships the notices file under a fixed name', () => {
		expect(NOTICES_FILE).toBe('THIRD_PARTY_NOTICES.md');
	});
});
