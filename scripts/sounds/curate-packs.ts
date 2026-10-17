#!/usr/bin/env -S pnpm exec tsx
// Reproducible curation of the downloadable sound-pack catalogue (spec 12 P6-R1; wp-note "Phase 6 → WP6.1 sound
// packs"). Network is used by `fetch` only; `build` works on the downloaded archives and writes
// apps/engine/src/sounds/packs.json. We never host or mirror a pack: the catalogue names the upstream URLs and pins
// their bytes; the engine downloads from there when the user (or an agent) installs a pack.
//
//   pnpm exec tsx scripts/sounds/curate-packs.ts fetch <work>   checks each pack page's licence statement (live), then
//                                                               downloads the archives into <work>/<id>.zip and checks
//                                                               their pinned sha256, size and License.txt
//   pnpm exec tsx scripts/sounds/curate-packs.ts scan <work>    measures every file and prints the judge per rule type
//   pnpm exec tsx scripts/sounds/curate-packs.ts build <work> [--out <packs.json>] [--report <file.md>]
//                                                               writes the catalogue: every audio file (minus Preview.ogg,
//                                                               files the starter kit already ships unchanged and
//                                                               byte-identical duplicates) with sha256, size, title, tags
//                                                               and the rule's types the judge accepts on the file
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { listZip, readZipEntry } from '../../apps/engine/src/imports/zip.ts';
import { SoundPackCatalogEntrySchema } from '../../packages/api/src/sounds.ts';
import type { SoundTypeId } from '../../packages/project/src/sound/index.ts';
import { decode, describeRow, findFfmpeg, judge, measure, ROOT, sha256File } from './lib.ts';

const SOURCES_FILE = join(ROOT, 'scripts', 'sounds', 'pack-sources.json');
const CATALOG_FILE = join(ROOT, 'apps', 'engine', 'src', 'sounds', 'packs.json');
const AUDIO = /\.(ogg|wav)$/i;

type Rule = {
	match: string;
	title: string;
	types: SoundTypeId[];
	tags: string[];
	strict?: boolean;
	numbered?: boolean;
};
type SourcePack = {
	id: string;
	title: string;
	page: string;
	url: string;
	sha256: string;
	sizeBytes: number;
	description: string;
	tags: string[];
	rules: Rule[];
	voices?: Record<string, { tag: string; author: string }>;
	voiceSuffix?: string;
};
type Sources = {
	checkedAt: string;
	author: string;
	license: 'CC0-1.0';
	licenseUrl: string;
	pageStatement: string;
	packs: SourcePack[];
};

const loadSources = () => JSON.parse(readFileSync(SOURCES_FILE, 'utf8')) as Sources;
const zipOf = (work: string, id: string) => join(work, `${id}.zip`);
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** Text of an HTML page (scripts and styles dropped, tags removed, entities and spaces normalised). */
function pageText(html: string): string {
	return html
		.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
		.replace(/<[^>]+>/g, ' ')
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&')
		.replace(/\s+/g, ' ');
}

/** The licence lines of a Kenney License.txt (the two lines after the first dashed rule). */
function licenseLines(text: string): string {
	const m =
		/License:?\s*\(Creative Commons Zero, CC0\)\s*(https?:\/\/creativecommons\.org\/publicdomain\/zero\/1\.0\/)/.exec(
			text,
		);
	if (!m) throw new Error('License.txt does not state CC0');
	return `License (Creative Commons Zero, CC0) ${m[1]}`;
}

async function fetchPacks(work: string, src: Sources): Promise<void> {
	mkdirSync(work, { recursive: true });
	const evidence: Record<string, { page: string; statement: string; checkedAt: string }> = {};
	for (const p of src.packs) {
		const res = await fetch(p.page, { headers: { 'user-agent': 'JasperEditor sound-pack curation' } });
		if (!res.ok) throw new Error(`${p.page}: HTTP ${res.status}`);
		const text = pageText(await res.text());
		// The details table of every Kenney asset page: "License Creative Commons CC0" (a link to the CC0 deed).
		if (!/License\s+Creative Commons CC0/.test(text))
			throw new Error(`${p.page}: the page does not state "License: Creative Commons CC0"`);
		evidence[p.id] = { page: p.page, statement: src.pageStatement, checkedAt: new Date().toISOString() };
		const zip = zipOf(work, p.id);
		if (!existsSync(zip)) {
			console.log(`download ${p.url}`);
			const r = await fetch(p.url, { headers: { 'user-agent': 'JasperEditor sound-pack curation' } });
			if (!r.ok) throw new Error(`${p.url}: HTTP ${r.status}`);
			writeFileSync(zip, Buffer.from(await r.arrayBuffer()));
		}
		const got = sha256File(zip);
		if (got !== p.sha256)
			throw new Error(`${zip}: sha256 ${got}, expected ${p.sha256} (the pack changed upstream)`);
		const buf = readFileSync(zip);
		if (buf.length !== p.sizeBytes) throw new Error(`${zip}: ${buf.length} bytes, expected ${p.sizeBytes}`);
		const lic = listZip(buf).find((e) => e.name === 'License.txt');
		if (!lic) throw new Error(`${p.id}: no License.txt`);
		licenseLines(readZipEntry(buf, lic).toString('utf8'));
		console.log(`${p.id}: page states CC0, sha256 ok, License.txt states CC0`);
	}
	writeFileSync(join(work, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
}

type Member = { path: string; data: Buffer; sha256: string };

/** Every audio member of a pack's archive, extracted (by the engine's reader) into `<work>/<id>/` for measuring. */
function members(work: string, p: SourcePack): { members: Member[]; license: Member } {
	const zip = zipOf(work, p.id);
	if (!existsSync(zip)) throw new Error(`${zip} is missing: run \`curate-packs.ts fetch ${work}\` first`);
	const buf = readFileSync(zip);
	if (sha(buf) !== p.sha256) throw new Error(`${zip}: sha256 does not match`);
	const out: Member[] = [];
	let license: Member | null = null;
	for (const e of listZip(buf)) {
		if (e.name.endsWith('/')) continue;
		if (e.name === 'License.txt') {
			const data = readZipEntry(buf, e);
			license = { path: e.name, data, sha256: sha(data) };
			continue;
		}
		if (!AUDIO.test(e.name)) continue;
		const data = readZipEntry(buf, e);
		out.push({ path: e.name, data, sha256: sha(data) });
		const file = join(work, p.id, ...e.name.split('/'));
		if (!existsSync(file)) {
			mkdirSync(dirname(file), { recursive: true });
			writeFileSync(file, data);
		}
	}
	if (!license) throw new Error(`${p.id}: no License.txt`);
	out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	return { members: out, license };
}

type Measured = { desc: ReturnType<typeof measure> };
const measureCache = new Map<string, Measured>();

function measured(work: string, p: SourcePack, m: Member): Measured {
	const key = m.sha256;
	const cached = measureCache.get(key);
	if (cached) return cached;
	const cacheFile = join(work, 'measure', `${key}.json`);
	if (existsSync(cacheFile)) {
		const v = JSON.parse(readFileSync(cacheFile, 'utf8')) as Measured;
		measureCache.set(key, v);
		return v;
	}
	const desc = measure(decode(findFfmpeg(), join(work, p.id, ...m.path.split('/'))));
	const v = { desc };
	mkdirSync(dirname(cacheFile), { recursive: true });
	writeFileSync(cacheFile, JSON.stringify(v));
	measureCache.set(key, v);
	return v;
}

const words = (s: string) =>
	s
		.replace(/([a-z])([A-Z])/g, '$1 $2')
		.replace(/[_-]+/g, ' ')
		.trim()
		.toLowerCase();
const sentence = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

/** The starter kit's unchanged sources (`pack:Audio/<file>`): installing them again would list the same sound twice. */
function starterSources(): Map<string, string> {
	const out = new Map<string, string>();
	// starter-selection.json (read directly: importing curate-starter.ts would run its command line)
	const sel = JSON.parse(readFileSync(join(ROOT, 'scripts', 'sounds', 'starter-selection.json'), 'utf8')) as {
		sounds: { file: string; pack: string; src: string[]; filter?: string }[];
	};
	for (const s of sel.sounds)
		if (!s.filter && s.src.length === 1) out.set(`${s.pack}:Audio/${s.src[0]}`, s.file);
	return out;
}

type Built = {
	entry: Record<string, unknown>;
	stats: { files: number; typed: number; untyped: number; fellBack: number; skipped: number };
	report: string[];
};

function buildPack(work: string, src: Sources, p: SourcePack, starter: Map<string, string>): Built {
	const { members: all, license } = members(work, p);
	const files: Record<string, unknown>[] = [];
	const skipped: { path: string; reason: string }[] = [];
	const firstOf = new Map<string, string>();
	const report: string[] = [];
	const stats = { files: 0, typed: 0, untyped: 0, fellBack: 0, skipped: 0 };
	// numbering: does a stem start at 0 (Kenney's _000) → shown from 1
	const stemZero = new Set<string>();
	for (const m of all) {
		const name = basename(m.path).replace(AUDIO, '');
		const num = /^(.*?)[_-]?(\d+)$/.exec(name);
		if (num && Number(num[2]) === 0) stemZero.add(`${dirname(m.path)}/${num[1]}`);
	}
	for (const m of all) {
		const name = basename(m.path).replace(AUDIO, '');
		if (/^preview$/i.test(name)) {
			skipped.push({ path: m.path, reason: 'the pack preview (a medley of its other files)' });
			continue;
		}
		const inKit = starter.get(`${p.id}:${m.path}`);
		if (inKit) {
			skipped.push({ path: m.path, reason: `already in the bundled starter kit as ${inKit}` });
			continue;
		}
		const dup = firstOf.get(m.sha256);
		if (dup) {
			skipped.push({ path: m.path, reason: `the same bytes as ${dup}` });
			continue;
		}
		firstOf.set(m.sha256, m.path);
		const rule = p.rules.find((r) => new RegExp(r.match).test(name));
		if (!rule) throw new Error(`${p.id}: no rule matches ${m.path}`);
		const caps = new RegExp(rule.match).exec(name)!;
		const fill = (t: string) => t.replace(/\{(\d)\}/g, (_, i) => words(caps[Number(i)] ?? ''));
		const numM = rule.numbered === false ? null : /^(.*?)[_-]?(\d+)$/.exec(name);
		let title = fill(rule.title);
		if (rule.numbered === false) title = title.replace(/“(.+)”/, (_, w: string) => `“${sentence(w)}”`);
		if (numM) {
			const zero = stemZero.has(`${dirname(m.path)}/${numM[1]}`);
			title = `${title} ${Number(numM[2]) + (zero ? 1 : 0)}`;
		}
		let author: string | undefined;
		const tags = new Set<string>(
			[...p.tags, ...rule.tags.map(fill)].map((t) => t.toLowerCase()).filter(Boolean),
		);
		if (p.voices) {
			const v = Object.entries(p.voices).find(([prefix]) => m.path.startsWith(prefix));
			if (v) {
				tags.add(v[1].tag);
				author = v[1].author;
				title = `${title} (${v[1].tag} voice)`;
			}
		} else if (p.voiceSuffix) title = `${title} (${p.voiceSuffix})`;
		if (p.rules.length === 1 && rule.numbered === false)
			for (const w of words(name).split(' ')) if (w.length > 1 && !/^\d+$/.test(w)) tags.add(w);
		const folder = dirname(m.path).split('/').pop() ?? '';
		if (/jingles/i.test(folder)) tags.add(words(folder).replace(/ jingles$/, ''));
		let types: SoundTypeId[] = [];
		let verdict = 'untyped';
		if (rule.types.length) {
			const d = measured(work, p, m).desc;
			const accepted = rule.types.filter((t) => judge(d, t).ok);
			if (accepted.length) {
				types = accepted;
				verdict = `ok ${accepted.join(',')}`;
			} else if (rule.strict) {
				verdict = `rejected (${rule.types.map((t) => `${t}: ${judge(d, t).reasons.join('+')}`).join('; ')}) → untyped`;
			} else {
				types = [rule.types[0]!];
				verdict = `rejected (${judge(d, rule.types[0]!).reasons.join('+')}) → kept ${rule.types[0]}`;
				stats.fellBack++;
			}
			report.push(
				`| \`${m.path}\` | ${title} | ${types.join(', ') || '—'} | ${verdict} | ${describeRow(d)} |`,
			);
		} else report.push(`| \`${m.path}\` | ${title} | — | untyped (rule) | |`);
		if (types.length) stats.typed++;
		else stats.untyped++;
		files.push({
			path: m.path,
			sha256: m.sha256,
			sizeBytes: m.data.length,
			title,
			types,
			tags: [...tags].slice(0, 32),
			...(author ? { author } : {}),
			...(types.length === 0 ? { inferTypes: false } : {}),
		});
	}
	stats.files = files.length;
	stats.skipped = skipped.length;
	const entry = {
		id: p.id,
		title: p.title,
		author: src.author,
		description: p.description,
		license: src.license,
		licenseUrl: src.licenseUrl,
		licenseEvidence: [
			{ url: p.page, statement: src.pageStatement, checkedAt: src.checkedAt },
			{
				url: `${p.url}#License.txt`,
				statement: licenseLines(license.data.toString('utf8')),
				checkedAt: src.checkedAt,
			},
		],
		attribution: null,
		pageUrl: p.page,
		download: { type: 'zip', url: p.url, sha256: p.sha256, sizeBytes: p.sizeBytes },
		licenseFile: { path: license.path, sha256: license.sha256, sizeBytes: license.data.length },
		files,
		skipped,
	};
	const check = SoundPackCatalogEntrySchema.safeParse(entry);
	if (!check.success) throw new Error(`${p.id}: ${JSON.stringify(check.error.issues.slice(0, 3))}`);
	return { entry, stats, report };
}

function scan(work: string, src: Sources): void {
	for (const p of src.packs) {
		const { members: all } = members(work, p);
		for (const m of all) {
			const name = basename(m.path).replace(AUDIO, '');
			const rule = p.rules.find((r) => new RegExp(r.match).test(name));
			if (!rule?.types.length) continue;
			const d = measured(work, p, m).desc;
			console.log(
				`${p.id}/${m.path}\t${describeRow(d)}\t${rule.types.map((t) => `${t}:${judge(d, t).ok ? 'ok' : judge(d, t).reasons.join('+')}`).join(' ')}`,
			);
		}
	}
}

function build(work: string, src: Sources, out: string, reportFile: string | null): void {
	const starter = starterSources();
	const packs: Record<string, unknown>[] = [];
	const report: string[] = [];
	for (const p of src.packs) {
		const b = buildPack(work, src, p, starter);
		packs.push(b.entry);
		const s = b.stats;
		console.log(
			`${p.id}: ${s.files} files (${s.typed} typed, ${s.untyped} untyped, ${s.fellBack} kept a type the judge rejected), ${s.skipped} skipped`,
		);
		report.push(
			`### ${p.title} (\`${p.id}\`)`,
			'',
			'| File | Title | Types | Judge | Descriptors |',
			'|---|---|---|---|---|',
			...b.report,
			'',
		);
	}
	const catalog = {
		$comment:
			"Downloadable sound packs (spec 12 §2.1 source 2, P6-R1; generated by scripts/sounds/curate-packs.ts from scripts/sounds/pack-sources.json — edit those, not this file). Same rules as processing/models.json: each pack names its upstream URL (never a mirror), the archive is pinned by sha256 and size, and every installed file by its own sha256 and size; the licence is on the AGENTS.md allowlist and `licenseEvidence` says where it was checked. Installed on request into <appdir>/sounds/packs/<id>/ by the engine's sound-pack-install job.",
		version: 1,
		packs,
	};
	writeFileSync(out, `${JSON.stringify(catalog, null, '\t')}\n`);
	console.log(`wrote ${out}`);
	if (reportFile) writeFileSync(reportFile, `${report.join('\n')}\n`);
}

const [cmd, work, ...rest] = process.argv.slice(2);
if (!cmd || !work) {
	console.error('usage: curate-packs.ts fetch|scan|build <work> [--out file] [--report file.md]');
	process.exit(2);
}
const src = loadSources();
const flag = (name: string) => {
	const i = rest.indexOf(name);
	return i >= 0 ? (rest[i + 1] ?? null) : null;
};
if (cmd === 'fetch') await fetchPacks(work, src);
else if (cmd === 'scan') scan(work, src);
else if (cmd === 'build') build(work, src, flag('--out') ?? CATALOG_FILE, flag('--report'));
else {
	console.error(`unknown command ${cmd}`);
	process.exit(2);
}
