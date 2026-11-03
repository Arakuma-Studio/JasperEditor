// Motion Templates ▸ Looks (TL-086). The neighbours keep their own homes (TL-055): this tab links to them.
import { useSessionOrNull } from '@jasper/session/react';
import { revealSection } from '../panels/properties/controls/Section.tsx';
import { useShellRuntimeOrNull } from '../shell/context.tsx';
import { LooksBrowser } from './LooksBrowser.tsx';

function Link(props: { label: string; title: string; onClick(): void }) {
	return (
		<button
			type="button"
			className="shrink-0 text-pr-small text-pr-accent hover:underline"
			title={props.title}
			onClick={props.onClick}
		>
			{props.label}
		</button>
	);
}

export function LooksTab(props: { onShowTemplates(): void }) {
	const session = useSessionOrNull();
	const shell = useShellRuntimeOrNull();
	if (!session)
		return <p className="p-2 text-center text-pr-small text-pr-muted">Open a project to use looks.</p>;
	const focus = (id: string) => void shell?.run(id);
	return (
		<LooksBrowser
			session={session}
			links={
				<>
					<Link
						label="Text Styles"
						title="Typography and basic paint, in Properties"
						onClick={() => {
							revealSection('properties.textStyle');
							focus('panel.focus.properties');
						}}
					/>
					<Link
						label="Effect Presets"
						title="Stacks of ordinary effects, in the Effects panel"
						onClick={() => focus('panel.focus.effects')}
					/>
					<Link
						label="Templates"
						title="Motion templates that create clips"
						onClick={props.onShowTemplates}
					/>
				</>
			}
		/>
	);
}
