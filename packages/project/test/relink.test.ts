// Link Media path model and Relink-others planning (docs/wp-notes/link-media.md).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	applyMapping,
	applyRelinkTransaction,
	classifyPath,
	decideCandidates,
	deriveMapping,
	deriveRelativeBase,
	displayPath,
	fileExtensionOf,
	fileStemOf,
	formatPath,
	isForeignPath,
	isHostAbsolute,
	type MediaAsset,
	parsePath,
	pathBaseName,
	planContext,
	plannedSteps,
	relinkMediaCommand,
	resetInterpretationCommand,
	resolveRelative,
	timecodeAlignmentApplies,
} from '../src/index.ts';
import { Harness, videoAsset } from './helpers.ts';

// Names that are valid on every system (no separators, no `.`/`..`, no drive-like `X:` prefix).
const name = fc
	.string({ minLength: 1, maxLength: 12, unit: fc.constantFrom(...'abcXYZ019 _-()[]éñ⬜️'.split('')) })
	.filter((s) => s.trim() === s && s !== '.' && s !== '..');
const names = fc.array(name, { minLength: 1, maxLength: 6 });
const drive = fc.constantFrom('C', 'D', 'e', 'Z');

describe('path classification', () => {
	it('recognises Windows drive, UNC and POSIX paths as absolute, and others as relative', () => {
		expect(classifyPath('D:\\Videos\\a.mp4')).toBe('windows');
		expect(classifyPath('d:/Videos/a.mp4')).toBe('windows');
		expect(classifyPath('\\\\nas\\share\\a.mov')).toBe('unc');
		expect(classifyPath('//nas/share/a.mov')).toBe('unc');
		expect(classifyPath('/Volumes/Mac/a.mov')).toBe('posix');
		expect(classifyPath('..\\..\\Cosas\\a.mp4')).toBe('relative');
		expect(classifyPath('D:a.mp4')).toBe('relative'); // drive-relative: not a usable location
		expect(classifyPath('a.mp4')).toBe('relative');
		expect(classifyPath('')).toBe('relative');
	});

	it('a Windows path is foreign on a POSIX engine and a POSIX path is foreign on a Windows engine', () => {
		expect(isForeignPath('D:\\a.mp4', 'posix')).toBe(true);
		expect(isForeignPath('\\\\nas\\s\\a.mp4', 'posix')).toBe(true);
		expect(isHostAbsolute('D:\\a.mp4', 'posix')).toBe(false);
		expect(isHostAbsolute('/a.mp4', 'posix')).toBe(true);
		expect(isForeignPath('/Volumes/a.mp4', 'win32')).toBe(true);
		expect(isHostAbsolute('D:\\a.mp4', 'win32')).toBe(true);
		expect(isForeignPath('rel/a.mp4', 'posix')).toBe(false);
		expect(isHostAbsolute('rel/a.mp4', 'win32')).toBe(false);
	});

	it('property: drive paths with either separator are windows, keep their names and are never relative', () => {
		fc.assert(
			fc.property(drive, names, fc.constantFrom('\\', '/'), (d, segs, sep) => {
				const p = `${d}:${sep}${segs.join(sep)}`;
				const parsed = parsePath(p);
				expect(parsed.style).toBe('windows');
				expect(parsed.root).toBe(`${d.toUpperCase()}:`);
				expect(parsed.segments).toEqual(segs);
				expect(isForeignPath(p, 'posix')).toBe(true);
				expect(isHostAbsolute(p, 'win32')).toBe(true);
				// formatting is stable and round-trips
				expect(parsePath(formatPath(parsed))).toEqual(parsed);
				expect(displayPath(displayPath(p))).toBe(displayPath(p));
			}),
		);
	});

	it('property: UNC paths keep server and share as the root', () => {
		fc.assert(
			fc.property(name, name, names, fc.constantFrom('\\', '/'), (srv, share, segs, sep) => {
				const p = `${sep}${sep}${srv}${sep}${share}${sep}${segs.join(sep)}`;
				const parsed = parsePath(p);
				expect(parsed.style).toBe('unc');
				expect(parsed.root).toBe(`\\\\${srv}\\${share}`);
				expect(parsed.segments).toEqual(segs);
				expect(isForeignPath(p, 'posix')).toBe(true);
				expect(parsePath(formatPath(parsed))).toEqual(parsed);
			}),
		);
	});

	it('property: POSIX paths split on "/" only (a backslash is a file-name character there)', () => {
		fc.assert(
			fc.property(names, (segs) => {
				const withBackslash = [...segs.slice(0, -1), `${segs[segs.length - 1]}\\x`];
				const p = `/${withBackslash.join('/')}`;
				const parsed = parsePath(p);
				expect(parsed.style).toBe('posix');
				expect(parsed.segments).toEqual(withBackslash);
				expect(isHostAbsolute(p, 'posix')).toBe(true);
				expect(isForeignPath(p, 'win32')).toBe(true);
			}),
		);
	});

	it('property: parsing never throws and is bounded on arbitrary input', () => {
		fc.assert(
			fc.property(fc.string({ maxLength: 300 }), (s) => {
				const p = parsePath(s);
				expect(['posix', 'windows', 'unc', 'relative']).toContain(p.style);
				expect(p.segments.every((x) => x !== '' && x !== '.')).toBe(true);
				// `..` survives only at the start of relative paths
				if (p.style !== 'relative') expect(p.segments).not.toContain('..');
			}),
			{ numRuns: 500, examples: [['/../a']] },
		);
		expect(parsePath(`/${'a/'.repeat(100_000)}`).segments.length).toBeLessThanOrEqual(4097);
	});

	it('dot segments: `..` above a root stays at the root; relative keeps leading `..`', () => {
		expect(parsePath('D:\\a\\..\\..\\b.mov').segments).toEqual(['b.mov']);
		expect(parsePath('..\\..\\Cosas\\.\\a.mp4').segments).toEqual(['..', '..', 'Cosas', 'a.mp4']);
		expect(formatPath(parsePath('/a/./b//c'))).toBe('/a/b/c');
	});

	it('file names, stems and extensions', () => {
		expect(pathBaseName('D:\\Assets\\avatar\\Happy.png')).toBe('Happy.png');
		expect(pathBaseName('/Volumes/x/clip.MOV')).toBe('clip.MOV');
		expect(fileStemOf('a.b.mov')).toBe('a.b');
		expect(fileStemOf('.hidden')).toBe('.hidden');
		expect(fileExtensionOf('A.MP4')).toBe('mp4');
		expect(fileExtensionOf('noext')).toBe('');
	});
});

describe('path mapping from a located file', () => {
	it('aligns the old and new parent folders on their longest common suffix', () => {
		const m = deriveMapping(
			'D:\\Videos\\Short A\\TV static.mp4',
			'/Volumes/Mac/Videos/Short A/TV static.mp4',
		)!;
		expect(applyMapping(m, 'D:\\Assets\\avatar\\Happy.png')).toBe('/Volumes/Mac/Assets/avatar/Happy.png');
		// another drive is not under the mapping
		expect(applyMapping(m, 'E:\\Cosas\\a.png')).toBeNull();
	});

	it('compares names without case and after Unicode normalisation', () => {
		const m = deriveMapping('D:\\MEDIA\\Cafe\u0301\\a.mov', '/Volumes/X/media/Café/a.mov')!;
		expect(applyMapping(m, 'd:\\Media\\other\\b.mov')).toBe('/Volumes/X/Media/other/b.mov');
	});

	it('a file located in a different folder structure maps its whole old folder', () => {
		const m = deriveMapping('D:\\Proj\\Footage\\a.mov', '/Users/me/Downloads/a.mov')!;
		expect(applyMapping(m, 'D:\\Proj\\Footage\\b.mov')).toBe('/Users/me/Downloads/b.mov');
		expect(applyMapping(m, 'D:\\Proj\\Footage\\sub\\c.mov')).toBe('/Users/me/Downloads/sub/c.mov');
		expect(applyMapping(m, 'D:\\Proj\\Audio\\d.wav')).toBeNull();
	});

	it('UNC and POSIX sources map too; nothing moved means no mapping', () => {
		const u = deriveMapping('\\\\nas\\media\\day1\\a.mov', '/mnt/nas/media/day1/a.mov')!;
		expect(applyMapping(u, '\\\\NAS\\media\\day2\\b.mov')).toBe('/mnt/nas/media/day2/b.mov');
		const p = deriveMapping('/Volumes/Old/Proj/a.mov', '/Volumes/New/Proj/a.mov')!;
		expect(applyMapping(p, '/Volumes/Old/Other/b.mov')).toBe('/Volumes/New/Other/b.mov');
		expect(deriveMapping('/a/b/c.mov', '/a/b/c.mov')).toBeNull();
		expect(deriveMapping('rel/c.mov', '/a/c.mov')).toBeNull();
	});

	it('property: the located file maps onto its own new path, and siblings land next to it', () => {
		fc.assert(
			fc.property(drive, names, names, names, name, name, (d, oldRoot, shared, newRoot, file, sib) => {
				const oldP = `${d}:\\${[...oldRoot, ...shared, file].join('\\')}`;
				const newP = `/${[...newRoot, ...shared, file].join('/')}`;
				const m = deriveMapping(oldP, newP);
				if (!m) return;
				expect(applyMapping(m, oldP)).toBe(newP);
				expect(applyMapping(m, `${d}:\\${[...oldRoot, ...shared, sib].join('\\')}`)).toBe(
					`/${[...newRoot, ...shared, sib].join('/')}`,
				);
			}),
		);
	});
});

describe('project-relative paths', () => {
	it('derives where the relative base is from the located file and resolves the others', () => {
		const b = deriveRelativeBase(
			'..\\..\\Assets\\Premiere Project\\Backgrounds\\vhs.mp4',
			'/Volumes/Mac/Assets/Premiere Project/Backgrounds/vhs.mp4',
		)!;
		expect(formatPath(b.base)).toBe('/Volumes/Mac');
		expect(resolveRelative(b, '..\\..\\music\\theme.mp3')).toBe('/Volumes/Mac/music/theme.mp3');
		// three levels up: one above the base
		expect(resolveRelative(b, '..\\..\\..\\x.mp3')).toBe('/Volumes/x.mp3');
		// fewer `..` than the located file needs the project folder's own name: not resolvable here
		expect(resolveRelative(b, 'Footage\\a.mov')).toBeNull();
		// the relative path does not end the new path: no base
		expect(deriveRelativeBase('..\\Other\\vhs.mp4', '/Volumes/Mac/Backgrounds/vhs.mp4')).toBeNull();
	});
});

describe('candidate ordering', () => {
	it('mapping, relative path, same folder, then the bounded search', () => {
		const ctx = planContext([
			{
				from: 'D:\\Videos\\Short A\\TV.mp4',
				to: '/Volumes/Mac/Videos/Short A/TV.mp4',
				relativePath: 'TV.mp4',
			},
		]);
		const steps = plannedSteps(
			{
				name: 'Happy.png',
				oldPath: 'D:\\Videos\\Short A\\avatar\\Happy.png',
				relativePath: 'avatar\\Happy.png',
			},
			ctx,
		);
		expect(steps.map((s) => s.step)).toEqual(['mapping', 'relative', 'same-folder', 'search']);
		expect(steps[0]).toEqual({
			step: 'mapping',
			paths: ['/Volumes/Mac/Videos/Short A/avatar/Happy.png'],
		});
		expect(steps[1]).toEqual({
			step: 'relative',
			paths: ['/Volumes/Mac/Videos/Short A/avatar/Happy.png'],
		});
		expect(steps[2]).toEqual({
			step: 'same-folder',
			folders: ['/Volumes/Mac/Videos/Short A'],
			name: 'Happy.png',
		});
	});

	it('the most specific mapping comes first; later anchors win ties', () => {
		const ctx = planContext([
			{ from: 'D:\\A\\x.mov', to: '/new1/A/x.mov' },
			{ from: 'D:\\A\\B\\y.mov', to: '/elsewhere/y.mov' },
		]);
		const steps = plannedSteps({ name: 'z.mov', oldPath: 'D:\\A\\B\\z.mov', relativePath: null }, ctx);
		expect(steps[0]).toEqual({ step: 'mapping', paths: ['/elsewhere/z.mov', '/new1/A/B/z.mov'] });
	});

	it('an asset without an old path still gets the same-folder check and the search by its name', () => {
		const ctx = planContext([{ from: 'D:\\A\\x.mov', to: '/n/A/x.mov' }]);
		expect(
			plannedSteps({ name: 'Clip 1.mov', oldPath: null, relativePath: null }, ctx).map((s) => s.step),
		).toEqual(['same-folder', 'search']);
		expect(plannedSteps({ name: 'Clip 1.mov', oldPath: null, relativePath: null }, planContext([]))).toEqual(
			[],
		);
	});
});

describe('candidate decisions', () => {
	it('one verified file links; several are ambiguous unless exactly one is the same content', () => {
		expect(decideCandidates([])).toEqual({ kind: 'none' });
		expect(decideCandidates([{ path: '/a', ok: false, sameContent: false }])).toEqual({ kind: 'none' });
		expect(
			decideCandidates([
				{ path: '/a', ok: true, sameContent: false },
				{ path: '/b', ok: false, sameContent: true },
			]),
		).toEqual({ kind: 'link', path: '/a' });
		expect(
			decideCandidates([
				{ path: '/a', ok: true, sameContent: false },
				{ path: '/b', ok: true, sameContent: false },
			]),
		).toEqual({ kind: 'ambiguous', paths: ['/a', '/b'] });
		expect(
			decideCandidates([
				{ path: '/a', ok: true, sameContent: false },
				{ path: '/b', ok: true, sameContent: true },
			]),
		).toEqual({ kind: 'link', path: '/b' });
		// the same path twice is one candidate
		expect(
			decideCandidates([
				{ path: '/a', ok: true, sameContent: false },
				{ path: '/a', ok: true, sameContent: false },
			]),
		).toEqual({ kind: 'link', path: '/a' });
	});
});

function placeholder(h: Harness, path: string, tc: string | null = null): string {
	const a = videoAsset({ seconds: 4 });
	const r = h.ok([
		{
			type: 'media.register',
			asset: {
				...a,
				fingerprint: `pending:interchange:${path}`,
				originalName: path.split(/[\\/]/).pop(),
				probe: { ...a.probe, startTimecode: tc },
				locators: [{ type: 'path', path, relativeToProject: null }],
			},
		},
	]);
	return (r.results[0] as { mediaId: string }).mediaId;
}

const reg = (key: string, path: string, tc: string | null = null) => {
	const a = videoAsset({ seconds: 5 });
	return {
		mediaKey: key,
		fingerprint: `q1:${key}`,
		probe: { ...a.probe, startTimecode: tc },
		sizeBytes: 1234,
		originalName: path.split('/').pop()!,
		container: 'mov,mp4',
		locators: [
			{ type: 'engine-store', engineId: 'local', key },
			{ type: 'path', path, relativeToProject: null },
		],
	};
};

describe('Link Media commands', () => {
	it('relinks many placeholders in one transaction; refuses unknown media and changed content without force', () => {
		const h = new Harness();
		const ids = Array.from({ length: 2 }, (_, i) => placeholder(h, `D:\\Media\\c${i}.mov`));
		const before = h.doc;
		const cmds = ids.map((id, i) =>
			relinkMediaCommand(h.doc.media[id] as MediaAsset, reg(`mk${i}`, `/Volumes/Mac/Media/c${i}.mov`)),
		);
		const r = h.ok(cmds, { label: 'Link Media (2)' });
		expect(r.changed).toEqual(expect.arrayContaining(ids));
		const m = h.doc.media[ids[1]!] as MediaAsset;
		expect(m.fingerprint).toBe('q1:mk1');
		expect(m.locators).toEqual([
			{ type: 'engine-store', engineId: 'local', key: 'mk1' },
			{ type: 'path', path: '/Volumes/Mac/Media/c1.mov', relativeToProject: null },
		]);
		// the old document is untouched (undo restores it as is)
		expect((before.media[ids[1]!] as MediaAsset).locators[0]).toEqual({
			type: 'path',
			path: 'D:\\Media\\c1.mov',
			relativeToProject: null,
		});
		const missing = h.tx([{ ...cmds[0]!, mediaId: 'med_nope' }]);
		expect(missing.ok).toBe(false);
		if (!missing.ok) expect(missing.errors[0]!.code).toBe('E_NOT_FOUND');
		// now a real fingerprint: another file needs force
		const other = h.tx([relinkMediaCommand(h.doc.media[ids[0]!] as MediaAsset, reg('mkX', '/x.mov'))]);
		expect(other.ok).toBe(false);
		if (!other.ok) expect(other.errors[0]!.code).toBe('E_INVALID_PARAM');
		const forced = h.tx([
			relinkMediaCommand(h.doc.media[ids[0]!] as MediaAsset, reg('mkX', '/x.mov'), { force: true }),
		]);
		expect(forced.ok).toBe(true);
	});

	it('Align Timecode only when both timecodes are known and differ at the same frame rate', () => {
		const h = new Harness();
		const id = placeholder(h, 'D:\\a.mov', '01:00:00:00');
		const asset = h.doc.media[id] as MediaAsset;
		expect(timecodeAlignmentApplies(asset, reg('k', '/a.mov', '01:00:00:10'))).toBe(true);
		expect(timecodeAlignmentApplies(asset, reg('k', '/a.mov', '01:00:00:00'))).toBe(false);
		expect(timecodeAlignmentApplies(asset, reg('k', '/a.mov', null))).toBe(false);
		expect(
			relinkMediaCommand(asset, reg('k', '/a.mov', '01:00:00:10'), { alignTimecode: true }).keepSourceTiming,
		).toBe(true);
		expect(relinkMediaCommand(asset, reg('k', '/a.mov', '01:00:00:10')).keepSourceTiming).toBeUndefined();
	});

	it('a refused timecode alignment falls back to a plain relink instead of failing the others', async () => {
		const h = new Harness();
		const a = placeholder(h, 'D:\\a.mov', '01:00:00:00');
		const b = placeholder(h, 'D:\\b.mov');
		h.ok([
			{
				type: 'clip.place',
				source: { mediaId: a },
				at: 0,
				sourceRange: { in: { sourceFrames: 0 }, out: { sourceFrames: 60 } },
			},
		]);
		const commands = [
			relinkMediaCommand(h.doc.media[a] as MediaAsset, reg('new-a', '/a.mov', '01:00:00:10'), {
				alignTimecode: true,
			}),
			relinkMediaCommand(h.doc.media[b] as MediaAsset, reg('new-b', '/b.mov')),
		];
		const aligned = h.tx(commands);
		expect(aligned).toMatchObject({ ok: false, errors: [{ code: 'E_OUT_OF_MEDIA' }] });
		const { result, unaligned } = await applyRelinkTransaction(commands, (cmds) => h.tx(cmds));
		expect(result.ok).toBe(true);
		expect(unaligned.map((entry) => entry.mediaId)).toEqual([a]);
		if (!aligned.ok) expect(unaligned[0]!.reason).toBe(aligned.errors[0]!.message);
		expect((h.doc.media[a] as MediaAsset).fingerprint).toBe('q1:new-a');
		expect((h.doc.media[b] as MediaAsset).fingerprint).toBe('q1:new-b');
		expect(h.clips()[0]!.sourceIn).toBe(0);
		const refused = await applyRelinkTransaction([{ ...commands[0]!, mediaId: 'med_missing' }], (cmds) =>
			h.tx(cmds),
		);
		expect(refused.result).toMatchObject({ ok: false, errors: [{ code: 'E_NOT_FOUND' }] });
	});

	it('Preserve Interpret Footage off resets the interpretation of relinked media', () => {
		const h = new Harness();
		const id = placeholder(h, 'D:\\a.mov');
		h.ok([{ type: 'media.interpret', mediaIds: [id], interpretation: { frameRate: { num: 24, den: 1 } } }]);
		const asset = h.doc.media[id] as MediaAsset;
		expect(asset.interpretation).toBeTruthy();
		const reset = resetInterpretationCommand([asset])!;
		h.ok([relinkMediaCommand(asset, reg('k', '/a.mov')), reset]);
		const after = h.doc.media[id] as MediaAsset;
		expect(after.interpretation?.frameRate ?? null).toBeNull();
		expect(resetInterpretationCommand([after])).toBeNull();
	});
});
