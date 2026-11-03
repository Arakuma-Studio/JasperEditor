// Spec 19 TL-115: Split Image. Ported from Pachislop src/ui/SplitImageDialog.tsx: the picture's alpha islands are grouped
// into parts by the merge distance, each tinted in its own colour; click selects a part, Shift-click merges another into
// it or splits a merged part back into its islands. The engine decodes and cuts, so no canvas ever touches the pixels that
// are kept; the canvases here only draw the preview.
import {
	MAX_SPLIT_PARTS,
	mediaRegisterCommand,
	type RegisteredMedia,
	type SplitImageAnalysis,
	type SplitImageResult,
} from '@jasper/api';
import type { EngineClient } from '@jasper/engine-client';
import { clusterIslands, DEFAULT_MERGE, type ImagePart, type PxBox, partsOf } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { Dialog, type HostedDialogProps, registerDialog, TextField } from '@jasper/ui';
import { type PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from 'react';
import { t } from '../i18n/runtime.ts';
import { errorText } from '../processing/engine-jobs.ts';
import { cancelJob, cancelQuietly, type JobProgress, runToEnd, useDialogJob } from './shared.ts';

export const SPLIT_IMAGE_DIALOG = 'delivery.splitImage';

// Part tints are data on a preview canvas, not interface colour. tokens-allow
const PALETTE = ['#ff6b3d', '#2f9bff', '#3fd17a', '#ffc233', '#b26bff', '#18c8c8', '#ff4f9a', '#a3d13b']; // tokens-allow
const RGB = PALETTE.map(
	(h) => [1, 3, 5].map((k) => Number.parseInt(h.slice(k, k + 2), 16)) as [number, number, number],
);
const colorOf = (i: number) => PALETTE[i % PALETTE.length]!;

const pct = (v: number, of: number) => `${(v / of) * 100}%`;

type Props = {
	session: EditorSession;
	engine: EngineClient;
	clipId: string;
	clipName: string;
	sequenceId: string;
	mediaKey: string;
	imageUrl: string;
};

/** Reads the label map exactly: an opaque PNG, so no alpha rounding or colour conversion touches the indices. */
async function readLabels(
	engine: EngineClient,
	url: string,
): Promise<{ data: Uint8ClampedArray; w: number; h: number }> {
	const res = await fetch(engine.url(url), {
		credentials: 'include',
		headers: engine.authorizationHeaders(),
	});
	const bmp = await createImageBitmap(await res.blob(), {
		colorSpaceConversion: 'none',
		premultiplyAlpha: 'none',
	});
	const c = new OffscreenCanvas(bmp.width, bmp.height).getContext('2d', { willReadFrequently: true })!;
	c.drawImage(bmp, 0, 0);
	const img = c.getImageData(0, 0, bmp.width, bmp.height);
	return { data: img.data, w: bmp.width, h: bmp.height };
}

function SplitImageDialog(props: Props & HostedDialogProps) {
	const { session, engine, clipId, clipName, sequenceId, mediaKey, imageUrl } = props;
	const [analysis, setAnalysis] = useState<SplitImageAnalysis | null>(null);
	const [labels, setLabels] = useState<{ data: Uint8ClampedArray; w: number; h: number } | null>(null);
	const [merge, setMerge] = useState(DEFAULT_MERGE);
	const [parts, setParts] = useState<ImagePart[]>([]);
	const [sel, setSel] = useState<number | null>(null);
	const [progress, setProgress] = useState<JobProgress | null>(null);
	const [error, setError] = useState<string | null>(null);
	const tintRef = useRef<HTMLCanvasElement>(null);
	const job = useDialogJob();
	const signal = useRef<AbortSignal | null>(null);

	// The analysis is a job too: closing the dialog stops following it and cancels it.
	useEffect(() => {
		const ctl = new AbortController();
		const off = ctl.signal;
		(async () => {
			const started = await engine.call('splitImageAnalyze', { params: { key: mediaKey } });
			if (off.aborted) return cancelQuietly(engine, started.id);
			const a = await runToEnd<SplitImageAnalysis>(engine, started, () => undefined, off);
			if (!a || off.aborted) return;
			const l = await readLabels(engine, a.labelMapUrl);
			if (off.aborted) return;
			setAnalysis(a);
			setLabels(l);
		})().catch((e) => !off.aborted && setError(errorText(e)));
		return () => ctl.abort();
	}, [engine, mediaKey]);

	useEffect(() => {
		if (analysis) {
			setParts(clusterIslands(analysis, merge));
			setSel(null);
		}
	}, [analysis, merge]);

	const partOfIsland = useMemo(() => {
		const out = new Int32Array(analysis?.islands.length ?? 0).fill(-1);
		parts.forEach((p, pi) => {
			for (const i of p.islands) out[i] = pi;
		});
		return out;
	}, [analysis, parts]);

	// Each part's pixels tinted in its colour (the selected one stronger).
	useEffect(() => {
		const c = tintRef.current;
		if (!labels || !c) return;
		c.width = labels.w;
		c.height = labels.h;
		const tint = new ImageData(labels.w, labels.h);
		for (let i = 0; i < labels.w * labels.h; i++) {
			const o = labels.data[i * 4]! | (labels.data[i * 4 + 1]! << 8);
			if (!o) continue;
			const p = partOfIsland[o - 1]!;
			if (p < 0) continue;
			const [r, g, b] = RGB[p % RGB.length]!;
			tint.data.set([r, g, b, Math.round(labels.data[i * 4 + 2]! * (p === sel ? 0.75 : 0.45))], i * 4);
		}
		c.getContext('2d')?.putImageData(tint, 0, 0);
	}, [labels, partOfIsland, sel]);

	const regroup = (groups: number[][], keep: number | null) => {
		if (!analysis) return;
		const next = partsOf(analysis.islands, groups);
		setParts(next);
		setSel(keep === null ? null : next.findIndex((p) => p.islands.includes(keep)));
	};

	const hit = (x: number, y: number): number | null => {
		if (!analysis || !labels) return null;
		const cx = Math.min(labels.w - 1, Math.max(0, Math.floor(x / analysis.cell)));
		const cy = Math.min(labels.h - 1, Math.max(0, Math.floor(y / analysis.cell)));
		const i = (cy * labels.w + cx) * 4;
		const o = labels.data[i]! | (labels.data[i + 1]! << 8);
		if (o) return partOfIsland[o - 1]! >= 0 ? partOfIsland[o - 1]! : null;
		let best: number | null = null;
		let area = Number.POSITIVE_INFINITY;
		parts.forEach(({ box: b }: { box: PxBox }, p) => {
			const a = (b.x1 - b.x0) * (b.y1 - b.y0);
			if (x >= b.x0 && x < b.x1 && y >= b.y0 && y < b.y1 && a < area) {
				best = p;
				area = a;
			}
		});
		return best;
	};

	const onStage = (e: ReactPointerEvent<HTMLDivElement>) => {
		if (!analysis) return;
		const r = e.currentTarget.getBoundingClientRect();
		const p = hit(
			((e.clientX - r.left) / r.width) * analysis.width,
			((e.clientY - r.top) / r.height) * analysis.height,
		);
		if (p === null) {
			if (!e.shiftKey) setSel(null);
			return;
		}
		if (!e.shiftKey || sel === null) return setSel(p);
		const others = parts.filter((_, i) => i !== p && i !== sel).map((q) => q.islands);
		if (p === sel) {
			// Shift-click on the selected part: back into its islands.
			if (parts[p]!.islands.length > 1) regroup([...others, ...parts[p]!.islands.map((i) => [i])], null);
			return;
		}
		const merged = [...parts[sel]!.islands, ...parts[p]!.islands];
		regroup([...others, merged], merged[0]!);
	};

	const split = async () => {
		const run = job.start();
		signal.current = run;
		setError(null);
		setProgress({ id: '', stage: 'Queued', fraction: null });
		try {
			const started = await engine.call('splitImage', {
				params: { key: mediaKey },
				body: { groups: parts.map((p) => p.islands), projectId: session.projectId },
			});
			if (run.aborted) return cancelQuietly(engine, started.id);
			const done = await runToEnd<SplitImageResult>(engine, started, setProgress, run);
			if (run.aborted) return;
			if (!done) return setProgress(null);
			const media = done.parts.map((p, i) => ({
				...mediaRegisterCommand(p.media as RegisteredMedia, `$m${i}`, `$i${i}`, `${clipName} ${i + 1}`),
			}));
			const r = session.apply({
				label: 'Split Image',
				origin: 'user',
				sequenceId,
				commands: [
					...media,
					{
						type: 'clip.splitImage' as const,
						clipId,
						parts: done.parts.map((p, i) => ({
							mediaId: `$m${i}`,
							box: p.box,
							name: `${clipName} ${i + 1}`,
						})),
					},
				],
			});
			if (!r.ok) {
				setProgress(null);
				setError(r.errors[0]?.message ?? 'The split could not be applied');
				return;
			}
			props.close((r.results.at(-1) as { clipIds: string[] }).clipIds);
		} catch (e) {
			if (run.aborted) return;
			setProgress(null);
			setError(errorText(e));
		}
	};

	/**
	 * Cancel: a running job is cancelled on the engine (the dialog stays until it stops), a refusal is shown; a write still
	 * queued has no job yet, so the dialog closes and the job is cancelled when it arrives.
	 */
	const cancel = () => {
		if (progress?.id)
			void cancelJob(engine, progress.id).catch(
				(e: unknown) =>
					!signal.current?.aborted && setError(t('The job could not be cancelled: {0}', errorText(e))),
			);
		else if (progress) {
			job.abort();
			props.close();
		}
	};

	const n = parts.length;
	return (
		<Dialog
			open
			onOpenChange={(o) => !o && !progress && props.close()}
			title={`Split Image · ${clipName}`}
			size="large"
			primaryLabel={progress ? 'Splitting…' : n === 1 ? 'Split' : `Split into ${n} parts`}
			primaryDisabled={!analysis || n < 2 || n > MAX_SPLIT_PARTS || !!progress}
			cancelLabel={progress?.id ? 'Cancel split' : 'Cancel'}
			onCancel={cancel}
			onPrimary={() => {
				void split();
				return false;
			}}
			data-testid="split-dialog"
		>
			<div className="mb-2 flex items-center gap-2">
				<span className="text-pr-muted">Merge distance</span>
				<TextField
					aria-label="Merge distance in percent of the long side"
					data-testid="split-merge"
					className="w-20"
					type="number"
					value={String(merge)}
					min={0}
					max={10}
					step={0.1}
					onChange={(e) => {
						const v = Number(e.target.value);
						setMerge(Number.isFinite(v) ? Math.min(10, Math.max(0, v)) : 0);
					}}
				/>
				<span className="text-pr-muted">%</span>
				<span className="ml-auto text-pr-muted" aria-live="polite" data-testid="split-count">
					{analysis ? (n === 1 ? '1 part' : `${n} parts`) : ''}
				</span>
			</div>
			{analysis ? (
				<div
					role="presentation"
					data-testid="split-stage"
					className="relative mx-auto cursor-pointer bg-pr-panel-alt"
					style={{
						aspectRatio: `${analysis.width} / ${analysis.height}`,
						width: `min(100%, calc(56vh * ${analysis.width / analysis.height}))`,
					}}
					onPointerUp={onStage}
				>
					<img src={imageUrl} alt="" className="absolute inset-0 size-full" draggable={false} />
					<canvas ref={tintRef} className="absolute inset-0 size-full" />
					{parts.map((p, i) => (
						<div
							key={p.islands[0]}
							className="pointer-events-none absolute border"
							style={{
								left: pct(p.box.x0, analysis.width),
								top: pct(p.box.y0, analysis.height),
								width: pct(p.box.x1 - p.box.x0, analysis.width),
								height: pct(p.box.y1 - p.box.y0, analysis.height),
								borderColor: colorOf(i),
								borderWidth: i === sel ? 2 : 1,
							}}
						/>
					))}
				</div>
			) : error ? null : (
				<p className="text-pr-muted">Finding the parts…</p>
			)}
			<p className="mt-2 text-pr-small text-pr-muted">
				Click a part to select it. Shift-click another part to merge it in, or a merged part to split it into
				its islands. Each part becomes a clip of its own, grouped, in one undo step.
			</p>
			{n > MAX_SPLIT_PARTS ? (
				<p role="alert" className="mt-2 text-pr-small text-pr-danger" data-testid="split-too-many">
					{`At most ${MAX_SPLIT_PARTS} parts: raise the merge distance.`}
				</p>
			) : null}
			{progress ? (
				<p className="mt-2 text-pr-small text-pr-muted" aria-live="polite" data-testid="split-progress">
					{progress.stage || 'Splitting…'}
				</p>
			) : null}
			{error ? (
				<p role="alert" className="mt-2 text-pr-small text-pr-danger">
					{error}
				</p>
			) : null}
		</Dialog>
	);
}

let registered = false;
export function registerSplitImageDialog(): void {
	if (registered) return;
	registered = true;
	registerDialog(SPLIT_IMAGE_DIALOG, SplitImageDialog);
}
