// Tools panel (S05:TOOL-001…005, R-PUI §10, S02:TL-590): a 40 px strip of 28×28 tool buttons with
// flyout groups (long-press 350 ms or right-click). The active tool is session state
// (`toggles.activeTool`) so the Timeline and the Program monitor read the same value.
import type { ActiveTool } from '@jasper/session';
import { useSessionOrNull, useSessionState } from '@jasper/session/react';
import { ICONS, Icon, type IconId } from '@jasper/ui';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { TOOL_GROUPS, TOOLS, type ToolId } from '../timeline/model/tools.ts';
import type { PanelProps } from '../types.ts';

const LONG_PRESS_MS = 350;
const FACE_KEY = 'jasper.tools.faces.v1';

function ToolGlyph({ tool, size = 16 }: { tool: ToolId; size?: number }) {
	const id = TOOLS[tool].icon;
	if (id in ICONS) return <Icon id={id as IconId} size={size} />;
	if (tool === 'trackSelectBackward')
		return (
			<span className="inline-flex" style={{ transform: 'scaleX(-1)' }}>
				<Icon id="tool.trackSelectForward" size={size} />
			</span>
		);
	return <Icon id="tool.selection" size={size} />;
}

function loadFaces(): Record<number, ToolId> {
	try {
		return JSON.parse(globalThis.localStorage?.getItem(FACE_KEY) ?? '{}') as Record<number, ToolId>;
	} catch {
		return {};
	}
}

function tooltipFor(tool: ToolId): string {
	const t = TOOLS[tool];
	return t.key ? `${t.label} (${t.key})` : t.label;
}

export function ToolsPanel(_props: PanelProps) {
	const session = useSessionOrNull();
	if (!session)
		return (
			<div className="flex h-full items-center justify-center p-1 text-center text-pr-small text-pr-dim">
				No project
			</div>
		);
	return <ToolStrip />;
}

function ToolStrip() {
	const active = useSessionState((s) => s.toggles.activeTool);
	const [faces, setFaces] = useState<Record<number, ToolId>>(loadFaces);
	const [flyout, setFlyout] = useState<number | null>(null);
	const [horizontal, setHorizontal] = useState(false);
	const rootRef = useRef<HTMLDivElement>(null);
	const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const sessionRef = useSessionOrNullRef();

	useLayoutEffect(() => {
		const el = rootRef.current;
		if (!el || typeof ResizeObserver === 'undefined') return;
		const ro = new ResizeObserver(() => {
			const r = el.getBoundingClientRect();
			setHorizontal(r.width > r.height && r.width > 0);
		});
		ro.observe(el);
		return () => ro.disconnect();
	}, []);

	useEffect(() => {
		if (flyout === null) return;
		const close = (e: PointerEvent) => {
			if (!rootRef.current?.contains(e.target as Node)) setFlyout(null);
		};
		window.addEventListener('pointerdown', close, true);
		return () => window.removeEventListener('pointerdown', close, true);
	}, [flyout]);

	const choose = (group: number, tool: ToolId) => {
		sessionRef.current?.setToggles({ activeTool: tool as ActiveTool });
		const next = { ...faces, [group]: tool };
		setFaces(next);
		try {
			globalThis.localStorage?.setItem(FACE_KEY, JSON.stringify(next));
		} catch {
			/* storage unavailable */
		}
		setFlyout(null);
	};

	return (
		<div
			ref={rootRef}
			className={`relative flex h-full w-full items-center gap-[4px] overflow-visible p-[6px] ${horizontal ? 'flex-row' : 'flex-col'}`}
			role="toolbar"
			aria-label="Tools"
			aria-orientation={horizontal ? 'horizontal' : 'vertical'}
			data-testid="tools-panel"
		>
			{TOOL_GROUPS.map((group, gi) => {
				const face = group.includes(active) ? active : (faces[gi] ?? group[0]!);
				const selected = group.includes(active);
				return (
					<div key={group.join(',')} className="relative">
						<button
							type="button"
							className={`relative inline-flex size-[28px] items-center justify-center rounded-pr-control ${
								selected
									? 'bg-pr-accent-fill text-pr-on-accent'
									: 'text-pr-icon hover:bg-pr-hover hover:text-pr-icon-hover'
							}`}
							title={tooltipFor(face)}
							aria-label={TOOLS[face].label}
							aria-pressed={selected}
							data-tool={face}
							onPointerDown={() => {
								if (group.length < 2) return;
								pressTimer.current = setTimeout(() => setFlyout(gi), LONG_PRESS_MS);
							}}
							onPointerUp={() => {
								if (pressTimer.current) clearTimeout(pressTimer.current);
								pressTimer.current = null;
							}}
							onClick={() => {
								if (flyout === gi) return;
								choose(gi, face);
							}}
							onContextMenu={(e) => {
								if (group.length < 2) return;
								e.preventDefault();
								setFlyout(gi);
							}}
						>
							<ToolGlyph tool={face} />
							{group.length > 1 ? (
								<span
									className="absolute right-[2px] bottom-[2px] size-0"
									style={{
										borderLeft: '3px solid transparent',
										borderBottom: '3px solid currentColor',
									}}
								/>
							) : null}
						</button>
						{flyout === gi ? (
							<div
								className={`absolute top-0 flex flex-col rounded-pr-menu border border-pr-menu-border bg-pr-menu py-1 shadow-pr-overlay ${horizontal ? 'top-full left-0' : 'left-full ml-1'}`}
								style={{ zIndex: 1000 }}
								role="menu"
								data-testid="tools-flyout"
							>
								{group.map((t) => (
									<button
										key={t}
										type="button"
										role="menuitemradio"
										aria-checked={active === t}
										className="flex h-[24px] items-center gap-2 px-2 text-left text-pr-ui whitespace-nowrap text-pr-text hover:bg-pr-hover"
										onClick={() => choose(gi, t)}
										data-tool-option={t}
									>
										<ToolGlyph tool={t} />
										<span className="flex-1">{TOOLS[t].label}</span>
										<span className="text-pr-muted">{TOOLS[t].key}</span>
									</button>
								))}
							</div>
						) : null}
					</div>
				);
			})}
		</div>
	);
}

function useSessionOrNullRef() {
	const session = useSessionOrNull();
	const ref = useRef(session);
	ref.current = session;
	return ref;
}
