// jasper-proc NDJSON events (stderr) → job progress (S07:PRC-011, PRU-002).
import type { ProcEvent } from './proc/types.ts';

export type ProgressSink = (progress: number | null, stage: string) => void;

/** Parses NDJSON lines; non-JSON lines (warnings) go to `onText`. */
export function createEventParser(onEvent: (e: ProcEvent) => void, onText?: (line: string) => void) {
	let buf = '';
	return (chunk: string) => {
		buf += chunk;
		for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
			const line = buf.slice(0, nl).trim();
			buf = buf.slice(nl + 1);
			if (!line) continue;
			if (line.startsWith('{')) {
				try {
					onEvent(JSON.parse(line) as ProcEvent);
					continue;
				} catch {
					// fall through
				}
			}
			onText?.(line);
		}
	};
}

/**
 * Tracks per-step fractions and turns them into overall progress + a stage text
 * ("Step 2/3 · upscale(span) · 41/90"). `base`/`span` map the processing into a part of the job
 * (remote jobs reserve room for upload/download).
 */
export class ProgressTracker {
	private readonly fractions: number[];
	notes: string[] = [];
	error: { code: string; message: string } | null = null;
	done: { frames: number; sidecar: string } | null = null;

	constructor(
		readonly steps: number,
		private readonly sink: ProgressSink,
		private readonly base = 0,
		private readonly span = 1,
	) {
		this.fractions = new Array(Math.max(1, steps)).fill(0);
	}

	handle(e: ProcEvent): void {
		switch (e.event) {
			case 'start':
				this.sink(this.base, `Processing ${e.frames} frames`);
				break;
			case 'progress': {
				const f = e.total > 0 ? Math.min(1, e.done / e.total) : 0;
				if (e.step >= 0 && e.step < this.fractions.length) {
					// Analysis passes count for the first half of a two-pass step.
					const v = e.stage.endsWith(': analysis') ? f * 0.5 : f;
					this.fractions[e.step] = Math.max(this.fractions[e.step], v);
					// A step that produces frames has finished the steps before it.
					for (let i = 0; i < e.step; i++) this.fractions[i] = Math.max(this.fractions[i], v);
				}
				const stage = `Step ${Math.min(e.step + 1, this.steps)}/${this.steps} · ${e.stage} · ${e.done}/${e.total}`;
				const overall = this.fractions.reduce((a, b) => a + b, 0) / this.fractions.length;
				this.sink(this.base + this.span * overall, stage);
				break;
			}
			case 'note':
				this.notes.push(e.message);
				break;
			case 'done':
				this.done = { frames: e.frames, sidecar: e.sidecar };
				this.sink(this.base + this.span, 'Verifying');
				break;
			case 'error':
				this.error = { code: e.code, message: e.message };
				break;
		}
	}
}
