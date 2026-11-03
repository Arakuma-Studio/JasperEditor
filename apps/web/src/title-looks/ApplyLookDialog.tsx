// `Graphics ▸ Apply Look…` (TL-086): the same grid as the Looks tab, in a dialog, so it works in every workspace.
import type { EditorSession } from '@jasper/session';
import { SessionProvider } from '@jasper/session/react';
import { Dialog, type HostedDialogProps } from '@jasper/ui';
import { useEffect } from 'react';
import { LooksBrowser } from './LooksBrowser.tsx';
import { endPreview } from './preview.ts';

export const APPLY_LOOK_DIALOG = 'titleLooks.apply';

export function ApplyLookDialog(props: HostedDialogProps<{ session: EditorSession }>) {
	useEffect(() => () => endPreview(props.session), [props.session]);
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) props.close(undefined);
			}}
			title="Apply Look"
			description="Hovering a look previews it on the selected clip. Nothing changes until you click."
			size="large"
		>
			<div className="h-[60vh] min-h-[320px]" data-testid="apply-look-dialog">
				{/* The dialog host sits above the session provider. */}
				<SessionProvider session={props.session}>
					<LooksBrowser session={props.session} onUsed={() => props.close(true)} />
				</SessionProvider>
			</div>
		</Dialog>
	);
}
