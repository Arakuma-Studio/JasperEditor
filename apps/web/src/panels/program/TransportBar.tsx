// the monitors' transport bar and Button Editor (Premiere: the "+" at the end of the Program/Source button
// row; helpx "Customize the Program/Source Monitor buttons"): buttons are commands; the editor shows every
// available button — click one to add it at the end, drag buttons in the bar to reorder, × removes one, Reset Layout
// restores Premiere's default row. Layouts persist per monitor (monitor-view.ts `buttons`).
import { useStoreSelector } from '@jasper/session/react';
import {
	ArrowDownToLine,
	ArrowLeftToLine,
	ArrowRightToLine,
	ArrowUpFromLine,
	Bookmark,
	Camera,
	ChevronFirst,
	ChevronLast,
	Columns2,
	CornerRightDown,
	Expand,
	Film,
	Play,
	Plus,
	Repeat,
	Scissors,
	Square,
	StepBack,
	StepForward,
} from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { createPortal } from 'react-dom';
import { getCommand, isCommandChecked, runCommand } from '../../commands/registry.ts';
import type { CommandCtx } from '../../commands/types.ts';
import { TransportButton } from './MonitorChrome.tsx';
import { monitorExtras } from './monitor-view.ts';

type MonitorKind = 'program' | 'source';

type ButtonDef = {
	id: string;
	label: string;
	command: string;
	shortcut?: string;
	icon: ReactNode;
	monitors: readonly MonitorKind[];
	/** Stable automation ids of the default buttons (tests and agents rely on them). */
	testId?: Partial<Record<MonitorKind, string>>;
};

const txt = (s: string) => <span className="font-pr text-[13px] leading-none">{s}</span>;
const BOTH: readonly MonitorKind[] = ['program', 'source'];

/** Every button the editor offers. */
const BUTTONS: readonly ButtonDef[] = [
	{
		id: 'addMarker',
		label: 'Add Marker',
		command: 'timeline.addMarker',
		shortcut: 'M',
		icon: <Bookmark size={16} />,
		monitors: ['program'],
		testId: { program: 'btn-add-marker' },
	},
	{
		id: 'addSourceMarker',
		label: 'Add Marker',
		command: 'source.addMarker',
		shortcut: 'M',
		icon: <Bookmark size={16} />,
		monitors: ['source'],
	},
	{
		id: 'markIn',
		label: 'Mark In',
		command: 'timeline.markIn',
		shortcut: 'I',
		icon: <span className="font-pr text-[15px] leading-none">{'{'}</span>,
		monitors: BOTH,
		testId: { program: 'btn-mark-in', source: 'src-mark-in' },
	},
	{
		id: 'markOut',
		label: 'Mark Out',
		command: 'timeline.markOut',
		shortcut: 'O',
		icon: <span className="font-pr text-[15px] leading-none">{'}'}</span>,
		monitors: BOTH,
		testId: { program: 'btn-mark-out', source: 'src-mark-out' },
	},
	{ id: 'clearIn', label: 'Clear In', command: 'timeline.clearIn', icon: txt('{×'), monitors: BOTH },
	{ id: 'clearOut', label: 'Clear Out', command: 'timeline.clearOut', icon: txt('×}'), monitors: BOTH },
	{
		id: 'markClip',
		label: 'Mark Clip',
		command: 'timeline.markClip',
		shortcut: 'X',
		icon: txt('{X}'),
		monitors: ['program'],
	},
	{
		id: 'goToIn',
		label: 'Go to In',
		command: 'timeline.goToIn',
		shortcut: 'Shift+I',
		icon: <ArrowLeftToLine size={16} />,
		monitors: BOTH,
		testId: { program: 'btn-go-in', source: 'src-go-in' },
	},
	{
		id: 'prevEdit',
		label: 'Go to Previous Edit Point',
		command: 'transport.prevEdit',
		shortcut: 'Up',
		icon: <ChevronFirst size={16} />,
		monitors: ['program'],
	},
	{
		id: 'stepBack',
		label: 'Step Back 1 Frame',
		command: 'transport.stepBack',
		shortcut: 'Left',
		icon: <StepBack size={16} />,
		monitors: BOTH,
		testId: { program: 'btn-step-back', source: 'src-step-back' },
	},
	{
		id: 'play',
		label: 'Play/Stop',
		command: 'transport.playStop',
		shortcut: 'Space',
		icon: <Play size={16} />,
		monitors: BOTH,
		testId: { program: 'btn-play', source: 'src-play' },
	},
	{
		id: 'stepForward',
		label: 'Step Forward 1 Frame',
		command: 'transport.stepForward',
		shortcut: 'Right',
		icon: <StepForward size={16} />,
		monitors: BOTH,
		testId: { program: 'btn-step-forward', source: 'src-step-forward' },
	},
	{
		id: 'nextEdit',
		label: 'Go to Next Edit Point',
		command: 'transport.nextEdit',
		shortcut: 'Down',
		icon: <ChevronLast size={16} />,
		monitors: ['program'],
	},
	{
		id: 'goToOut',
		label: 'Go to Out',
		command: 'timeline.goToOut',
		shortcut: 'Shift+O',
		icon: <ArrowRightToLine size={16} />,
		monitors: BOTH,
		testId: { program: 'btn-go-out', source: 'src-go-out' },
	},
	{
		id: 'playInToOut',
		label: 'Play In to Out',
		command: 'transport.playInToOut',
		icon: txt('{▶}'),
		monitors: BOTH,
	},
	{
		id: 'playAround',
		label: 'Play Around',
		command: 'transport.playAround',
		shortcut: 'Shift+K',
		icon: txt('◀▶'),
		monitors: BOTH,
	},
	{
		id: 'loop',
		label: 'Loop',
		command: 'monitor.toggleLoop',
		shortcut: 'Ctrl+L',
		icon: <Repeat size={16} />,
		monitors: BOTH,
	},
	{
		id: 'lift',
		label: 'Lift',
		command: 'timeline.lift',
		shortcut: ';',
		icon: <ArrowUpFromLine size={16} />,
		monitors: ['program'],
		testId: { program: 'btn-lift' },
	},
	{
		id: 'extract',
		label: 'Extract',
		command: 'timeline.extract',
		shortcut: "'",
		icon: <Scissors size={16} />,
		monitors: ['program'],
		testId: { program: 'btn-extract' },
	},
	{
		id: 'insert',
		label: 'Insert',
		command: 'timeline.insertFromSource',
		shortcut: ',',
		icon: <CornerRightDown size={16} />,
		monitors: ['source'],
		testId: { source: 'src-insert' },
	},
	{
		id: 'overwrite',
		label: 'Overwrite',
		command: 'timeline.overwriteFromSource',
		shortcut: '.',
		icon: <ArrowDownToLine size={16} />,
		monitors: ['source'],
		testId: { source: 'src-overwrite' },
	},
	{
		id: 'matchFrame',
		label: 'Match Frame',
		command: 'timeline.matchFrame',
		shortcut: 'F',
		icon: txt('⇥F'),
		monitors: ['program'],
	},
	{
		id: 'reverseMatchFrame',
		label: 'Reverse Match Frame',
		command: 'timeline.reverseMatchFrame',
		shortcut: 'Shift+R',
		icon: txt('F⇤'),
		monitors: ['source'],
	},
	{
		id: 'trimEdit',
		label: 'Trim Edit',
		command: 'timeline.trimEdit',
		shortcut: 'Shift+T',
		icon: txt(']['),
		monitors: ['program'],
	},
	{
		id: 'comparison',
		label: 'Comparison View',
		command: 'program.toggleComparisonView',
		icon: <Columns2 size={16} />,
		monitors: ['program'],
	},
	{
		id: 'multicam',
		label: 'Toggle Multi-Camera View',
		command: 'program.toggleMulticamView',
		shortcut: 'Shift+0',
		icon: txt('▦'),
		monitors: ['program'],
	},
	{
		id: 'safeMargins',
		label: 'Safe Margins',
		command: 'program.toggleSafeMargins',
		icon: txt('▭'),
		monitors: ['program'],
	},
	{
		id: 'rulers',
		label: 'Show Rulers',
		command: 'program.showRulers',
		icon: txt('⊢'),
		monitors: ['program'],
	},
	{
		id: 'guides',
		label: 'Show Guides',
		command: 'program.showGuides',
		icon: txt('┼'),
		monitors: ['program'],
	},
	{
		id: 'exportFrame',
		label: 'Export Frame',
		command: 'export.frame',
		shortcut: 'Shift+E',
		icon: <Camera size={16} />,
		monitors: BOTH,
		testId: { program: 'btn-export-frame', source: 'src-export-frame' },
	},
	{
		// gaps (PRJ-8): Premiere's Toggle Proxies button (Button Editor; no default shortcut, assignable).
		id: 'toggleProxies',
		label: 'Toggle Proxies',
		command: 'media.toggleProxies',
		icon: <Film size={16} />,
		monitors: BOTH,
		testId: { program: 'btn-toggle-proxies', source: 'src-toggle-proxies' },
	},
	{
		id: 'fullScreen',
		label: 'Toggle Full Screen',
		command: 'monitor.fullScreenVideo',
		shortcut: 'Ctrl+`',
		icon: <Expand size={16} />,
		monitors: BOTH,
	},
];

/** Premiere's default rows (Program: Add Marker … Extract; Source: Mark In … Overwrite). */
export const DEFAULT_BUTTONS: Record<MonitorKind, string[]> = {
	program: [
		'addMarker',
		'markIn',
		'markOut',
		'goToIn',
		'stepBack',
		'play',
		'stepForward',
		'goToOut',
		'lift',
		'extract',
		// gaps (EX-3): Premiere's default rows end with Export Frame (the camera).
		'exportFrame',
	],
	source: [
		'markIn',
		'markOut',
		'goToIn',
		'stepBack',
		'play',
		'stepForward',
		'goToOut',
		'insert',
		'overwrite',
		'exportFrame',
	],
};

export function layoutFor(monitor: MonitorKind, stored: string[] | null): ButtonDef[] {
	const ids = stored ?? DEFAULT_BUTTONS[monitor];
	return ids
		.map((id) => BUTTONS.find((b) => b.id === id && b.monitors.includes(monitor)))
		.filter((b): b is ButtonDef => !!b);
}

function setLayout(monitor: MonitorKind, ids: string[] | null): void {
	monitorExtras.setState((s) => ({ buttons: { ...s.buttons, [monitor]: ids } }));
}

export function TransportBar(props: {
	monitor: MonitorKind;
	ctx: () => CommandCtx;
	playing: boolean;
	testId: string;
	disabled?: (b: ButtonDef) => boolean;
}) {
	const { monitor } = props;
	const stored = useStoreSelector(monitorExtras, (s) => s.buttons[monitor]);
	const [editing, setEditing] = useState(false);
	const [dragId, setDragId] = useState<string | null>(null);
	const row = layoutFor(monitor, stored);
	const ids = row.map((b) => b.id);
	const run = (b: ButtonDef) => void runCommand(b.command, props.ctx());
	const available = BUTTONS.filter((b) => b.monitors.includes(monitor) && !!getCommand(b.command));
	const move = (from: string, to: string) => {
		const next = ids.filter((x) => x !== from);
		next.splice(next.indexOf(to), 0, from);
		setLayout(monitor, next);
	};
	return (
		<div
			className="flex h-[36px] shrink-0 flex-wrap items-center justify-center gap-0.5 overflow-hidden px-2"
			data-testid={props.testId}
		>
			{row.map((b) => {
				const cmd = getCommand(b.command);
				const active = b.id === 'play' ? props.playing : cmd ? isCommandChecked(cmd, props.ctx()) : false;
				return (
					// biome-ignore lint/a11y/noStaticElementInteractions: drag-to-reorder surface of the Button Editor
					<span
						key={b.id}
						className="relative inline-flex"
						draggable={editing}
						onDragStart={() => setDragId(b.id)}
						onDragOver={(e) => editing && dragId && e.preventDefault()}
						onDrop={() => {
							if (dragId && dragId !== b.id) move(dragId, b.id);
							setDragId(null);
						}}
						data-button={b.id}
						data-testid={`${monitor}-btn-slot-${b.id}`}
					>
						<TransportButton
							label={b.id === 'play' ? (props.playing ? 'Stop' : 'Play') : b.label}
							shortcut={b.shortcut}
							testId={b.testId?.[monitor] ?? `${monitor}-btn-${b.id}`}
							active={b.id === 'play' || cmd?.checked ? active : undefined}
							disabled={!cmd || props.disabled?.(b)}
							onClick={() => run(b)}
						>
							{b.id === 'play' && props.playing ? <Square size={14} /> : b.icon}
						</TransportButton>
						{editing ? (
							<button
								type="button"
								className="absolute -top-1 -right-1 size-[12px] rounded-full bg-pr-raised text-[9px] leading-[12px] text-pr-text hover:bg-pr-danger"
								aria-label={`Remove ${b.label}`}
								onClick={() =>
									setLayout(
										monitor,
										ids.filter((x) => x !== b.id),
									)
								}
								data-testid={`${monitor}-btn-remove-${b.id}`}
							>
								×
							</button>
						) : null}
					</span>
				);
			})}
			<TransportButton
				label="Button Editor"
				testId={`${monitor}-button-editor`}
				active={editing}
				onClick={() => setEditing((x) => !x)}
			>
				<Plus size={14} />
			</TransportButton>
			{editing
				? createPortal(
						<div
							role="dialog"
							aria-label="Button Editor"
							className="fixed bottom-[60px] left-1/2 z-[var(--pr-z-popover)] w-[420px] -translate-x-1/2 rounded-pr-menu border border-pr-menu-border bg-pr-menu p-2 text-pr-ui text-pr-text shadow-pr-floating"
							data-testid={`${monitor}-button-editor-panel`}
						>
							<p className="mb-1 text-pr-small text-pr-muted">
								Click a button to add it to the bar; drag buttons in the bar to reorder, × removes one.
							</p>
							<div className="flex flex-wrap gap-1">
								{available.map((b) => (
									<button
										key={b.id}
										type="button"
										className="inline-flex h-[28px] items-center gap-1 rounded-pr-control border border-pr-border px-1.5 text-pr-small hover:bg-pr-hover disabled:opacity-40"
										disabled={ids.includes(b.id)}
										title={b.label}
										onClick={() => setLayout(monitor, [...ids, b.id])}
										data-testid={`${monitor}-palette-${b.id}`}
									>
										{b.icon}
										<span>{b.label}</span>
									</button>
								))}
							</div>
							<div className="mt-2 flex justify-end gap-2">
								<button
									type="button"
									className="rounded-pr-control px-2 py-0.5 hover:bg-pr-hover"
									onClick={() => setLayout(monitor, null)}
									data-testid={`${monitor}-button-editor-reset`}
								>
									Reset Layout
								</button>
								<button
									type="button"
									className="rounded-pr-control bg-pr-accent-fill px-2 py-0.5 text-pr-on-accent"
									onClick={() => setEditing(false)}
									data-testid={`${monitor}-button-editor-ok`}
								>
									OK
								</button>
							</div>
						</div>,
						document.body,
					)
				: null}
		</div>
	);
}
