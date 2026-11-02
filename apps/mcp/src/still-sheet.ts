// Spec 19 TL-103: a sheet of stills as one engine job (`still-sheet`): one progress, one timeout, one cancel. Tools submit
// documents and cells here and get `{jobId, timedOut}` back; a sheet that outlives the wait stays a job the agent can pick
// up (`render_frames {jobId}`). The drawing the engine does not do (safe-area guides, cell numbers, downscaling) is here.
import { STILL_SHEET_LIMITS, type StillSheetRequest, type StillSheetResult, StillSheetResultSchema } from '@jasper/api';
import { EngineError } from '@jasper/engine-client';
import { TITLE_SAFE_MARGINS } from '@jasper/project';
import { cancelIfAborted, type Extra, isTerminal, type ToolContext, waitJob } from './context.ts';
import { ToolError } from './errors.ts';
import { hline, vline } from './motion-strip.ts';
import { drawText, GLYPH_HEIGHT, textWidth } from './pixel-font.ts';
import { composeGrid, decodePng, encodePng } from './png.ts';
import type { RgbaImage } from './sound-sheet.ts';
import { failedJobError, renderToolError } from './tools/templates.ts';

/** Most bytes one request may carry: the engine's body limit less a margin for the JSON around the documents. */
const MAX_REQUEST_BYTES = 19 * 1024 * 1024;

export const DEFAULT_SHEET_TIMEOUT_SEC = 120;
export const MAX_SHEET_TIMEOUT_SEC = 900;

export type SheetOutcome =
	| { done: true; jobId: string; result: StillSheetResult }
	| { done: false; jobId: string; state: string };

/** What the agent does with a sheet still rendering. */
export const sheetNext = (jobId: string, tool = 'render_frames') =>
	`The sheet is still rendering as job ${jobId}: wait_for_job {jobId: "${jobId}"}, then ${tool} {jobId: "${jobId}"} returns it. cancel_job stops it.`;

/** Submits a sheet. A request that would exceed the engine's body limit is refused here, naming what to drop. */
export async function submitSheet(ctx: ToolContext, req: StillSheetRequest, extra?: Extra): Promise<string> {
	const bytes = req.documents.reduce((n, d) => n + JSON.stringify(d).length, 0);
	if (bytes > MAX_REQUEST_BYTES)
		throw new ToolError(
			'E_TOO_LARGE',
			`The ${req.documents.length} documents of this sheet are ${Math.round(bytes / 1e6)} MB; one sheet carries at most ${Math.round(MAX_REQUEST_BYTES / 1e6)} MB`,
			'Render fewer alternatives (each is a copy of the project document), or check them one at a time.',
		);
	if (req.cells.length > STILL_SHEET_LIMITS.maxCells)
		throw new ToolError(
			'E_LIMIT',
			`A sheet holds at most ${STILL_SHEET_LIMITS.maxCells} frames (${req.cells.length} asked)`,
			'Ask for fewer frames or fewer alternatives.',
		);
	const job = await ctx.engine((c) => c.requestStillSheet(req)).catch((e) => renderToolError(ctx, e));
	await cancelIfAborted(ctx, extra, job.id);
	return job.id;
}

/** Waits for a sheet (cancelled with the request). A job that failed is a tool error; one still running is not. */
export async function awaitSheet(
	ctx: ToolContext,
	jobId: string,
	timeoutSec: number,
	extra?: Extra,
): Promise<SheetOutcome> {
	const { job, timedOut } = await waitJob(ctx, jobId, timeoutSec * 1000, extra);
	if (timedOut || !isTerminal(job)) return { done: false, jobId, state: job.state };
	if (job.state !== 'succeeded')
		throw await failedJobError(ctx, job, 'Check get_timeline; engine_status shows the render setup.', {
			jobId,
		});
	const r = StillSheetResultSchema.safeParse(job.result);
	if (!r.success) throw new ToolError('E_INTERNAL', 'The engine returned an unreadable sheet', undefined, { jobId });
	return { done: true, jobId, result: r.data };
}

/** The finished sheet job `jobId`, or where it is. E_NOT_FOUND for another kind of job. */
export async function sheetOfJob(ctx: ToolContext, jobId: string): Promise<SheetOutcome> {
	const job = await ctx
		.engine((c) => c.getJob(jobId))
		.catch((e) => {
			if (e instanceof EngineError && (e.code === 'JOB_NOT_FOUND' || e.status === 404))
				throw new ToolError('E_NOT_FOUND', `No job ${jobId}`, 'The sheet may have been cleaned up: render it again.');
			throw e;
		});
	if (job.kind !== 'still-sheet')
		throw new ToolError('E_INVALID_PARAM', `${jobId} is a ${job.kind} job, not a sheet`);
	return awaitSheet(ctx, jobId, 0);
}

/** The decoded cells, in order. */
export async function sheetImages(ctx: ToolContext, r: StillSheetResult): Promise<RgbaImage[]> {
	return Promise.all(
		r.cells.map(async (cell) => {
			const { bytes } = await ctx.engine((c) => c.fetchBytes(cell.url));
			return decodePng(bytes);
		}),
	);
}

/** Box-filter reduction to `width` (never up), for cells rendered larger than the sheet shows them. */
export function downscale(img: RgbaImage, width: number): RgbaImage {
	if (width >= img.width) return img;
	const k = img.width / width;
	const height = Math.max(1, Math.round(img.height / k));
	const data = new Uint8Array(width * height * 4);
	for (let y = 0; y < height; y++)
		for (let x = 0; x < width; x++) {
			const x0 = Math.floor(x * k);
			const x1 = Math.max(x0 + 1, Math.min(img.width, Math.floor((x + 1) * k)));
			const y0 = Math.floor(y * k);
			const y1 = Math.max(y0 + 1, Math.min(img.height, Math.floor((y + 1) * k)));
			const sum = [0, 0, 0, 0];
			for (let v = y0; v < y1; v++)
				for (let u = x0; u < x1; u++)
					for (let c = 0; c < 4; c++) sum[c]! += img.data[(v * img.width + u) * 4 + c]!;
			const n = (x1 - x0) * (y1 - y0);
			for (let c = 0; c < 4; c++) data[(y * width + x) * 4 + c] = Math.round(sum[c]! / n);
		}
	return { width, height, data };
}

/** The Program monitor's safe margins on a cell: action safe and title safe, in the monitor's 55 % white. */
export function drawSafeArea(img: RgbaImage): void {
	const white: [number, number, number] = [255, 255, 255];
	for (const percent of [TITLE_SAFE_MARGINS.action, TITLE_SAFE_MARGINS.title]) {
		const x0 = Math.round((img.width * percent) / 100);
		const y0 = Math.round((img.height * percent) / 100);
		const x1 = img.width - 1 - x0;
		const y1 = img.height - 1 - y0;
		hline(img, x0, x1, y0, white, false, 0.55);
		hline(img, x0, x1, y1, white, false, 0.55);
		vline(img, x0, y0, y1, white, false, 0.55);
		vline(img, x1, y0, y1, white, false, 0.55);
	}
}

/** The cell's number on a dark tab in its top left corner. */
export function drawCellNumber(img: RgbaImage, n: number): void {
	const scale = img.width >= 240 ? 2 : 1;
	const label = String(n);
	const w = textWidth(label, scale) + 4 * scale;
	const h = GLYPH_HEIGHT * scale + 4 * scale;
	for (let y = 0; y < Math.min(h, img.height); y++)
		for (let x = 0; x < Math.min(w, img.width); x++) {
			const p = (y * img.width + x) * 4;
			img.data[p] = 0;
			img.data[p + 1] = 0;
			img.data[p + 2] = 0;
			img.data[p + 3] = 255;
		}
	drawText(img, label, 2 * scale, 2 * scale, [255, 255, 255], scale);
}

/** What a sheet remembers of itself in the job (`meta`), so `render_frames {jobId}` can compose it later. */
export type SheetMeta = {
	columns: number;
	/** Cell width in the sheet; cells are reduced to it when they were rendered larger. */
	cellWidth?: number;
	overlay?: 'safe-area';
	numbered?: boolean;
	/** Per cell of the sheet (cells not listed are measurement frames, not shown). */
	shown: { cell: number; timecode?: string; label?: string }[];
};

const SHEET_GAP = 4;

/** One PNG of the cells `meta` shows, and the JSON that says what each is. */
export async function composeSheet(ctx: ToolContext, r: StillSheetResult, images?: readonly RgbaImage[]) {
	const meta = r.meta as SheetMeta | undefined;
	const all = images ?? (await sheetImages(ctx, r));
	const shown: SheetMeta['shown'] = meta?.shown ?? r.cells.map((c) => ({ cell: c.index }));
	const cells = shown.map(({ cell }, i) => {
		let img = all[cell]!;
		if (meta?.cellWidth) img = downscale(img, meta.cellWidth);
		// never draw on what the check measures
		img = { ...img, data: img.data.slice() };
		if (meta?.overlay === 'safe-area') drawSafeArea(img);
		if (meta?.numbered) drawCellNumber(img, i + 1);
		return img;
	});
	const columns = Math.max(1, Math.min(meta?.columns ?? 4, cells.length));
	const sheet = composeGrid(cells, columns, SHEET_GAP);
	const renderedBy = [...new Set(r.cells.map((c) => c.renderPath))];
	return {
		body: {
			columns,
			rows: sheet.rows,
			cellWidth: sheet.cellWidth,
			cellHeight: sheet.cellHeight,
			sheet: { width: sheet.width, height: sheet.height },
			cells: shown.map((c, i) => ({
				cell: i + 1,
				row: Math.floor(i / columns) + 1,
				column: (i % columns) + 1,
				frame: r.cells[c.cell]!.frame,
				...(c.timecode ? { timecode: c.timecode } : {}),
				...(c.label ? { label: c.label } : {}),
			})),
			...(renderedBy.length ? { renderedBy } : {}),
		},
		image: {
			type: 'image' as const,
			data: encodePng(sheet).toString('base64'),
			mimeType: 'image/png',
		},
	};
}
