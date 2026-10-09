// Edit ▸ Find… (Ctrl+F; workstream gaps, docs/wp-notes/gaps.md §UI-5). Premiere's Find dialog: two criteria rows
// (column, operator, text), Match All / Any, Match Case. In the Project panel it searches project items and selects
// the next match (Find) or every match (Find All), revealing it in its bin; in the Timeline it searches clips (clip
// name, source name, text content) and markers, selects the next hit after the playhead and moves the playhead there.
import {
	FIND_OPERATOR_LABELS,
	FIND_OPERATORS,
	type FindOperator,
	type FindQuery,
	findHitKey,
	findProjectItems,
	findTimelineHits,
	nextFindHit,
	PROJECT_FIND_FIELD_LABELS,
	PROJECT_FIND_FIELDS,
	type ProjectFindField,
	TIMELINE_FIND_FIELD_LABELS,
	TIMELINE_FIND_FIELDS,
	type TimelineFindField,
} from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import {
	Button,
	Checkbox,
	Dialog,
	type HostedDialogProps,
	registerDialog,
	Select,
	TextField,
} from '@jasper/ui';
import { useRef, useState } from 'react';
import { getProjectPanel } from '../panels/project/instances.ts';

export const FIND_DIALOG = 'gaps.find';

export type FindScope = 'project' | 'timeline';
type Row = { field: string; operator: FindOperator; value: string };

/** Last query per scope (the dialog reopens with it, as Premiere's does). */
const lastQuery: Record<FindScope, { rows: Row[]; match: 'all' | 'any'; matchCase: boolean }> = {
	project: {
		rows: [
			{ field: 'name', operator: 'contains', value: '' },
			{ field: 'label', operator: 'contains', value: '' },
		],
		match: 'all',
		matchCase: false,
	},
	timeline: {
		rows: [
			{ field: 'clipName', operator: 'contains', value: '' },
			{ field: 'marker', operator: 'contains', value: '' },
		],
		match: 'all',
		matchCase: false,
	},
};

export type FindDialogProps = {
	session: EditorSession;
	scope: FindScope;
	/** The sequence searched by the Timeline scope (the active one). */
	sequenceId?: string | null;
	/** Moves the playhead and scrolls the timeline (supplied by the command). */
	seek?(frame: number): void;
};

/** Runs one Find step; returns a status line. Exported for tests and the MCP-equivalent UI path. */
export function runFind(
	props: FindDialogProps,
	query: FindQuery<string>,
	mode: 'next' | 'all',
	cursor: { key: string | null },
): string {
	const { session } = props;
	const doc = session.getCommitted();
	if (props.scope === 'project') {
		const ids = findProjectItems(doc, query as FindQuery<ProjectFindField>);
		if (!ids.length) return 'No items match.';
		if (mode === 'all') {
			session.select('project', ids, 'replace');
			getProjectPanel()?.reveal?.(ids[0]!);
			cursor.key = ids[0]!;
			return `${ids.length} item${ids.length === 1 ? '' : 's'} selected.`;
		}
		const at = cursor.key ? ids.indexOf(cursor.key) : -1;
		const next = ids[(at + 1) % ids.length]!;
		cursor.key = next;
		session.select('project', [next], 'replace');
		getProjectPanel()?.reveal?.(next);
		return `Match ${ids.indexOf(next) + 1} of ${ids.length}.`;
	}
	const seqId = props.sequenceId ?? session.getState().activeSequenceId;
	if (!seqId) return 'No sequence is open.';
	const hits = findTimelineHits(doc, seqId, query as FindQuery<TimelineFindField>);
	if (!hits.length) return 'Nothing in the sequence matches.';
	if (mode === 'all') {
		const clips = [...new Set(hits.flatMap((h) => (h.kind === 'clip' ? [h.clipId] : [])))];
		session.select('timeline', clips, 'replace');
		props.seek?.(hits[0]!.frame);
		cursor.key = findHitKey(hits[0]!);
		return `${clips.length} clip${clips.length === 1 ? '' : 's'} selected (${hits.length} match${hits.length === 1 ? '' : 'es'}).`;
	}
	const hit = nextFindHit(hits, session.transport.getState().frame, cursor.key);
	if (!hit) return 'Nothing in the sequence matches.';
	cursor.key = findHitKey(hit);
	session.select('timeline', hit.kind === 'clip' ? [hit.clipId] : hit.clipId ? [hit.clipId] : [], 'replace');
	props.seek?.(hit.frame);
	return `Match ${hits.indexOf(hit) + 1} of ${hits.length}.`;
}

function FindDialog(props: HostedDialogProps<FindDialogProps>) {
	const init = lastQuery[props.scope];
	const [rows, setRows] = useState<Row[]>(init.rows.map((r) => ({ ...r })));
	const [match, setMatch] = useState<'all' | 'any'>(init.match);
	const [matchCase, setMatchCase] = useState(init.matchCase);
	const [status, setStatus] = useState<string | null>(null);
	const cursor = useRef<{ key: string | null }>({ key: null });
	const fields =
		props.scope === 'project'
			? PROJECT_FIND_FIELDS.map((f) => ({ value: f, label: PROJECT_FIND_FIELD_LABELS[f] }))
			: TIMELINE_FIND_FIELDS.map((f) => ({ value: f, label: TIMELINE_FIND_FIELD_LABELS[f] }));
	const ops = FIND_OPERATORS.map((o) => ({ value: o, label: FIND_OPERATOR_LABELS[o] }));
	const empty = rows.every((r) => !r.value);
	const query = (): FindQuery<string> => ({ criteria: rows, match, matchCase });
	const go = (mode: 'next' | 'all') => {
		lastQuery[props.scope] = { rows, match, matchCase };
		setStatus(runFind(props, query(), mode, cursor.current));
	};
	const setRow = (i: number, patch: Partial<Row>) => {
		cursor.current.key = null;
		setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
	};
	return (
		<Dialog
			open
			onOpenChange={(o) => !o && props.close()}
			title={props.scope === 'project' ? 'Find in Project' : 'Find in Sequence'}
			size="medium"
			primaryLabel="Find"
			primaryDisabled={empty}
			cancelLabel="Done"
			onPrimary={() => {
				go('next');
				return false;
			}}
			footerExtra={
				<Button variant="secondary" disabled={empty} onClick={() => go('all')} data-testid="find-all">
					Find All
				</Button>
			}
			data-testid="find-dialog"
		>
			<div className="flex flex-col gap-2">
				{rows.map((r, i) => (
					<fieldset
						// biome-ignore lint/suspicious/noArrayIndexKey: two fixed criteria rows
						key={i}
						className="grid grid-cols-[150px_150px_minmax(0,1fr)] items-center gap-2"
						aria-label={`Criterion ${i + 1}`}
					>
						<Select
							label={`Column ${i + 1}`}
							value={r.field}
							onValueChange={(v) => setRow(i, { field: v })}
							options={fields}
						/>
						<Select
							label={`Operator ${i + 1}`}
							value={r.operator}
							onValueChange={(v) => setRow(i, { operator: v as FindOperator })}
							options={ops}
						/>
						<TextField
							aria-label={`Find what ${i + 1}`}
							data-testid={`find-value-${i}`}
							value={r.value}
							autoFocus={i === 0}
							onChange={(e) => setRow(i, { value: e.target.value })}
						/>
					</fieldset>
				))}
				<div className="flex items-center gap-4">
					<Select
						label="Match"
						className="w-24"
						value={match}
						onValueChange={(v) => {
							cursor.current.key = null;
							setMatch(v as 'all' | 'any');
						}}
						options={[
							{ value: 'all', label: 'All' },
							{ value: 'any', label: 'Any' },
						]}
					/>
					<Checkbox
						checked={matchCase}
						onCheckedChange={(c) => {
							cursor.current.key = null;
							setMatchCase(c);
						}}
						label="Match Case"
					/>
				</div>
				<p className="min-h-5 text-pr-small text-pr-muted" role="status" data-testid="find-status">
					{status ?? ''}
				</p>
			</div>
		</Dialog>
	);
}

let registered = false;
export function registerFindDialog(): void {
	if (registered) return;
	registered = true;
	registerDialog(FIND_DIALOG, FindDialog);
}
