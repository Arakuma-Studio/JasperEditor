// The overlays feature packages register over the Program monitor (ARCHITECTURE §19.10), each behind its own error
// boundary (AGENTS §0): one that throws, in render or in `active()`, is hidden and leaves a notice with Retry in a
// corner of the picture, instead of replacing the Program panel. The notices stack in one place.
import { Button, Icon, PanelErrorBoundary } from '@jasper/ui';
import { useState } from 'react';
import { createPortal } from 'react-dom';
import type { ProgramOverlayDef, ProgramOverlayHostProps } from '../../extensions/index.ts';
import { t } from '../../i18n/runtime.ts';

function OverlaySlot({ def, ...props }: { def: ProgramOverlayDef } & ProgramOverlayHostProps) {
	if (!def.active(props.session)) return null;
	const C = def.component;
	return <C {...props} />;
}

function OverlayFailed(props: { def: ProgramOverlayDef; error: Error; retry(): void }) {
	const name = props.def.label ?? t('A Program overlay');
	const text = t('{0} is hidden: {1}', name, props.error.message);
	return (
		<div
			role="alert"
			className="pointer-events-auto flex max-w-[420px] items-center gap-2 rounded-pr-control bg-pr-tooltip px-2 py-1 text-pr-small shadow"
			data-testid="program-overlay-failed"
			data-overlay={props.def.id}
		>
			<span className="shrink-0 text-pr-danger">
				<Icon id="status.error" size={12} />
			</span>
			<span className="min-w-0 flex-1 truncate" title={text}>
				{text}
			</span>
			<Button variant="quiet" onClick={props.retry}>
				Retry
			</Button>
		</div>
	);
}

export function ProgramOverlayLayers({
	overlays,
	...props
}: { overlays: readonly ProgramOverlayDef[] } & ProgramOverlayHostProps) {
	const [notices, setNotices] = useState<HTMLDivElement | null>(null);
	return (
		<>
			{overlays.map((def) => (
				<PanelErrorBoundary
					key={def.id}
					name={def.id}
					onError={(error) => console.error(`[program] overlay "${def.id}" failed`, error)}
					fallback={(error, retry) => {
						const notice = <OverlayFailed def={def} error={error} retry={retry} />;
						return notices ? createPortal(notice, notices) : notice;
					}}
				>
					<OverlaySlot def={def} {...props} />
				</PanelErrorBoundary>
			))}
			<div
				ref={setNotices}
				className="pointer-events-none absolute bottom-2 left-2 z-10 flex flex-col items-start gap-1"
				data-testid="program-overlay-notices"
			/>
		</>
	);
}
