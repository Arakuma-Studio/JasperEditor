// A small document for expression tests: 1080p30, a solid "Bg" on V1, a solid "A" on V2 with a Slider Control,
// a text clip "Title" on V3, and helpers to run transactions.
import {
	applyTransaction,
	createCounterIdSource,
	createEmptyProject,
	defaultRegistries,
	type ProjectDocument,
	type TransactionResult,
} from '@jasper/project';

export class Doc {
	doc: ProjectDocument;
	readonly ids = createCounterIdSource(1);
	revision = 0;
	refs: Record<string, string> = {};
	constructor() {
		this.doc = createEmptyProject({ ids: this.ids, name: 'Expr', preset: 'hd-1080p-30' });
	}
	get seqId(): string {
		return Object.keys(this.doc.sequences)[0]!;
	}
	/** Applies commands; `$name` strings declared by earlier transactions are replaced by their ids. */
	tx(commands: unknown[]): TransactionResult {
		const sub = (v: unknown): unknown =>
			typeof v === 'string' && v.startsWith('$') && this.refs[v]
				? this.refs[v]
				: Array.isArray(v)
					? v.map(sub)
					: v && typeof v === 'object'
						? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === 'ref' ? x : sub(x)]))
						: v;
		commands = commands.map(sub);
		const { document, result } = applyTransaction(
			this.doc,
			{ label: 'test', origin: 'user', sequenceId: this.seqId, commands } as never,
			{
				ids: this.ids,
				now: () => '2026-10-07T00:00:00.000Z',
				revision: this.revision,
				registries: defaultRegistries(),
			},
		);
		if (!result.ok) throw new Error(JSON.stringify(result.errors));
		this.doc = document;
		this.revision = result.revision;
		Object.assign(this.refs, result.refs);
		return result;
	}
}

/** Fixture with refs $bg, $a, $title, $slider (Slider Control on A). */
export function basicDoc(): Doc {
	const d = new Doc();
	d.tx([
		{ type: 'clip.addSolid', at: 0, duration: 300, track: 'V1', color: [0, 0, 1, 1], name: 'Bg', ref: '$bg' },
		{ type: 'clip.addSolid', at: 30, duration: 120, track: 'V2', color: [1, 0, 0, 1], name: 'A', ref: '$a' },
		{
			type: 'clip.addText',
			at: 0,
			duration: 300,
			track: 'V3',
			content: { text: 'Hello' },
			name: 'Title',
			ref: '$title',
		},
		{ type: 'effect.add', target: { clipId: '$a' }, effectId: 'jasper.slider-control', ref: '$slider' },
		{
			type: 'param.set',
			target: ['effect', '$slider', 'slider'],
			value: 42,
		},
	]);
	return d;
}
