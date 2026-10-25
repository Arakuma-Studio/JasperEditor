#!/usr/bin/env -S pnpm exec tsx
// Reproducible curation of the bundled Kenney CC0 starter kit (spec 12 §0 decision 1, §2.1, P1-R4; wp-note
// "Phase 1 → WP1.2b starter kit"). Network is used by `fetch` only; everything else works on the downloaded archives.
//
//   pnpm exec tsx scripts/sounds/curate-starter.ts fetch <work>   download the packs of starter-selection.json into
//                                                                  <work>/<packId>.zip and check their pinned sha256
//   pnpm exec tsx scripts/sounds/curate-starter.ts scan <work>    analyse every sound of every pack and print the
//                                                                  descriptors and the types whose judge accepts it
//                                                                  (the measurement the selection was made from)
//   pnpm exec tsx scripts/sounds/curate-starter.ts build <work> [--out <dir>] [--report <file.md>]
//                                                                  convert the selection (with its derivations) to
//                                                                  48 kHz OGG Vorbis in apps/engine/sounds/starter/,
//                                                                  measure and judge every output, write manifest.json
//
// The selection (`starter-selection.json`) lists each kit file with its source pack, source file(s), types, title,
// tags and, for derived sounds, the ffmpeg filter graph (inputs `[in0]`, `[in1]`… at 48 kHz stereo, output `[out]`)
// and a plain-language `derivation`. `build` refuses when an output's judge rejects its first type, when the kit
// exceeds 8 MB, when two outputs have the same audio, or when ffmpeg is a GPL build.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { inferTypesFromName, type SoundTypeId } from '../../packages/project/src/sound/index.ts';
import {
	assertLgplVorbis,
	decode,
	describeRow,
	EFFECT_TYPES,
	findFfmpeg,
	judge,
	measure,
	OUTPUT_RATE,
	ROOT,
	runFfmpeg,
	STARTER_BUDGET_BYTES,
	STARTER_DIR,
	sha256File,
} from './lib.ts';

export const SELECTION_FILE = join(ROOT, 'scripts', 'sounds', 'starter-selection.json');
export const KENNEY_AUTHOR = 'Kenney (www.kenney.nl)';
export const CC0_URL = 'https://creativecommons.org/publicdomain/zero/1.0/';
/** libvorbis quality (≈ 128–160 kbit/s stereo): transparent for effects, a fraction of the 8 MB budget. */
const VORBIS_QUALITY = '5';

export type SelectionPack = {
	id: string;
	title: string;
	/** The pack's page on kenney.nl (licence statement). */
	page: string;
	/** Archive URL. */
	url: string;
	sha256: string;
	version?: string;
};
export type SelectionSound = {
	file: string;
	title: string;
	types: SoundTypeId[];
	tags: string[];
	pack: string;
	/** Source files, relative to the pack's `Audio/` folder. */
	src: string[];
	/** ffmpeg filter graph over `[in0]…` producing `[out]` (derived sounds only). */
	filter?: string;
	/** What the filter does, in plain language. */
	derivation?: string;
};
export type Selection = { packs: SelectionPack[]; sounds: SelectionSound[] };

export function loadSelection(): Selection {
	return JSON.parse(readFileSync(SELECTION_FILE, 'utf8')) as Selection;
}

const packZip = (work: string, id: string) => join(work, `${id}.zip`);
const packDir = (work: string, id: string) => join(work, id);

async function fetchPacks(work: string, sel: Selection): Promise<void> {
	mkdirSync(work, { recursive: true });
	for (const p of sel.packs) {
		const zip = packZip(work, p.id);
		if (!existsSync(zip)) {
			console.log(`download ${p.url}`);
			const res = await fetch(p.url, { headers: { 'user-agent': 'JasperEditor starter-kit curation' } });
			if (!res.ok) throw new Error(`${p.url}: HTTP ${res.status}`);
			writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
		}
		const sha = sha256File(zip);
		if (sha !== p.sha256)
			throw new Error(`${zip}: sha256 ${sha}, expected ${p.sha256} (the pack changed upstream)`);
		console.log(`${p.id}: sha256 ok`);
	}
}

/** Checks each archive's sha256 and extracts it once to `<work>/<packId>/`. */
function preparePacks(work: string, sel: Selection): void {
	for (const p of sel.packs) {
		const zip = packZip(work, p.id);
		if (!existsSync(zip)) throw new Error(`${zip} is missing: run \`curate-starter.ts fetch ${work}\` first`);
		const sha = sha256File(zip);
		if (sha !== p.sha256) throw new Error(`${zip}: sha256 ${sha}, expected ${p.sha256}`);
		const dir = packDir(work, p.id);
		if (!existsSync(join(dir, 'License.txt'))) {
			mkdirSync(dir, { recursive: true });
			const r = spawnSync('unzip', ['-q', '-o', zip, '-d', dir], { encoding: 'utf8' });
			if (r.status !== 0) throw new Error(`unzip ${zip} failed: ${r.stderr || r.error}`);
		}
		const license = readFileSync(join(dir, 'License.txt'), 'utf8');
		if (!/Creative Commons Zero, CC0/.test(license))
			throw new Error(`${p.id}: License.txt does not state CC0; the pack is not usable`);
	}
}

function walk(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
		e.isDirectory() ? walk(join(dir, e.name)) : /\.(ogg|wav)$/i.test(e.name) ? [join(dir, e.name)] : [],
	);
}

/**
 * Every sound of every pack: descriptors, the types whose judge accepts it, and the judge for the type its Kenney file
 * name implies (`inferTypesFromName`, camelCase split); then, per implied type, how many the judge accepts and why
 * the others fail (the evidence for keeping or re-tuning a profile on real recordings).
 */
function scan(work: string, sel: Selection): void {
	preparePacks(work, sel);
	const ff = findFfmpeg();
	const byType = new Map<SoundTypeId, { n: number; ok: number; reasons: Map<string, number> }>();
	for (const p of sel.packs) {
		for (const f of walk(join(packDir(work, p.id), 'Audio')).sort()) {
			const d = measure(decode(ff, f));
			const ok = EFFECT_TYPES.filter((t) => judge(d, t).ok);
			const named = inferTypesFromName(basename(f).replace(/([a-z])([A-Z])/g, '$1 $2'))[0];
			let byName = '';
			if (named && named !== 'ambience' && named !== 'roomtone') {
				const j = judge(d, named);
				const b = byType.get(named) ?? { n: 0, ok: 0, reasons: new Map<string, number>() };
				b.n++;
				if (j.ok) b.ok++;
				for (const r of j.reasons) b.reasons.set(r, (b.reasons.get(r) ?? 0) + 1);
				byType.set(named, b);
				byName = `\tnamed ${named}: ${j.ok ? 'ok' : j.reasons.join('+')}`;
			}
			console.log(`${p.id}/${basename(f)}\t${describeRow(d)}\tjudge ok: ${ok.join(',') || '-'}${byName}`);
		}
	}
	console.log('\nJudge on the type implied by the file name:');
	for (const [t, b] of byType)
		console.log(
			`  ${t}: ${b.ok}/${b.n} accepted; ${[...b.reasons].map(([r, n]) => `${r} ${n}`).join(', ') || '-'}`,
		);
}

/** ffmpeg arguments that convert one selection entry to `out`. */
function convertArgs(
	work: string,
	s: SelectionSound,
	out: string,
	meta: { title: string; pack: string },
): string[] {
	const inputs = s.src.flatMap((f) => ['-i', join(packDir(work, s.pack), 'Audio', f)]);
	const graph = s.filter
		? [
				...s.src.map(
					(_, i) =>
						`[${i}:a]aresample=${OUTPUT_RATE},aformat=sample_fmts=fltp:channel_layouts=stereo[in${i}]`,
				),
				s.filter,
			].join(';')
		: null;
	return [
		'-y',
		...inputs,
		...(graph
			? ['-filter_complex', graph, '-map', '[out]']
			: ['-map', '0:a:0', '-af', `aresample=${OUTPUT_RATE}`]),
		'-map_metadata',
		'-1',
		'-c:a',
		'libvorbis',
		'-q:a',
		VORBIS_QUALITY,
		'-ar',
		String(OUTPUT_RATE),
		// deterministic output: fixed Ogg serial numbers, no encoder version tag
		'-fflags',
		'+bitexact',
		'-flags:a',
		'+bitexact',
		'-metadata',
		`title=${meta.title}`,
		'-metadata',
		`artist=${KENNEY_AUTHOR}`,
		'-metadata',
		`album=${meta.pack}`,
		'-metadata',
		'license=CC0-1.0',
		out,
	];
}

export type BuildRow = {
	file: string;
	types: SoundTypeId[];
	source: string;
	derived: boolean;
	bytes: number;
	durationSec: number;
	peakSec: number;
	maxMomentaryLufs: number | null;
	truePeakDb: number | null;
	judge: { type: SoundTypeId; ok: boolean; score: number; reasons: string[] };
	alsoOk: SoundTypeId[];
};

function build(work: string, sel: Selection, outDir: string, reportFile: string | null): void {
	const ff = findFfmpeg();
	assertLgplVorbis(ff);
	preparePacks(work, sel);
	const packs = new Map(sel.packs.map((p) => [p.id, p]));
	const names = new Set<string>();
	for (const s of sel.sounds) {
		if (!/^[a-z]+(-[a-z0-9]+)*-\d\d\.ogg$/.test(s.file))
			throw new Error(`${s.file}: not <type>-<desc>-NN.ogg`);
		if (!s.file.startsWith(`${s.types[0]}-`)) throw new Error(`${s.file}: must start with its first type`);
		if (names.has(s.file)) throw new Error(`${s.file} is listed twice`);
		names.add(s.file);
		if (!packs.has(s.pack)) throw new Error(`${s.file}: unknown pack ${s.pack}`);
		if (s.src.length > 1 && !s.filter) throw new Error(`${s.file}: several sources need a filter`);
		if (!!s.filter !== !!s.derivation)
			throw new Error(`${s.file}: a filter needs a derivation note (and back)`);
	}
	mkdirSync(outDir, { recursive: true });
	// The kit folder holds exactly the selection: stale audio goes.
	for (const f of readdirSync(outDir))
		if (/\.(ogg|wav|flac)$/.test(f) && !names.has(f)) rmSync(join(outDir, f));

	const rows: BuildRow[] = [];
	const audioHashes = new Map<string, string>();
	let total = 0;
	for (const s of sel.sounds) {
		const pack = packs.get(s.pack)!;
		const out = join(outDir, s.file);
		runFfmpeg(ff, convertArgs(work, s, out, { title: s.title, pack: `${pack.title} (Kenney)` }));
		const decoded = decode(ff, out);
		const pcmHash = createHash('sha256');
		for (const ch of decoded.channels) pcmHash.update(Buffer.from(ch.buffer, ch.byteOffset, ch.byteLength));
		const digest = pcmHash.digest('hex');
		const twin = audioHashes.get(digest);
		if (twin) throw new Error(`${s.file} has the same audio as ${twin}`);
		audioHashes.set(digest, s.file);
		const d = measure(decoded);
		const first = s.types[0]!;
		const j = judge(d, first);
		const bytes = statSync(out).size;
		total += bytes;
		const row: BuildRow = {
			file: s.file,
			types: s.types,
			source: `${s.pack.replace(/^kenney-/, '')}: ${s.src.join(' + ')}`,
			derived: !!s.filter,
			bytes,
			durationSec: d.durationSec,
			peakSec: d.peakSec,
			maxMomentaryLufs: d.maxMomentaryLufs,
			truePeakDb: d.truePeakDb,
			judge: { type: first, ok: j.ok, score: j.score, reasons: j.reasons },
			alsoOk: EFFECT_TYPES.filter((t) => t !== first && judge(d, t).ok),
		};
		rows.push(row);
		console.log(
			`${j.ok ? 'ok  ' : 'FAIL'} ${s.file.padEnd(30)} ${first.padEnd(10)} ${describeRow(d)} ${j.reasons.join(',')}`,
		);
	}
	const failed = rows.filter((r) => !r.judge.ok);
	if (failed.length) throw new Error(`judge rejected: ${failed.map((r) => r.file).join(', ')}`);
	if (total > STARTER_BUDGET_BYTES)
		throw new Error(`kit is ${total} bytes, over the ${STARTER_BUDGET_BYTES} budget`);

	const used = new Set(sel.sounds.map((s) => s.pack));
	const manifest = {
		version: 1,
		packs: sel.packs
			.filter((p) => used.has(p.id))
			.map((p) => ({
				id: p.id,
				title: `${p.title} (Kenney)`,
				url: p.url,
				sha256: p.sha256,
				license: 'CC0-1.0',
				licenseUrl: CC0_URL,
				author: KENNEY_AUTHOR,
			})),
		sounds: sel.sounds.map((s) => ({
			file: s.file,
			title: s.title,
			types: s.types,
			tags: s.tags,
			author: KENNEY_AUTHOR,
			license: 'CC0-1.0',
			licenseUrl: CC0_URL,
			sourceUrl: packs.get(s.pack)!.page,
			packId: s.pack,
		})),
	};
	const manifestPath = join(outDir, 'manifest.json');
	writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
	// In the repository the manifest is formatted the way `pnpm lint` (Biome) expects; Biome ignores other folders.
	if (!relative(ROOT, manifestPath).startsWith('..')) {
		const biome = spawnSync(
			join(ROOT, 'node_modules', '.bin', 'biome'),
			['format', '--write', manifestPath],
			{
				cwd: ROOT,
				encoding: 'utf8',
			},
		);
		if (biome.status !== 0) throw new Error(`biome format failed: ${biome.stdout}${biome.stderr}`);
	}

	const covered = new Set(rows.flatMap((r) => r.types));
	const uncovered = EFFECT_TYPES.filter((t) => !covered.has(t));
	const md = [
		`Kit: ${rows.length} sounds, ${total} bytes (${(total / 1024 / 1024).toFixed(2)} MB of 8 MB), ${rows.filter((r) => r.derived).length} derived.`,
		`Types covered (${covered.size}/19): ${EFFECT_TYPES.filter((t) => covered.has(t))
			.map((t) => `${t} ${rows.filter((r) => r.types.includes(t)).length}`)
			.join(', ')}. Uncovered: ${uncovered.join(', ') || 'none'}.`,
		'',
		'| File | Types | Source (pack: file) | Derived | Dur (s) | Peak (s) | Max M (LUFS) | TP (dBTP) | Judge | Judge-ok types |',
		'|---|---|---|---|---|---|---|---|---|---|',
		...rows.map(
			(r) =>
				`| \`${r.file}\` | ${r.types.join(', ')} | ${r.source} | ${r.derived ? 'yes' : ''} | ${r.durationSec} | ${r.peakSec} | ${r.maxMomentaryLufs} | ${r.truePeakDb} | ${r.judge.ok ? 'ok' : 'no'} ${r.judge.score} (${r.judge.type}) | ${r.alsoOk.length + (r.judge.ok ? 1 : 0)}/19 |`,
		),
	].join('\n');
	if (reportFile) writeFileSync(reportFile, `${md}\n`);
	console.log(`\n${md}`);
	console.log(`\nwrote ${relative(ROOT, manifestPath)}`);
}

function arg(name: string, args: string[]): string | null {
	const i = args.indexOf(name);
	return i >= 0 ? (args[i + 1] ?? null) : null;
}

async function main(): Promise<void> {
	const [cmd, work, ...rest] = process.argv.slice(2);
	if (!cmd || !work) {
		console.error('usage: curate-starter.ts fetch|scan|build <work dir> [--out <dir>] [--report <file>]');
		process.exit(2);
	}
	const sel = loadSelection();
	const dir = resolve(work);
	if (cmd === 'fetch') await fetchPacks(dir, sel);
	else if (cmd === 'scan') scan(dir, sel);
	else if (cmd === 'build')
		build(dir, sel, resolve(arg('--out', rest) ?? STARTER_DIR), arg('--report', rest));
	else throw new Error(`unknown command ${cmd}`);
}

main().catch((e) => {
	console.error(e instanceof Error ? e.message : e);
	process.exit(1);
});
