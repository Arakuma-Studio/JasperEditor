// `jasper apply | preview | export-scene` (docs/wp-notes/scene-file.md): declarative scene files from the command line.
// The file is parsed here (YAML or JSON), validated, resolved and diffed by @jasper/project (pure), and the plan goes
// to the engine as ONE `apply_commands` transaction (one undo step, `expectedRevision` = the document the plan was
// made from, writer leases and live editor windows handled like every other edit). `preview` applies, then renders
// the given times as one still-sheet job (render_frames, spec 19 TL-103) and writes a labelled contact sheet;
// `--watch` does it again on every save. `export-scene` writes a sequence back as a scene file.
import { existsSync, readFileSync, renameSync, statSync, unlinkSync, watch, writeFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
	createRandomIdSource,
	defaultRegistries,
	exportScene,
	findSceneSequence,
	formatSceneIssues,
	type MediaAsset,
	type ProjectDocument,
	planScene,
	resolveScene,
	type SceneFile,
	type SceneIssue,
	type ScenePlan,
	sceneSequenceName,
	validateSceneFile,
} from '@jasper/project';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { Document, isScalar, isSeq, parseDocument, visit } from 'yaml';
import type { EngineConnection } from './link.ts';
import { drawText, fitText, GLYPH_HEIGHT } from './pixel-font.ts';
import { decodePng, encodePng } from './png.ts';
import { SHEET_GAP } from './still-sheet.ts';

/** What the scene commands need from the CLI (jasper-cli.ts). */
export type SceneCliContext = {
	call(name: string, args?: Record<string, unknown>, opts?: { progress?: boolean }): Promise<CallToolResult>;
	link: EngineConnection;
	flags: Record<string, string | true>;
	out: { stdout(s: string): void; stderr(s: string): void };
	json: boolean;
	cwd: string;
	signal?: AbortSignal;
	projectId(): Promise<string>;
	/** An exit-2 usage error. */
	usage(message: string): Error;
	/** An exit-1 failure with a `{error: {code, message, hint?, details?}}` body. */
	fail(body: { error: { code: string; message: string; hint?: string; details?: unknown } }): Error;
};

const registries = defaultRegistries();

// --- parsing ------------------------------------------------------------------------------------------------------

export type ParsedSceneText = { ok: true; raw: unknown } | { ok: false; issues: SceneIssue[] };

/** YAML (`.yaml` / `.yml`, and anything that is not `.json`) or JSON text → a value; syntax errors name the line. */
export function parseSceneText(text: string, fileName: string): ParsedSceneText {
	if (extname(fileName).toLowerCase() === '.json') {
		try {
			return { ok: true, raw: JSON.parse(text) };
		} catch (e) {
			return { ok: false, issues: [{ path: [], message: `not JSON: ${(e as Error).message}` }] };
		}
	}
	const doc = parseDocument(text, { prettyErrors: true, uniqueKeys: true });
	if (doc.errors.length) {
		// "… at line 4, column 1:" then a code excerpt
		const first = doc.errors[0]!.message.split('\n')[0]!.replace(/:\s*$/, '');
		return { ok: false, issues: [{ path: [], message: `not YAML: ${first}` }] };
	}
	return { ok: true, raw: doc.toJS({ maxAliasCount: 100 }) };
}

/** A scene file object as text in the format its name (or `format`) asks for; short number lists stay on one line. */
export function formatSceneText(file: unknown, fileName: string, format?: string): string {
	const f = (format ?? (extname(fileName).toLowerCase() === '.json' ? 'json' : 'yaml')).toLowerCase();
	if (f === 'json') return `${JSON.stringify(file, null, 2)}\n`;
	const doc = new Document(file);
	const flat = (n: unknown): boolean =>
		isScalar(n) ||
		(isSeq(n) && n.items.length <= 4 && n.items.every((i) => isScalar(i) && typeof i.value === 'number'));
	visit(doc, {
		// [x, y], [w, h], [x, y, w, h] on one line
		Seq(_key, node) {
			if (node.items.length <= 4 && node.items.every((i) => isScalar(i) && typeof i.value === 'number'))
				node.flow = true;
		},
		// keys ({t, value, ease}) and mask vertices ({p, in, out}) on one line each
		Map(_key, node) {
			const keys = node.items.map((i) => (isScalar(i.key) ? String(i.key.value) : ''));
			if ((keys.includes('t') || keys.includes('p')) && node.items.every((i) => flat(i.value)))
				node.flow = true;
		},
	});
	return doc.toString({ lineWidth: 0, flowCollectionPadding: false });
}

// --- media of the file --------------------------------------------------------------------------------------------

const pathLocators = (m: MediaAsset) =>
	m.locators.flatMap((l) => (l.type === 'path' ? [resolve(l.path)] : []));

/** The media of an image path: a path locator, else the same file name and size. */
function mediaOfPath(doc: ProjectDocument, abs: string): string | null {
	const all = Object.values(doc.media);
	const byPath = all.find((m) => pathLocators(m).includes(abs));
	if (byPath) return byPath.id;
	let size = -1;
	try {
		size = statSync(abs).size;
	} catch {
		return null;
	}
	return all.find((m) => m.originalName === basename(abs) && m.sizeBytes === size)?.id ?? null;
}

/** The Remotion bundle of a folder, an id or a name. */
function bundleOf(doc: ProjectDocument, ref: string, baseDir: string): string | null {
	const bundles = Object.values(doc.media).filter((m) => m.kind === 'mg-bundle');
	const abs = isAbsolute(ref) ? ref : resolve(baseDir, ref);
	return (
		bundles.find((m) => m.id === ref)?.id ??
		bundles.find((m) => m.mgBundle?.source.path && resolve(m.mgBundle.source.path) === abs)?.id ??
		bundles.find((m) => m.mgBundle?.source.name === ref || m.originalName === ref)?.id ??
		null
	);
}

const looksLikeMediaId = (s: string) => /^med_[0-9A-HJKMNP-TV-Z]{16}$/.test(s);

// --- engine helpers -------------------------------------------------------------------------------------------------

function jsonOf(r: CallToolResult): unknown {
	const t = (r.content.find((c) => c.type === 'text') as { text?: string } | undefined)?.text ?? '';
	try {
		return JSON.parse(t);
	} catch {
		return t;
	}
}

async function tool(c: SceneCliContext, name: string, args: Record<string, unknown>, progress = false) {
	const r = await c.call(name, args, { progress });
	if (r.isError) throw c.fail(jsonOf(r) as never);
	return r;
}

async function loadDocument(
	c: SceneCliContext,
	projectId: string,
): Promise<{ doc: ProjectDocument; revision: number | undefined }> {
	const cl = await c.link.client();
	const q = await cl.agentQuery({ projectId, query: 'doc.get', args: {} });
	const doc = q.result as ProjectDocument;
	if (!doc || typeof doc !== 'object' || !doc.sequences)
		throw c.fail({ error: { code: 'INTERNAL', message: 'The engine returned no document' } });
	return { doc, revision: q.revision };
}

function invalid(c: SceneCliContext, file: string, issues: readonly SceneIssue[]): Error {
	return c.fail({
		error: {
			code: 'E_SCENE_INVALID',
			message: `${file}:\n${formatSceneIssues(issues)
				.split('\n')
				.map((l) => `  ${l}`)
				.join('\n')}`,
			details: { issues: issues.map((i) => ({ path: i.path, message: i.message })) },
		},
	});
}

/** Reads and validates a scene file. */
function readScene(c: SceneCliContext, path: string): SceneFile {
	let text: string;
	try {
		text = readFileSync(path, 'utf8');
	} catch (e) {
		throw c.fail({ error: { code: 'E_NOT_FOUND', message: `Cannot read ${path}: ${(e as Error).message}` } });
	}
	const parsed = parseSceneText(text, path);
	if (!parsed.ok) throw invalid(c, path, parsed.issues);
	const v = validateSceneFile(parsed.raw);
	if (!v.ok) throw invalid(c, path, v.issues);
	return v.scene;
}

/** Imports the files the scene names and the project does not hold yet (images, SVGs, Remotion folders). */
async function importMissing(
	c: SceneCliContext,
	projectId: string,
	scene: SceneFile,
	baseDir: string,
	doc: ProjectDocument,
) {
	const files = new Set<string>();
	const bundles = new Set<string>();
	scene.layers.forEach((l) => {
		if ((l.type === 'image' || l.type === 'svg') && !looksLikeMediaId(l.src)) {
			const abs = resolve(baseDir, l.src);
			if (existsSync(abs) && statSync(abs).isFile() && !mediaOfPath(doc, abs)) files.add(abs);
		}
		if (l.type === 'composition' && !bundleOf(doc, l.bundle, baseDir)) {
			const abs = resolve(baseDir, l.bundle);
			if (existsSync(abs) && statSync(abs).isDirectory()) bundles.add(abs);
		}
	});
	if (files.size) {
		c.out.stderr(`[jasper] importing ${files.size} file(s) the scene uses\n`);
		await tool(c, 'import_media', { projectId, paths: [...files] }, true);
	}
	for (const b of bundles) {
		c.out.stderr(`[jasper] importing Remotion project ${b}\n`);
		await tool(c, 'import_mg_bundle', { projectId, path: b }, true);
	}
	return files.size + bundles.size > 0;
}

export type ApplyOutcome = {
	plan: ScenePlan;
	revision: number | undefined;
	applied: boolean;
	sequenceId: string;
	sequenceName: string;
};

/** Plans and applies one scene file; prints what changed. */
export async function applySceneFile(c: SceneCliContext, file: string): Promise<ApplyOutcome> {
	const path = resolve(c.cwd, file);
	const baseDir = dirname(path);
	const scene = readScene(c, path);
	const projectId = await c.projectId();
	let { doc, revision } = await loadDocument(c, projectId);
	if (!c.flags['dry-run'] && (await importMissing(c, projectId, scene, baseDir, doc)))
		({ doc, revision } = await loadDocument(c, projectId));
	const mediaFor = (src: string, kind: 'image' | 'bundle') =>
		kind === 'bundle'
			? bundleOf(doc, src, baseDir)
			: looksLikeMediaId(src)
				? (doc.media[src]?.id ?? null)
				: mediaOfPath(doc, resolve(baseDir, src));
	const r = resolveScene(scene, { doc, registries, mediaFor });
	if (!r.ok) throw invalid(c, path, r.issues);
	const ids = createRandomIdSource();
	const p = planScene(doc, r.scene, { registries, newId: (prefix) => ids.next(prefix) });
	if (!p.ok) throw invalid(c, path, p.issues);
	const plan = p.plan;
	for (const w of plan.warnings) c.out.stderr(`[jasper] warning: ${w}\n`);
	let applied = false;
	if (plan.commands.length) {
		const res = await tool(c, 'apply_commands', {
			projectId,
			label: `Scene: ${basename(path)}`.slice(0, 80),
			commands: plan.commands,
			...(revision !== undefined ? { expectedRevision: revision } : {}),
			...(c.flags['dry-run'] ? { dryRun: true } : {}),
		});
		const body = jsonOf(res) as { revision?: number; warnings?: { message: string }[] };
		for (const w of body.warnings ?? []) c.out.stderr(`[jasper] ${w.message}\n`);
		revision = body.revision ?? revision;
		applied = !c.flags['dry-run'];
	}
	const summary = {
		ok: true,
		...(c.flags['dry-run'] ? { dryRun: true } : {}),
		sequence: r.scene.sequence.name,
		sequenceId: plan.sequenceId,
		...(plan.createsSequence ? { createdSequence: true } : {}),
		revision,
		commands: plan.commands.length,
		layers: plan.layers,
		removed: plan.removed,
		...(plan.warnings.length ? { warnings: plan.warnings } : {}),
	};
	if (c.json) c.out.stdout(`${JSON.stringify(summary)}\n`);
	else {
		const lines: string[] = [];
		if (plan.createsSequence) lines.push(`created sequence "${r.scene.sequence.name}"`);
		for (const l of plan.layers)
			if (l.status === 'created') lines.push(`created  ${l.id}`);
			else if (l.status === 'recreated') lines.push(`recreated ${l.id} (${l.why})`);
			else if (l.status === 'updated') lines.push(`updated  ${l.id}: ${l.aspects.join(', ')}`);
		for (const x of plan.removed) lines.push(`removed  ${x.id}`);
		const same = plan.layers.filter((l) => l.status === 'unchanged').length;
		if (!plan.commands.length)
			lines.push(`no changes (${plan.layers.length} layer${plan.layers.length === 1 ? '' : 's'} up to date)`);
		else {
			if (same) lines.push(`${same} layer${same === 1 ? '' : 's'} unchanged`);
			lines.push(
				c.flags['dry-run']
					? `dry run: ${plan.commands.length} command(s) validated, nothing applied`
					: `${plan.commands.length} command(s) in one undo step (revision ${revision ?? '?'})`,
			);
		}
		c.out.stdout(`${lines.join('\n')}\n`);
	}
	return { plan, revision, applied, sequenceId: plan.sequenceId, sequenceName: r.scene.sequence.name };
}

// --- preview ----------------------------------------------------------------------------------------------------------

/** `--times 0.3,1,2.5s,45f` → render_frames times (plain numbers are seconds). */
export function parseTimes(spec: string): { arg: unknown; label: string }[] {
	return spec
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean)
		.map((s) => {
			if (/^\d+(?:\.\d+)?$/.test(s)) return { arg: { seconds: Number(s) }, label: `${s}s` };
			const f = /^(\d+)f$/.exec(s);
			if (f) return { arg: Number(f[1]), label: s };
			return { arg: s, label: s };
		});
}

type SheetBody = {
	columns: number;
	rows: number;
	cellWidth: number;
	cellHeight: number;
	cells: { cell: number; row: number; column: number; frame: number; timecode?: string }[];
};

/**
 * The render_frames sheet with a caption strip under every cell (`labels[i]` and the cell's timecode) and a header
 * naming the scene, so a sheet read later still says what it shows.
 */
export function labelSheet(
	png: Uint8Array,
	body: SheetBody,
	labels: readonly string[],
	title: string,
): Buffer {
	const src = decodePng(png);
	const gap = SHEET_GAP;
	const scale = body.cellWidth >= 240 ? 2 : 1;
	const strip = GLYPH_HEIGHT * scale + 6 * scale;
	const header = strip;
	const width = src.width;
	const height = header + body.rows * (body.cellHeight + strip) + (body.rows + 1) * gap;
	const data = new Uint8Array(width * height * 4);
	for (let i = 0; i < data.length; i += 4) {
		data[i] = 32;
		data[i + 1] = 32;
		data[i + 2] = 32;
		data[i + 3] = 255;
	}
	const img = { width, height, data };
	drawText(img, fitText(title, width - 2 * gap, scale), gap, 3 * scale, [230, 230, 230], scale);
	for (const cell of body.cells) {
		const sx = gap + (cell.column - 1) * (body.cellWidth + gap);
		const sy = gap + (cell.row - 1) * (body.cellHeight + gap);
		const dx = sx;
		const dy = header + gap + (cell.row - 1) * (body.cellHeight + strip + gap);
		for (let y = 0; y < body.cellHeight && sy + y < src.height; y++) {
			const from = ((sy + y) * src.width + sx) * 4;
			data.set(
				src.data.subarray(from, from + Math.min(body.cellWidth, src.width - sx) * 4),
				((dy + y) * width + dx) * 4,
			);
		}
		const label = [labels[cell.cell - 1], cell.timecode].filter(Boolean).join('  ');
		drawText(
			img,
			fitText(label, body.cellWidth, scale),
			dx,
			dy + body.cellHeight + 3 * scale,
			[255, 255, 255],
			scale,
		);
	}
	return encodePng(img);
}

/** Writes `bytes` next to `path` and renames it over (a reader never sees half a file). */
function writeAtomic(path: string, bytes: string | Uint8Array): void {
	const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
	try {
		writeFileSync(tmp, bytes);
		renameSync(tmp, path);
	} catch (e) {
		try {
			unlinkSync(tmp);
		} catch {}
		throw e;
	}
}

async function previewOnce(
	c: SceneCliContext,
	file: string,
	times: { arg: unknown; label: string }[],
	outPath: string,
) {
	const applied = await applySceneFile(c, file);
	const projectId = await c.projectId();
	const width = typeof c.flags.width === 'string' ? Number(c.flags.width) : undefined;
	const columns = typeof c.flags.columns === 'string' ? Number(c.flags.columns) : undefined;
	const timeout =
		typeof c.flags.timeout === 'string' && Number(c.flags.timeout) > 0 ? Number(c.flags.timeout) : 600;
	const r = await tool(
		c,
		'render_frames',
		{
			projectId,
			sequenceId: applied.sequenceId,
			times: times.map((t) => t.arg),
			...(width ? { width } : {}),
			...(columns ? { columns } : {}),
			// graphics re-bake after an edit; a busy machine needs more than render_frames' default wait
			timeoutSeconds: Math.min(900, Math.max(1, Math.round(timeout))),
		},
		true,
	);
	const body = jsonOf(r) as SheetBody & { timedOut?: boolean; next?: string };
	const img = r.content.find((x) => x.type === 'image') as { data?: string } | undefined;
	if (!img?.data)
		throw c.fail({
			error: {
				code: body.timedOut ? 'TIMEOUT' : 'INTERNAL',
				message: body.next ?? 'render_frames returned no sheet',
			},
		});
	const png = labelSheet(
		Buffer.from(img.data, 'base64'),
		body,
		times.map((t) => t.label),
		`${basename(file)}  ${applied.sequenceName}  rev ${applied.revision ?? '?'}`,
	);
	writeAtomic(outPath, png);
	if (c.json)
		c.out.stdout(`${JSON.stringify({ ok: true, out: outPath, bytes: png.length, cells: body.cells })}\n`);
	else c.out.stdout(`wrote ${outPath} (${body.cells.length} frames, ${png.length} bytes)\n`);
}

/** A watcher of one file: calls `onChange` for every event on it (or on its directory entry, for rename-on-save). */
export type FileWatcher = (path: string, onChange: () => void) => { close(): void };

const nodeWatcher: FileWatcher = (path, onChange) => {
	// Editors save by writing a temp file and renaming it over: watch the directory and filter by name.
	const w = watch(dirname(path), (_event, name) => {
		if (!name || name.toString() === basename(path)) onChange();
	});
	return { close: () => w.close() };
};

/**
 * Runs `run` now and again after every burst of changes (debounced `delayMs`); a failing run prints its error and
 * keeps watching. Resolves when `signal` aborts. Runs never overlap: changes during a run schedule one more.
 */
export function watchScene(opts: {
	path: string;
	run: () => Promise<void>;
	onError: (e: unknown) => void;
	signal?: AbortSignal;
	watcher?: FileWatcher;
	delayMs?: number;
	setTimer?: (fn: () => void, ms: number) => unknown;
	clearTimer?: (t: unknown) => void;
}): Promise<void> {
	const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
	const clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
	const delay = opts.delayMs ?? 150;
	let timer: unknown = null;
	let running = false;
	let again = false;
	return new Promise<void>((done) => {
		const go = async () => {
			if (running) {
				again = true;
				return;
			}
			running = true;
			do {
				again = false;
				try {
					await opts.run();
				} catch (e) {
					opts.onError(e);
				}
			} while (again && !opts.signal?.aborted);
			running = false;
		};
		const w = (opts.watcher ?? nodeWatcher)(opts.path, () => {
			if (timer !== null) clearTimer(timer);
			timer = setTimer(() => {
				timer = null;
				void go();
			}, delay);
		});
		const stop = () => {
			if (timer !== null) clearTimer(timer);
			w.close();
			done();
		};
		if (opts.signal?.aborted) return stop();
		opts.signal?.addEventListener('abort', stop, { once: true });
		void go();
	});
}

export async function previewScene(c: SceneCliContext, args: readonly string[]): Promise<void> {
	if (!args[0] || typeof c.flags.out !== 'string' || typeof c.flags.times !== 'string')
		throw c.usage(
			'Usage: jasper preview <scene.yaml> --times 0.3,1,2.5,6 --out sheet.png [--watch] [--width N] [--columns N] [--timeout s]',
		);
	const times = parseTimes(c.flags.times);
	if (!times.length || times.length > 48) throw c.usage('--times takes 1…48 comma-separated times');
	const outPath = resolve(c.cwd, c.flags.out);
	if (!c.flags.watch) return previewOnce(c, args[0], times, outPath);
	const path = resolve(c.cwd, args[0]);
	c.out.stderr(`[jasper] watching ${path} (Ctrl+C stops)\n`);
	await watchScene({
		path,
		signal: c.signal,
		run: () => previewOnce(c, args[0]!, times, outPath),
		onError: (e) => {
			const body = (e as { body?: { error?: { code?: string; message?: string } } }).body;
			c.out.stderr(
				`jasper: ${body?.error?.code ?? 'ERROR'}: ${body?.error?.message ?? (e as Error).message}\n[jasper] still watching\n`,
			);
		},
	});
}

// --- export -------------------------------------------------------------------------------------------------------------

/** How an exported file names media: a path relative to the file when the media has one, else its id. */
function srcNamer(doc: ProjectDocument, outDir: string) {
	return (mediaId: string): string => {
		const m = doc.media[mediaId];
		const p = m?.mgBundle?.source.path ?? (m ? pathLocators(m)[0] : undefined);
		if (!p) return mediaId;
		const rel = relative(outDir, p);
		return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel.split(sep).join('/') : p;
	};
}

export async function exportSceneFile(c: SceneCliContext): Promise<void> {
	const projectId = await c.projectId();
	const { doc } = await loadDocument(c, projectId);
	const want = typeof c.flags.sequence === 'string' ? c.flags.sequence : undefined;
	let sequenceId: string | undefined;
	if (want) sequenceId = doc.sequences[want] ? want : findSceneSequence(doc, want).seq?.id;
	else {
		const live = await c.link
			.client()
			.then((cl) => cl.agentUi({ action: 'state', args: {} }))
			.then((r) => (r.result as { sequenceId?: string | null })?.sequenceId ?? null)
			.catch(() => null);
		sequenceId = live && doc.sequences[live] ? live : Object.keys(doc.sequences)[0];
	}
	if (!sequenceId) throw c.usage(want ? `No sequence "${want}" (id or name)` : 'The project has no sequence');
	const format = typeof c.flags.format === 'string' ? c.flags.format : undefined;
	if (format && format !== 'yaml' && format !== 'json') throw c.usage('--format is yaml or json');
	const outPath = typeof c.flags.out === 'string' ? resolve(c.cwd, c.flags.out) : null;
	const { file, warnings } = exportScene(doc, sequenceId, {
		registries,
		srcOf: srcNamer(doc, outPath ? dirname(outPath) : c.cwd),
	});
	for (const w of warnings) c.out.stderr(`[jasper] ${w}\n`);
	const text = formatSceneText(
		file,
		outPath ?? 'scene.yaml',
		format ?? (outPath ? undefined : c.json ? 'json' : 'yaml'),
	);
	if (!outPath) {
		c.out.stdout(text);
		return;
	}
	writeAtomic(outPath, text);
	const layers = (file.layers as unknown[]).length;
	if (c.json)
		c.out.stdout(
			`${JSON.stringify({ ok: true, out: outPath, sequence: sceneSequenceName(doc, sequenceId), layers, warnings })}\n`,
		);
	else
		c.out.stdout(
			`wrote ${outPath} (${layers} layer${layers === 1 ? '' : 's'} of "${sceneSequenceName(doc, sequenceId) ?? sequenceId}")\n`,
		);
}

export async function applyScene(c: SceneCliContext, args: readonly string[]): Promise<void> {
	if (!args[0]) throw c.usage('Usage: jasper apply <scene.yaml | scene.json> [--dry-run]');
	await applySceneFile(c, args[0]);
}
