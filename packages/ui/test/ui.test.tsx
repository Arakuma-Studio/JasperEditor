import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LABEL_COLORS } from '@jasper/project';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
	Button,
	DIALOG_ESCAPE_REVERTS,
	Dialog,
	escapeRevertsField,
	IconButton,
	popoverZClass,
	TimecodeText,
	useInDialog,
	Z,
} from '../src/index.ts';

const tokens = readFileSync(join(__dirname, '../src/theme/tokens.css'), 'utf8');

describe('@jasper/ui tokens', () => {
	it('defines every S05 §8.2/8.3/8.5/19.5 token and all label colors', () => {
		const required = [
			'--pr-bg-app',
			'--pr-bg-header',
			'--pr-bg-panel',
			'--pr-bg-panel-alt',
			'--pr-bg-panel-raised',
			'--pr-bg-field',
			'--pr-bg-field-deep',
			'--pr-bg-hover',
			'--pr-bg-pressed',
			'--pr-bg-selected-row',
			'--pr-border-subtle',
			'--pr-border',
			'--pr-border-strong',
			'--pr-text-primary',
			'--pr-text-strong',
			'--pr-text-secondary',
			'--pr-text-tertiary',
			'--pr-icon',
			'--pr-icon-hover',
			'--pr-accent',
			'--pr-accent-fill',
			'--pr-accent-fill-hover',
			'--pr-target-fill',
			'--pr-timecode',
			'--pr-value',
			'--pr-focus-ring',
			'--pr-tab-underline',
			'--pr-menu-bg',
			'--pr-menu-border',
			'--pr-tooltip-bg',
			'--pr-overlay-scrim',
			'--pr-danger',
			'--pr-warning',
			'--pr-success',
			'--pr-playhead',
			'--pr-inout-range',
			'--pr-inout-bracket',
			'--pr-workarea',
			'--pr-render-red',
			'--pr-render-yellow',
			'--pr-render-green',
			'--pr-snap-line',
			'--pr-trim-ripple',
			'--pr-trim-roll',
			'--pr-locked-hatch',
			'--pr-offline-clip',
			'--pr-keyframe',
			'--pr-keyframe-selected',
			'--pr-meter-green',
			'--pr-meter-yellow',
			'--pr-meter-red',
			'--pr-meter-peak-hold',
			'--pr-marker-green',
			'--pr-agent',
			'--pr-ghost-stroke',
			'--pr-ghost-fill',
			'--pr-ghost-remove',
			'--pr-engine-remotion',
			'--pr-engine-fframes',
			'--pr-engine-native',
			'--pr-gutter',
			'--pr-radius-frame',
			'--pr-radius-control',
			'--pr-radius-menu',
			'--pr-radius-pill',
			'--pr-radius-clip',
			'--pr-title-h',
			'--pr-header-h',
			'--pr-tab-h',
			'--pr-row-h',
			'--pr-control-h',
			'--pr-icon-btn',
			'--pr-track-header-w',
			'--pr-hit-min',
			'--pr-font-size-ui',
			'--pr-track-h-video',
			'--pr-track-h-audio',
			'--pr-track-h-text',
			'--pr-handle-w',
			'--pr-bottom-bar-h',
			'--pr-z-toast',
		];
		for (const t of required) expect(tokens, t).toContain(`${t}:`);
		for (const l of LABEL_COLORS) {
			expect(tokens).toContain(`--pr-label-${l}:`);
			expect(tokens).toContain(`--pr-label-${l}-tint:`);
		}
		expect(tokens).toContain('[data-pr-theme="dark"]');
		expect(tokens).toContain('[data-pr-contrast="high"]');
		expect(tokens).toContain('[data-pr-density="touch"]');
		expect(tokens).toContain('[data-pr-labels="classic"]');
		expect(tokens).toContain('[data-pr-labels="vibrant"]');
	});
	it('z-index scale is ordered and mirrored in CSS (S05:DT-030)', () => {
		const order = [
			Z.panel,
			Z.dockDrop,
			Z.floating,
			Z.maximized,
			Z.forcedCursor,
			Z.popover,
			Z.dialog,
			Z.tooltip,
			Z.dragGhost,
			Z.snapIndicator,
			Z.toast,
		];
		expect([...order].sort((a, b) => a - b)).toEqual(order);
		expect(tokens).toContain(`--pr-z-toast: ${Z.toast};`);
		expect(tokens).toContain(`--pr-z-dialog: ${Z.dialog};`);
	});
});

describe('@jasper/ui primitives', () => {
	it('renders buttons, icon buttons and timecode', () => {
		const onClick = vi.fn();
		render(
			<div>
				<Button variant="primary" onClick={onClick}>
					OK
				</Button>
				<IconButton icon="tool.razor" label="Razor Tool" shortcut="C" toggled="selected" />
				<IconButton icon="tool.ripple" label="Ripple Edit Tool" shortcut="B" />
				<TimecodeText value="00;01;00;02" size="timeline" />
			</div>,
		);
		fireEvent.click(screen.getByText('OK'));
		expect(onClick).toHaveBeenCalledOnce();
		expect(screen.getByLabelText('Razor Tool').getAttribute('title')).toBe('Razor Tool (C)');
		expect(screen.getByLabelText('Razor Tool').getAttribute('aria-pressed')).toBe('true');
		expect(screen.getByText('00;01;00;02').className).toContain('pr-tabular');
		expect(document.querySelector('[data-icon="tool.ripple"]')).toBeTruthy();
	});
});

describe('popovers inside dialogs (S05:DT-030)', () => {
	it('a Select list opened from a Dialog stacks above the dialog layer; elsewhere on the popover layer', () => {
		expect(popoverZClass(false)).toBe('z-[var(--pr-z-popover)]');
		expect(popoverZClass(true)).toBe('z-[calc(var(--pr-z-dialog)+10)]');
		let inside: boolean | null = null;
		let outside: boolean | null = null;
		function Probe({ into }: { into: (v: boolean) => void }) {
			into(useInDialog());
			return null;
		}
		render(
			<>
				<Probe into={(v) => (outside = v)} />
				<Dialog open onOpenChange={() => {}} title="T">
					<Probe into={(v) => (inside = v)} />
				</Dialog>
			</>,
		);
		expect(outside).toBe(false);
		expect(inside).toBe(true);
	});
});

describe('Esc in a dialog field being edited (DIALOG_ESCAPE_REVERTS)', () => {
	it('the first Esc stays with the edited field; Esc elsewhere closes the dialog', () => {
		const onOpenChange = vi.fn();
		render(
			<Dialog open onOpenChange={onOpenChange} title="T">
				<input data-testid="editing" {...{ [DIALOG_ESCAPE_REVERTS]: 'true' }} />
				<input data-testid="idle" />
			</Dialog>,
		);
		fireEvent.keyDown(screen.getByTestId('editing'), { key: 'Escape' });
		expect(onOpenChange).not.toHaveBeenCalled();
		fireEvent.keyDown(screen.getByTestId('idle'), { key: 'Escape' });
		expect(onOpenChange).toHaveBeenCalledWith(false);
		expect(escapeRevertsField(null)).toBe(false);
	});
});
