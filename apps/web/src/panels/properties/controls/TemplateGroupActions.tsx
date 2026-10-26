// WP7a: header actions of a template param group, contributed by the custom controls its params use
// (`TemplateParamControlDef.groupActions`, e.g. the social-comment "Randomize stats" wand). Each action renders once per
// group, isolated like a control: a throwing action becomes a one-line error and the panel keeps working.
import type { Clip, PropertySpec } from '@jasper/project';
import type { SessionState } from '@jasper/session';
import { useSessionOrNull, useStoreSelector } from '@jasper/session/react';
import { Component, type ErrorInfo, type ReactNode } from 'react';
import {
	type TemplateGroupAction,
	type TemplateGroupActionProps,
	templateParamControls,
} from '../../../extensions/index.ts';
import { useRegistry } from '../../../extensions/react.ts';
import { applyTemplateParamPatch, clipParams, controlOf } from '../lib/template-params.ts';
import type { RowContext } from './PropertyRow.tsx';

class ActionBoundary extends Component<{ id: string; children: ReactNode }, { error: Error | null }> {
	state: { error: Error | null } = { error: null };
	static getDerivedStateFromError(error: unknown) {
		return { error: error instanceof Error ? error : new Error(String(error)) };
	}
	componentDidCatch(error: unknown, info: ErrorInfo) {
		console.warn(`[properties] template group action "${this.props.id}" failed`, error, info.componentStack);
	}
	render() {
		if (!this.state.error) return this.props.children;
		return (
			<span
				role="alert"
				className="truncate text-pr-small text-pr-danger"
				title={this.state.error.message}
				data-testid="template-group-action-error"
			>
				{`Action "${this.props.id}" failed`}
			</span>
		);
	}
}

const NO_SESSION_STORE = { getState: (): SessionState | null => null, subscribe: () => () => {} };

/** The actions of the group showing `specs` for `clips` (null when none of its controls contributes one). */
export function TemplateGroupActions(props: {
	ctx: Pick<RowContext, 'doc' | 'seq' | 'ops' | 'transport' | 'hint'>;
	clips: readonly Clip[];
	specs: readonly Pick<PropertySpec, 'key' | 'ui'>[];
	label: string;
}) {
	const { ctx, clips, specs } = props;
	const controls = useRegistry(templateParamControls);
	const session = useSessionOrNull();
	const readOnly = useStoreSelector(
		session?.store ?? NO_SESSION_STORE,
		(st: SessionState | null) => st?.readOnly === true,
	);
	const actions: TemplateGroupAction[] = [];
	for (const s of specs)
		for (const a of controlOf(s, controls)?.groupActions ?? [])
			if (!actions.some((x) => x.id === a.id)) actions.push(a);
	if (!actions.length || !clips.length) return null;
	const paramNames = specs.map((s) => s.key.slice('params.'.length));
	const onChangeParams: TemplateGroupActionProps['onChangeParams'] = (patch, opts) =>
		applyTemplateParamPatch(
			{
				doc: ctx.doc,
				seq: ctx.seq,
				ops: ctx.ops,
				frame: () => ctx.transport.getState().frame,
				hint: ctx.hint,
			},
			clips,
			session?.ctx.registries.mgTemplates,
			patch,
			props.label,
			opts,
		);
	return (
		<span className="flex items-center gap-[2px]" data-template-group-actions>
			{actions.map((a) => (
				<ActionBoundary key={a.id} id={a.id}>
					<a.component
						clipIds={clips.map((c) => c.id)}
						params={clipParams(clips[0]!)}
						paramNames={paramNames}
						onChangeParams={onChangeParams}
						disabled={readOnly}
					/>
				</ActionBoundary>
			))}
		</span>
	);
}
