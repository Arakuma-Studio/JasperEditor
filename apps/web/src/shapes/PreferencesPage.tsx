// Edit ▸ Preferences ▸ Graphics (S11:SHP-007, S03:TXT-020): "Resize shapes by size". Applies immediately.
import { Checkbox } from '@jasper/ui';
import { PrefGroup, PrefRow } from '../shell/preferences/GeneralPage.tsx';
import { shapePrefs, useShapePrefs } from './prefs.ts';

export function GraphicsPreferencesPage() {
	const prefs = useShapePrefs();
	return (
		<div data-testid="prefs-graphics">
			<PrefGroup title="Shapes">
				<PrefRow label="Program monitor handles">
					<Checkbox
						checked={prefs.resizeBySize}
						onCheckedChange={(c) => shapePrefs.set({ resizeBySize: c })}
						label="Resize shapes by size"
					/>
				</PrefRow>
				<p className="pl-[172px] text-pr-small text-pr-muted">
					Handles change a shape&apos;s width and height instead of its Motion scale, so strokes keep their
					width.
				</p>
			</PrefGroup>
		</div>
	);
}
