// imports workstream: the import steps of File ▸ Import / drops that are specific to the new formats
// (docs/wp-notes/imports.md), called by the import service (`import/service.ts`):
// 1. image sequences — numbered stills among the picked files (uploads) or paths (desktop; a single numbered still
//    whose folder holds its siblings counts too) become one clip each when the user says so (frame rate prompt);
// 2. multi-page PDF / Illustrator documents — the chosen pages become one item each;
// 3. layered documents (PSD) — Merge All Layers (the flattened item), Merged Layers (one picture of the chosen
//    layers), Individual Layers (a bin of layers) or Sequence (the layers stacked; `layeredImportCommands`).
import {
	type LayeredExtractResult,
	type LayeredLayer,
	type RegisteredMedia,
	toLayeredImportLayers,
} from '@jasper/api';
import type { EngineClient } from '@jasper/engine-client';
import {
	type CommandInput,
	groupImageSequences,
	importedDescriptors,
	type LayeredImportLayer,
	layeredImportCommands,
	type Rational,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { LOCAL_ENGINE_ID } from '../import/assets.ts';
import { baseName } from '../import/desktop.ts';
import type { ImportFailure, ImportPrompts } from '../import/prompts.ts';

export type FlowAcquired = { reg: RegisteredMedia; name: string; path: string | null };

const errorInfo = (e: unknown) => ({
	code: (e as { code?: string })?.code ?? 'ERROR',
	message: e instanceof Error ? e.message : String(e),
});

/** The frame rate offered for image sequences: the active sequence's, else 30 fps. */
export function defaultSequenceRate(session: EditorSession): Rational {
	const st = session.getState();
	const seq = st.activeSequenceId ? st.document.sequences[st.activeSequenceId] : undefined;
	return seq ? { num: seq.settings.frameRate.num, den: seq.settings.frameRate.den } : { num: 30, den: 1 };
}

async function finishedJobResult<T>(
	engine: EngineClient,
	job: { id: string; state: string; result?: unknown; error?: { message?: string; code?: string } | null },
): Promise<T> {
	let j = job;
	while (!['succeeded', 'failed', 'cancelled', 'interrupted'].includes(j.state)) {
		await new Promise((r) => setTimeout(r, 300));
		j = await engine.getJob(job.id);
	}
	if (j.state !== 'succeeded') {
		const err = new Error(j.error?.message ?? `Job ${j.state}`) as Error & { code?: string };
		err.code = j.error?.code ?? 'JOB_FAILED';
		throw err;
	}
	return j.result as T;
}

/**
 * Step 1: image sequences. Returns the registered sequences and the files / paths left for the regular import.
 * Without the prompt (agents, tests) nothing changes.
 */
export async function acquireImageSequences(
	deps: { engine: EngineClient; session: EditorSession; prompts: ImportPrompts },
	input: { files: File[]; paths: string[] },
): Promise<{ acquired: FlowAcquired[]; failed: ImportFailure[]; files: File[]; paths: string[] }> {
	const { engine, session, prompts } = deps;
	const acquired: FlowAcquired[] = [];
	const failed: ImportFailure[] = [];
	let files = input.files;
	let paths = input.paths;
	if (!prompts.imageSequence) return { acquired, failed, files, paths };
	const projectId = session.projectId;
	// Uploaded files: groups among the picked names.
	const fileGroups = groupImageSequences(files.map((f) => f.name)).sequences;
	// Desktop paths: groups among the picked paths, or one numbered still with siblings in its folder.
	const pathGroups = groupImageSequences(paths.map(baseName)).sequences;
	let detected: { path: string; label: string; count: number; missing: number } | null = null;
	if (paths.length === 1 && pathGroups.length === 0) {
		try {
			const d = await engine.detectImageSequence(paths[0]!);
			if (d.count >= 2)
				detected = {
					path: paths[0]!,
					label: d.pattern,
					count: d.last - d.first + 1,
					missing: d.missing.length,
				};
		} catch {
			detected = null;
		}
	}
	const groups = [
		...fileGroups.map((g) => ({ label: g.label, frames: g.last - g.first + 1, missing: g.missingCount })),
		...pathGroups.map((g) => ({ label: g.label, frames: g.last - g.first + 1, missing: g.missingCount })),
		...(detected ? [{ label: detected.label, frames: detected.count, missing: detected.missing }] : []),
	];
	if (!groups.length) return { acquired, failed, files, paths };
	const choice = await prompts.imageSequence({ groups, defaultRate: defaultSequenceRate(session) });
	if (!choice.asSequence) return { acquired, failed, files, paths };
	const frameRate = choice.frameRate;
	for (const g of fileGroups) {
		const names = new Set(g.frames.map((x) => x.name));
		const frames = files.filter((f) => names.has(f.name));
		files = files.filter((f) => !names.has(f.name));
		try {
			const uploadIds: string[] = [];
			let next = 0;
			const worker = async () => {
				for (let i = next++; i < frames.length; i = next++) {
					uploadIds[i] = await engine.uploadSequenceFrame(frames[i]!, {
						projectId,
						fileName: frames[i]!.name,
					});
				}
			};
			await Promise.all(Array.from({ length: Math.min(4, frames.length) }, worker));
			const job = await engine.importImageSequence({ projectId, uploadIds, frameRate, name: g.label });
			const reg = await finishedJobResult<RegisteredMedia>(engine, job);
			acquired.push({ reg, name: g.label, path: null });
		} catch (e) {
			failed.push({ name: g.label, ...errorInfo(e) });
		}
	}
	for (const g of pathGroups) {
		const names = new Set(g.frames.map((x) => x.name));
		const mine = paths.filter((p) => names.has(baseName(p)));
		paths = paths.filter((p) => !names.has(baseName(p)));
		try {
			const job = await engine.importImageSequence({ projectId, paths: mine, frameRate, name: g.label });
			acquired.push({
				reg: await finishedJobResult<RegisteredMedia>(engine, job),
				name: g.label,
				path: null,
			});
		} catch (e) {
			failed.push({ name: g.label, ...errorInfo(e) });
		}
	}
	if (detected) {
		paths = paths.filter((p) => p !== detected!.path);
		try {
			const job = await engine.importImageSequence({
				projectId,
				path: detected.path,
				frameRate,
				name: detected.label,
			});
			acquired.push({
				reg: await finishedJobResult<RegisteredMedia>(engine, job),
				name: detected.label,
				path: null,
			});
		} catch (e) {
			failed.push({ name: detected.label, ...errorInfo(e) });
		}
	}
	return { acquired, failed, files, paths };
}

/** A registered layer → the asset fields of its picture. */
function layerAsset(reg: RegisteredMedia): LayeredImportLayer['asset'] {
	return {
		kind: reg.kind,
		fingerprint: reg.fingerprint,
		originalName: reg.originalName,
		sizeBytes: reg.sizeBytes,
		container: reg.container,
		probe: JSON.parse(JSON.stringify(reg.probe)),
		locators: [{ type: 'engine-store', engineId: LOCAL_ENGINE_ID, key: reg.mediaKey }],
		...importedDescriptors(reg),
	};
}

export function toImportLayers(layers: readonly LayeredLayer[]): LayeredImportLayer[] {
	return toLayeredImportLayers(layers, layerAsset);
}

/**
 * Steps 2 and 3, on the registered files: PDF pages (each chosen page another entry) and layered documents. Returns the
 * entries to register (a PSD imported as layers is replaced by its layers' commands) and the extra commands (bins,
 * layer media, sequences) of the same transaction.
 */
export async function expandImports(
	deps: { engine: EngineClient; session: EditorSession; prompts: ImportPrompts },
	acquired: FlowAcquired[],
	binId: string | null,
): Promise<{ acquired: FlowAcquired[]; commands: CommandInput[]; failed: ImportFailure[]; notes: string[] }> {
	const { engine, session, prompts } = deps;
	const out: FlowAcquired[] = [];
	const commands: CommandInput[] = [];
	const failed: ImportFailure[] = [];
	const notes: string[] = [];
	let docIndex = 0;
	for (const a of acquired) {
		const v = a.reg.vector;
		if (v?.format === 'pdf' && (v.pageCount ?? 1) > 1 && prompts.pdfPages) {
			try {
				const info = await engine.vectorPages(a.reg.mediaKey);
				const chosen = await prompts.pdfPages({ name: a.name, pages: info.pages });
				for (const page of chosen.length ? chosen : [1]) {
					const p = info.pages.find((x) => x.page === page) ?? info.pages[0]!;
					const w = Math.max(1, Math.round(p.width));
					const h = Math.max(1, Math.round(p.height));
					out.push({
						...a,
						name: chosen.length > 1 || page !== 1 ? `${a.name} (page ${page})` : a.name,
						reg: {
							...a.reg,
							vector: { ...v, page: p.page, width: p.width, height: p.height },
							probe: {
								...a.reg.probe,
								streams: a.reg.probe.streams.map((s) =>
									s.type === 'video' ? { ...s, width: w, height: h } : s,
								),
							},
						},
					});
				}
			} catch (e) {
				failed.push({ name: a.name, ...errorInfo(e) });
				out.push(a);
			}
			continue;
		}
		if (a.reg.layered && prompts.layered) {
			try {
				const job = await engine.extractLayers(a.reg.mediaKey, session.projectId);
				const result = await finishedJobResult<LayeredExtractResult>(engine, job);
				const choice = await prompts.layered({ name: a.name, result });
				if (choice.mode === 'merged-all') {
					out.push(a);
					continue;
				}
				if (choice.mode === 'merged') {
					const mj = await engine.extractLayers(a.reg.mediaKey, session.projectId, false, choice.selected);
					const merged = (await finishedJobResult<LayeredExtractResult>(engine, mj)).merged;
					if (!merged) throw new Error('The engine made no merged picture');
					out.push({ reg: merged, name: `${a.name} (merged)`, path: null });
					continue;
				}
				const docName = a.name.replace(/\.(psd|psb)$/i, '');
				const built = layeredImportCommands({
					docName,
					documentSize: { width: result.info.width, height: result.info.height },
					frameRate: defaultSequenceRate(session),
					layers: toImportLayers(result.layers),
					selected: new Set(choice.selected),
					mode: choice.mode,
					binId,
					now: new Date().toISOString(),
					refPrefix: `$ld${docIndex++}`,
				});
				commands.push(...built.commands);
				notes.push(...built.notes);
			} catch (e) {
				failed.push({ name: a.name, ...errorInfo(e) });
				out.push(a);
			}
			continue;
		}
		out.push(a);
	}
	return { acquired: out, commands, failed, notes };
}
