// Link Media (docs/wp-notes/link-media.md §2): foreign absolute paths stay absolute, and relative references are kept
// as the media's project-relative path.
import { describe, expect, it } from 'vitest';
import { readDocument, toJasper } from '../src/index.ts';
import { fileUrlToPath, isAbsolutePath, relativeReference, resolvePath } from '../src/paths.ts';
import { Report } from '../src/report.ts';

const edl = (files: string[]) =>
	[
		'TITLE: Moved',
		'FCM: NON-DROP FRAME',
		'',
		...files.flatMap((f, i) => [
			`00${i + 1}  AX       V     C        01:00:00:00 01:00:01:00 01:00:0${i}:00 01:00:0${i + 1}:00`,
			`* FROM CLIP NAME: ${f.split(/[\\/]/).pop()}`,
			`* SOURCE FILE: ${f}`,
			'',
		]),
	].join('\n');

function placeholders(text: string, baseDir?: string) {
	const { project, report } = readDocument(new TextEncoder().encode(text), {
		fileName: 'Moved.edl',
		rate: { num: 25, den: 1 },
		...(baseDir ? { baseDir } : {}),
	});
	const frag = toJasper(
		project,
		{ assets: {}, notFound: new Set(Object.keys(project.media)), now: 'now' },
		report,
	);
	return Object.values(frag.media).map((m) => m.locators.find((l) => l.type === 'path'));
}

describe('media references from other computers', () => {
	it('Windows and UNC references stay absolute paths (never joined to the import folder)', () => {
		const locs = placeholders(
			edl(['D:\\JasperDev\\short hackers\\TV.mp4', '\\\\nas\\media\\b.mov']),
			'/Users/me/Edits',
		);
		expect(locs.map((l) => l && 'path' in l && l.path).sort()).toEqual([
			'D:\\JasperDev\\short hackers\\TV.mp4',
			'\\\\nas\\media\\b.mov',
		]);
		expect(locs.every((l) => l && 'relativeToProject' in l && l.relativeToProject === null)).toBe(true);
	});

	it('a relative reference is resolved against the import folder and kept as the project-relative path', () => {
		const locs = placeholders(edl(['Footage/a.mov', '..\\Audio\\b.wav']), '/Users/me/Edits');
		const byRel = Object.fromEntries(
			locs.map((l) => [(l as { relativeToProject: string }).relativeToProject, (l as { path: string }).path]),
		);
		expect(byRel).toEqual({
			'Footage/a.mov': '/Users/me/Edits/Footage/a.mov',
			'..\\Audio\\b.wav': '/Users/me/Audio/b.wav',
		});
	});

	it('file URLs of Windows drives decode to drive paths; relative references are recognised', () => {
		expect(fileUrlToPath('file://localhost/D%3a/JasperDev/a%20b.mp4')).toBe('D:/JasperDev/a b.mp4');
		expect(isAbsolutePath('D:/JasperDev/a b.mp4')).toBe(true);
		expect(resolvePath('file://localhost/D%3a/x.mp4', '/base')).toBe('D:/x.mp4');
		expect(relativeReference('Footage/a.mov')).toBe('Footage/a.mov');
		expect(relativeReference('..\\a.mov')).toBe('..\\a.mov');
		expect(relativeReference('/abs/a.mov')).toBeNull();
		expect(relativeReference('file:///D:/a.mov')).toBeNull();
		expect(relativeReference('https://example.com/a.mov')).toBeNull();
		expect(relativeReference('')).toBeNull();
		expect(new Report().entries).toEqual([]);
	});
});
