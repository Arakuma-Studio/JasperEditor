// WP-3I export file-name contract.
import { describe, expect, it } from 'vitest';
import { sanitizeFileName } from '../src/export/settings.ts';

describe('export file names', () => {
	it('drops a typed .mp4 extension (the export adds it) and keeps other names', () => {
		expect(sanitizeFileName('smoke.mp4')).toBe('smoke');
		expect(sanitizeFileName('Final Cut.MP4 ')).toBe('Final Cut');
		expect(sanitizeFileName('a/b:c')).toBe('a_b_c');
		expect(sanitizeFileName('.mp4')).toBe('Export');
		expect(sanitizeFileName('clip.mov')).toBe('clip.mov');
	});
});
