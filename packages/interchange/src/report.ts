// What an import or export could not represent exactly. Importers and exporters never fail on unsupported
// *features*; they record them here. Identical entries are merged with a count.

export type ReportLevel = 'info' | 'warning';

/** The clip, effect, transition, … an entry is about (exports name every uncarried clip individually). */
export type ReportSubject = {
	kind: 'clip' | 'effect' | 'transition' | 'marker' | 'track' | 'sequence' | 'media' | 'document';
	/** Id in the exported JasperEditor document (or the IR id on import). */
	id?: string;
	name?: string;
	/** Sequence frame (exports) where the subject starts. */
	frame?: number;
};

export type ReportEntry = {
	level: ReportLevel;
	message: string;
	count: number;
	subject?: ReportSubject;
	/** What was written (export) or created (import) instead, e.g. "a clip item without media". */
	instead?: string;
};

export class Report {
	readonly entries: ReportEntry[] = [];

	push(level: ReportLevel, message: string, extra: { subject?: ReportSubject; instead?: string } = {}): void {
		const same = this.entries.find(
			(e) =>
				e.level === level &&
				e.message === message &&
				e.instead === extra.instead &&
				JSON.stringify(e.subject) === JSON.stringify(extra.subject),
		);
		if (same) same.count++;
		else
			this.entries.push({
				level,
				message,
				count: 1,
				...(extra.subject ? { subject: extra.subject } : {}),
				...(extra.instead !== undefined ? { instead: extra.instead } : {}),
			});
	}

	warn(message: string, extra?: { subject?: ReportSubject; instead?: string }): void {
		this.push('warning', message, extra);
	}

	info(message: string, extra?: { subject?: ReportSubject; instead?: string }): void {
		this.push('info', message, extra);
	}

	get warnings(): ReportEntry[] {
		return this.entries.filter((e) => e.level === 'warning');
	}

	/** Whether any entry's message contains `needle` (case-insensitive). */
	mentions(needle: string): boolean {
		const n = needle.toLowerCase();
		return this.entries.some((e) => e.message.toLowerCase().includes(n));
	}

	merge(other: Report | readonly ReportEntry[]): void {
		const list = other instanceof Report ? other.entries : other;
		for (const e of list)
			for (let i = 0; i < e.count; i++)
				this.push(e.level, e.message, {
					...(e.subject ? { subject: e.subject } : {}),
					...(e.instead !== undefined ? { instead: e.instead } : {}),
				});
	}

	toString(): string {
		return this.entries
			.map(
				(e) =>
					`${e.level}: ${e.message}${e.instead ? ` → ${e.instead}` : ''}${e.count > 1 ? ` (×${e.count})` : ''}`,
			)
			.join('\n');
	}
}

/** A failure to read a document at all (not JSON / XML, wrong root, truncated container, …). */
export class InterchangeError extends Error {
	constructor(
		readonly code: 'PARSE' | 'EMPTY' | 'NO_SEQUENCE' | 'UNSUPPORTED',
		message: string,
	) {
		super(message);
		this.name = 'InterchangeError';
	}
}

export function parseError(format: string, message: string): InterchangeError {
	return new InterchangeError('PARSE', `${format}: ${message}`);
}
