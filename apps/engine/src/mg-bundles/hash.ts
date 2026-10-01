// Content address of a bundle directory (S08:MGC-001): sha256 over the sorted relative paths (POSIX
// separators) and file contents. Symlinks are followed (a bundle's `public/` may be a symlink); cycles and
// special files are skipped.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, realpath, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

type BundleFile = { rel: string; abs: string; size: number };

/** Every regular file under `root` (following symlinks), sorted by relative POSIX path. */
async function listBundleFiles(
	root: string,
	opts: { skip?: (rel: string) => boolean } = {},
): Promise<BundleFile[]> {
	const out: BundleFile[] = [];
	const seen = new Set<string>();
	const walk = async (dir: string) => {
		const real = await realpath(dir);
		if (seen.has(real)) return;
		seen.add(real);
		const entries = await readdir(dir, { withFileTypes: true });
		for (const e of entries) {
			const abs = join(dir, e.name);
			const rel = relative(root, abs).split(sep).join('/');
			if (opts.skip?.(rel)) continue;
			let s: Awaited<ReturnType<typeof stat>>;
			try {
				s = await stat(abs);
			} catch {
				continue; // dangling symlink
			}
			if (s.isDirectory()) await walk(abs);
			else if (s.isFile()) out.push({ rel, abs, size: s.size });
		}
	};
	await walk(root);
	return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

/** sha256 hex of a bundle directory's content (paths + bytes). */
export async function hashBundleDir(
	root: string,
	opts: { skip?: (rel: string) => boolean } = {},
): Promise<{ hash: string; files: number; bytes: number }> {
	const h = createHash('sha256');
	const files = await listBundleFiles(root, opts);
	let bytes = 0;
	for (const f of files) {
		h.update(`${f.rel}\0${f.size}\0`);
		await new Promise<void>((resolve, reject) => {
			const rs = createReadStream(f.abs);
			rs.on('data', (c) => h.update(c));
			rs.on('end', () => resolve());
			rs.on('error', reject);
		});
		h.update('\0');
		bytes += f.size;
	}
	return { hash: h.digest('hex'), files: files.length, bytes };
}
