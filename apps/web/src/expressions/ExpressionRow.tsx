// Ordinary property rows do not need CodeMirror. Load its editor only once an expression row is visible.
import { loadable, useLoaded } from '../panels/lazy.ts';
import type { ExpressionRowProps } from './ExpressionRowEditor.tsx';

export { PICK_WHIP_ATTR } from './row.ts';

const editor = loadable(() => import('./ExpressionRowEditor.tsx').then((m) => m.ExpressionRowEditor));

export function ExpressionRow(props: ExpressionRowProps) {
	const state = useLoaded(editor);
	if (state.status === 'ready') return <state.Component {...props} />;
	if (state.status === 'loading')
		return (
			<div role="status" className="pl-[34px] text-pr-muted">
				Loading…
			</div>
		);
	return (
		<div role="alert" className="flex items-center gap-2 pl-[34px] text-pr-warning">
			<span>Could not load the expression editor.</span>
			<button type="button" onClick={() => window.location.reload()}>
				Reload editor
			</button>
		</div>
	);
}
