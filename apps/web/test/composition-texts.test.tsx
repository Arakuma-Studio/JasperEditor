// Properties ▸ Composition ▸ Text (M3, wp-m3-mgtext, S08:MGU-006): the text editors of a composition clip — texts
// in manifest order with their style props, live preview while typing (transient document, no History entry),
// one "Edit Text" entry on apply, Esc reverts, schema errors are not applied, measured layout warnings and the
// bundle's fonts in the font menu (the measuring page is faked here; e2e/mg-texts.spec.ts runs the real one).
import type { MgCompositionInfo } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CompositionSection } from '../src/mg-bundles/CompositionSection.tsx';
import { endCanvasTextEdit } from '../src/mg-bundles/text-edit.ts';
import { makeSession, renderWithSession } from './inspector-helpers.tsx';
import { labels } from './tracking-helpers.tsx';

const measure = vi.fn();
vi.mock('../src/mg-bundles/text-measure.ts', () => ({ textMeasurer: () => ({ measure }) }));

const HEX = { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' };
const LOWER_THIRD: MgCompositionInfo = {
	id: 'LowerThird',
	width: 1920,
	height: 1080,
	fps: 30,
	durationInFrames: 120,
	defaultProps: {
		name: {
			text: 'Ada Lovelace',
			color: '#ffffff',
			fontSize: 84,
			fontFamily: 'Inter',
			fontWeight: 700,
			align: 'left',
		},
		role: 'Mathematician',
		roleColor: '#ffcc33',
		roleSize: 44,
		quote: 'Two\nrows',
		accent: '#3366ff',
	},
	propsSchema: {
		type: 'object',
		properties: {
			name: {
				type: 'object',
				properties: {
					text: { type: 'string', minLength: 1, maxLength: 60 },
					color: HEX,
					fontSize: { type: 'integer', minimum: 24, maximum: 160 },
					fontFamily: { type: 'string', minLength: 1 },
					fontWeight: { type: 'integer', minimum: 100, maximum: 900 },
					align: { type: 'string', enum: ['left', 'center', 'right'] },
				},
			},
			role: { type: 'string', maxLength: 80 },
			roleColor: HEX,
			roleSize: { type: 'integer', minimum: 16, maximum: 96 },
			quote: { type: 'string', maxLength: 200 },
			accent: HEX,
		},
	},
	schemaSource: 'bundle',
	ui: {
		'name.color': { control: 'color' },
		roleColor: { control: 'color' },
		quote: { control: 'textarea' },
		accent: { control: 'color' },
	},
	texts: {
		'name.text': { label: 'Name', maxChars: 24 },
		role: { label: 'Role', maxChars: 40 },
		quote: { label: 'Quote', multiline: true, maxLines: 2 },
	},
};

function setup(): { session: EditorSession; clipId: string } {
	const session = makeSession();
	const r = session.apply({
		label: 'setup',
		origin: 'user',
		commands: [
			{
				type: 'media.register',
				asset: {
					kind: 'mg-bundle',
					fingerprint: 'q1:abc',
					originalName: 'fixture',
					sizeBytes: 1,
					container: 'remotion-bundle',
					probe: {
						durationFlicks: null,
						startTimecode: null,
						streams: [],
						rotationDegrees: 0,
						hasAlpha: false,
						variableFrameRate: false,
					},
					locators: [{ type: 'engine-store', engineId: 'local', key: 'mk_fixture' }],
					mgBundle: {
						remotionVersion: '4.0.499',
						bundleHash: 'a'.repeat(64),
						builtAt: '2026-10-01T00:00:00.000Z',
						source: { type: 'project-dir', path: '/tmp/x', name: 'fixture' },
						compositions: [LOWER_THIRD],
					},
				},
				ref: '$b',
			},
			{
				type: 'clip.addComposition',
				composition: { mediaId: '$b', id: 'LowerThird' },
				at: 0,
				track: 'V1',
				ref: '$c',
			},
		] as never,
	});
	if (!r.ok) throw new Error(JSON.stringify(r.errors));
	return { session, clipId: r.refs.$c! };
}

function renderSection(session: EditorSession, clipId: string) {
	const seq = Object.values(session.getCommitted().sequences)[0]!;
	return renderWithSession(
		session,
		<CompositionSection session={session} clips={[seq.clips[clipId]!]} frame={0} sequenceId={seq.id} />,
	);
}

const props = (s: EditorSession, id: string, transient = false) => {
	const st = s.getState();
	const doc = transient ? (st.transient ?? st.document) : st.document;
	return (Object.values(doc.sequences)[0]!.clips[id] as { props: Record<string, unknown> }).props;
};

const frames = () => act(async () => void (await new Promise((r) => setTimeout(r, 40))));

beforeEach(() => {
	measure.mockResolvedValue({ measurements: [], fonts: [] });
});
afterEach(() => {
	cleanup();
	endCanvasTextEdit();
});

describe('Properties ▸ Composition ▸ Text (S08:MGU-006)', () => {
	it('previews while typing (no History entry), applies one "Edit Text" step; Esc reverts', async () => {
		const { session, clipId } = setup();
		renderSection(session, clipId);
		const before = labels(session).length;
		const field = screen.getByTestId('text-name.text') as HTMLInputElement;
		fireEvent.focus(field);
		fireEvent.change(field, { target: { value: 'Grace' } });
		await frames();
		fireEvent.change(field, { target: { value: 'Grace Hopper' } });
		await frames();
		expect((props(session, clipId, true).name as { text: string }).text).toBe('Grace Hopper');
		expect(props(session, clipId)).toEqual({});
		expect(labels(session)).toHaveLength(before);
		fireEvent.keyDown(field, { key: 'Enter' });
		fireEvent.blur(field);
		await frames();
		expect(labels(session)).toHaveLength(before + 1);
		expect(props(session, clipId)).toMatchObject({ name: { text: 'Grace Hopper', fontSize: 84 } });

		// Esc: back to the applied value, nothing new in History.
		fireEvent.focus(field);
		fireEvent.change(field, { target: { value: 'Something else' } });
		await frames();
		fireEvent.keyDown(field, { key: 'Escape' });
		fireEvent.blur(field);
		await frames();
		expect(field.value).toBe('Grace Hopper');
		expect(labels(session)).toHaveLength(before + 1);
		expect(session.getState().transient).toBeNull();
	});

	it('refuses values the schema rejects and warns about soft limits while typing', async () => {
		const { session, clipId } = setup();
		renderSection(session, clipId);
		const field = screen.getByTestId('text-name.text') as HTMLInputElement;
		fireEvent.focus(field);
		fireEvent.change(field, { target: { value: 'An unusually long name here' } });
		await frames();
		expect(
			screen.getByTestId('text-name.text-issues').querySelector('[data-code="MG_TEXT_LONG"]'),
		).not.toBeNull();
		fireEvent.change(field, { target: { value: 'x'.repeat(61) } });
		await frames();
		expect(screen.getByTestId('text-name.text-error').textContent).toBeTruthy();
		fireEvent.blur(field);
		await frames();
		expect(screen.getByTestId('composition-message').getAttribute('role')).toBe('alert');
		expect(props(session, clipId)).toEqual({});
		expect(field.value).toBe('Ada Lovelace');
	});
});
