// Agent context (spec 18 AF-CTX-003/004, docs/wp-notes/agent-footage-context.md): the short server `instructions`
// (workflow, rules, toolset index, guide pointers; ≤ 8 KB), the per-topic guides (`jasper://guide/<topic>` and
// core `get_guide {topic}`; `jasper://guide` keeps every guide in one text), the request → tool routing table
// (`jasper://guide/routing`) and the `edit-video` prompt text.
import { z } from 'zod';
import { defineTool, READ_ONLY, type ToolContext } from './context.ts';
import { jsonResult, ToolError } from './errors.ts';
import { TOOLSETS, toolsetOf } from './toolsets.ts';

/** A guide topic: one `*_GUIDE` string, or a titled bundle of sections (the older composite guide resources). */
export type GuideSource =
	| string
	| {
			title: string;
			description: string;
			sections: readonly (string | { heading: string; text: string })[];
	  };

export type GuideTopic = { topic: string; title: string; description: string; text: string };

/** Upper bound of the server `instructions` in UTF-8 bytes (AF-CTX-003). */
export const INSTRUCTIONS_MAX_BYTES = 8192;

/** A guide's title: its first line up to the first ": " or ". " outside parentheses (the guides open that way). */
export function guideTitle(text: string): string {
	const first = (text.split('\n', 1)[0] ?? '').trim();
	let depth = 0;
	let cut = first.length;
	for (let i = 0; i < first.length; i++) {
		const c = first[i];
		if (c === '(') depth++;
		else if (c === ')') depth = Math.max(0, depth - 1);
		else if (depth === 0 && (c === ':' || c === '.') && (i + 1 === first.length || first[i + 1] === ' ')) {
			cut = i;
			break;
		}
	}
	const title = first.slice(0, cut).trim();
	return title.length > 100 ? `${title.slice(0, 99)}…` : title;
}

/** The topics of `sources`, in order. */
export function guideTopics(sources: Readonly<Record<string, GuideSource>>): GuideTopic[] {
	return Object.entries(sources).map(([topic, src]) => {
		if (typeof src === 'string') {
			const title = guideTitle(src);
			return { topic, title, description: title, text: src };
		}
		const body = src.sections.map((s) => (typeof s === 'string' ? s : `## ${s.heading}\n\n${s.text}`));
		return {
			topic,
			title: src.title,
			description: src.description,
			text: [`# ${src.title}`, ...body].join('\n\n'),
		};
	});
}

/** Every guide text of `sources` once, in order: the full guide (`jasper://guide`). */
export function fullGuide(sources: Readonly<Record<string, GuideSource>>): string {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const src of Object.values(sources))
		for (const s of typeof src === 'string' ? [src] : src.sections) {
			const text = typeof s === 'string' ? s : s.text;
			if (!text.trim() || seen.has(text)) continue;
			seen.add(text);
			out.push(text);
		}
	return out.join('\n\n');
}

const WORKFLOW = `JasperEditor is a Premiere-style video editor; these tools edit its projects through the local engine. With the project open in an editor window (\`open_project_in_editor\`) edits appear live, each one undoable "Agent: <label>" History entry; otherwise they apply to the saved project.

## Workflow: brief → digest/takes → view → propose → wait → verify
1. Brief. \`get_brief\` (goal, platform, target length, aspect of a sequence) and \`list_agent_notes\`. No brief: propose one bundle of defaults (below), then \`set_brief\`. \`add_agent_note\` records decisions for the next agent.
2. Read the footage as text. \`get_footage_digest\` (every take as timed phrases; "~" marks unsure words) and \`find_takes\` (the same line said several times, with a suggested take). No transcript yet: \`transcribe\` + \`wait_for_job\`; new files: \`import_media\` with transcribe.
3. Look only at decision points. \`view_media_range\` (filmstrip, waveform, words, silences of a media or sequence range in one image) and \`render_frame\` (the Program output).
4. Propose the cut. \`propose_edits\`: a strategy in a few sentences and items {group, reason, beat, quote, commands}. The user reviews ghosts in the Review panel and applies with one undo. Do not land a multi-step cut through \`apply_commands\`.
5. Wait. \`wait_for_proposal\` returns the user's decisions; rework what was rejected, never re-propose what was applied.
6. Verify. \`start_export\` (wait: true), then \`verify_export\` (decode, streams, duration, A/V skew, black/flash frames and clicks at cuts, loudness; a delivery target adds platform rows). Fix "format" rows yourself; ask about "judgement" rows. Inspect the output, not the plan; at most three self-review passes.

Small direct fixes: \`add_clip\`, \`trim_clip\`, \`split_at\`, \`delete_clips\`, or \`apply_commands\` (\`describe_commands\` lists every command with schema and example; related changes in one transaction = one undo step; dryRun to test). \`get_timeline\` reads a sequence, \`get_project\` the project, \`undo\` reverts your own last entry.

## Asking vs assuming
Offer one bundle of defaults ("30 s, 9:16 for Reels, best take of each line, music ducked under speech: OK?") instead of a list of questions. Never ask what a tool can measure. You cannot hear: report measured numbers (loudness, verify rows), not impressions.

## Rules
- Tool time arguments take frames, {"seconds": x}, "3s", "250ms", a clock "00:03" / "1:02:03" or timecode "HH:MM:SS:FF"; commands inside apply_commands take frames, {"frames": n}, {"seconds": x} or timecode. Results give frames and timecode.
- Tracks are "V1", "V2"… (V1 lowest) and "A1", "A2"…; a video file placed with add_clip makes a linked video+audio pair.
- Arguments are strict: an unknown key at any depth is an error naming it (E_UNKNOWN_ARGUMENT). Errors are tool results {error: {code, message, hint, details}}: follow the hint.
- Deleting tracks or items, force: true and other destructive operations need the user's approval in an open editor window; only the user can approve. After E_APPROVAL_DENIED do not retry without asking.
- Undo/redo only touch your own History entries.
- Long calls send progress when you pass a progressToken; cancelling the request cancels the engine job and deletes its partial output.
- Every tool carries readOnly/destructive/idempotent/openWorld hints.`;

/** The server `instructions`: workflow, rules, the toolset index and pointers to the guides (≤ 8 KB). */
export function buildInstructions(topics: readonly GuideTopic[]): string {
	const index = TOOLSETS.map((ts) => `- ${ts.name}: ${ts.description}`).join('\n');
	return `${WORKFLOW}

## Toolsets
This session advertises the core toolset (plus any chosen with JASPER_MCP_TOOLSETS or --toolsets). For anything else: \`list_toolsets\`, then \`enable_toolsets\` {"names": [...]} (tools/list changes), or \`describe_tool\` + \`call_tool\` {"name", "arguments"} to run any tool directly. Calling a tool whose toolset is off returns E_TOOLSET_NOT_ENABLED naming the toolset.
${index}

## Guides
\`get_guide\` {"topic"} or the resource jasper://guide/<topic>, topics: ${topics.map((t) => t.topic).join(', ')}, routing. jasper://guide/routing maps requests (English and Spanish) to tools; jasper://guide is every guide in one text. The \`jasper\` CLI runs the same tools from a shell (jasper call <tool> k=v).`;
}

/** The `edit-video` prompt: the workflow for one goal, not the whole guide. */
export function editVideoPrompt(goal: string, projectId?: string): string {
	return `Edit a video with JasperEditor.

Task: ${goal}
${projectId ? `Project: ${projectId} (start with \`get_project\` and \`get_brief\`).` : 'Find the project with `list_projects` (ask which one when several fit) or create one with `create_project`, then `import_media` the footage with transcription.'}

Work in this order:
1. Brief: read it with \`get_brief\` and \`list_agent_notes\`. If the goal, platform, length or aspect is missing, propose one bundle of defaults in a single message (never a list of questions) and store the agreed brief with \`set_brief\`.
2. Read the footage as text: \`get_footage_digest\`, and \`find_takes\` when lines were said more than once. Transcribe what has no transcript (\`transcribe\`, \`wait_for_job\`).
3. Look at decision points only: \`view_media_range\` for a source range, \`render_frame\` for the edit.
4. Propose the whole cut as one reviewable proposal with \`propose_edits\`: a short strategy, and items whose reason, beat and quote explain each edit.
5. Tell me what you proposed and wait for my review with \`wait_for_proposal\`; rework what I rejected.
6. When the cut is applied, export with \`start_export\` and check the file with \`verify_export\` (with the brief's platform as target). Fix format failures; ask me about judgement rows.

Report at the end in three short lists: Done (what changed), Checked (measured evidence: verify rows, loudness, frames you looked at) and Not checked (what you could not measure or did not look at). Rules, toolsets and guides: the server instructions, \`get_guide\` and jasper://guide/routing.`;
}

type Route = { en: string; es: string; tools: readonly string[] };

/** Request → tool routing (AF-CTX-004). Every tool must exist; the toolset column comes from TOOLSETS. */
export const ROUTES: readonly Route[] = [
	{ en: 'What is in my footage?', es: '¿Qué hay en mi material?', tools: ['get_footage_digest'] },
	{
		en: 'Find the best take of each line',
		es: 'Encuentra la mejor toma de cada frase',
		tools: ['find_takes'],
	},
	{ en: 'Show me this part of the clip', es: 'Muéstrame esta parte del clip', tools: ['view_media_range'] },
	{ en: 'Show me a frame of the edit', es: 'Muéstrame un fotograma del montaje', tools: ['render_frame'] },
	{ en: 'Make a rough cut', es: 'Haz un primer montaje', tools: ['propose_edits'] },
	{
		en: 'Did the user accept my cut?',
		es: '¿Ha aceptado el usuario mi montaje?',
		tools: ['wait_for_proposal'],
	},
	{ en: 'What is this video for?', es: '¿Para qué es este vídeo?', tools: ['get_brief'] },
	{
		en: 'Set the goal, platform or length',
		es: 'Fija el objetivo, la plataforma o la duración',
		tools: ['set_brief'],
	},
	{
		en: 'Leave a note for the next agent',
		es: 'Deja una nota para el próximo agente',
		tools: ['add_agent_note'],
	},
	{
		en: 'What did earlier agents decide?',
		es: '¿Qué decidieron otros agentes?',
		tools: ['list_agent_notes'],
	},
	{ en: 'Export the video', es: 'Exporta el vídeo', tools: ['start_export'] },
	{ en: 'Check the exported file', es: 'Comprueba el archivo exportado', tools: ['verify_export'] },
	{
		en: 'Is it ready for TikTok / Reels / YouTube?',
		es: '¿Está listo para TikTok, Reels o YouTube?',
		tools: ['verify_export'],
	},
	{ en: 'Export a GIF or only the audio', es: 'Exporta un GIF o solo el audio', tools: ['start_export'] },
	{
		en: 'Which export presets are there?',
		es: '¿Qué ajustes de exportación hay?',
		tools: ['list_export_presets'],
	},
	{ en: 'Cancel the export', es: 'Cancela la exportación', tools: ['cancel_job'] },
	{ en: 'Import these files', es: 'Importa estos archivos', tools: ['import_media'] },
	{ en: 'Transcribe the interview', es: 'Transcribe la entrevista', tools: ['transcribe', 'wait_for_job'] },
	{ en: 'Create a new project', es: 'Crea un proyecto nuevo', tools: ['create_project'] },
	{ en: 'Which projects are there?', es: '¿Qué proyectos hay?', tools: ['list_projects'] },
	{ en: 'Open it in the editor', es: 'Ábrelo en el editor', tools: ['open_project_in_editor'] },
	{ en: 'What is on the timeline?', es: '¿Qué hay en la línea de tiempo?', tools: ['get_timeline'] },
	{ en: 'Put this clip on the timeline', es: 'Pon este clip en la línea de tiempo', tools: ['add_clip'] },
	{ en: 'Cut the clip at 10 seconds', es: 'Corta el clip en el segundo 10', tools: ['split_at'] },
	{ en: 'Shorten this clip', es: 'Acorta este clip', tools: ['trim_clip'] },
	{ en: 'Delete these clips', es: 'Borra estos clips', tools: ['delete_clips'] },
	{ en: 'Undo that', es: 'Deshaz eso', tools: ['undo'] },
	{
		en: 'Make several changes in one step',
		es: 'Haz varios cambios en un solo paso',
		tools: ['apply_commands', 'describe_commands'],
	},
	{ en: 'Move this clip', es: 'Mueve este clip', tools: ['move_clip'] },
	{ en: 'Add a marker', es: 'Añade un marcador', tools: ['add_marker'] },
	{ en: 'Add a title', es: 'Añade un título', tools: ['add_text'] },
	{ en: 'Animate the title', es: 'Anima el título', tools: ['set_text_animation'] },
	{
		en: 'Make a stylish title',
		es: 'Haz un título con estilo',
		tools: ['find_title_looks', 'propose_title'],
	},
	{ en: 'Can the title be read?', es: '¿Se puede leer el título?', tools: ['title_check'] },
	{ en: 'Save this title look', es: 'Guarda este aspecto de título', tools: ['save_title_look'] },
	{
		en: 'Show a title look as JSON',
		es: 'Muestra un aspecto de título en JSON',
		tools: ['get_title_recipe'],
	},
	{ en: 'Put fire behind the title', es: 'Pon fuego detrás del título', tools: ['add_title_generator'] },
	{
		en: 'Add an effect to this clip',
		es: 'Añade un efecto a este clip',
		tools: ['list_effects', 'add_effect'],
	},
	{ en: 'Change an effect setting', es: 'Cambia un ajuste de un efecto', tools: ['set_effect_param'] },
	{
		en: 'Add a lower third or a social comment',
		es: 'Añade un rótulo o un comentario social',
		tools: ['add_motion_graphic'],
	},
	{ en: 'Add subtitles', es: 'Añade subtítulos', tools: ['captions_from_transcript'] },
	{
		en: 'Make all subtitles look the same',
		es: 'Da el mismo estilo a todos los subtítulos',
		tools: ['style_captions'],
	},
	{ en: 'Export the subtitles as SRT', es: 'Exporta los subtítulos en SRT', tools: ['export_captions'] },
	{
		en: 'Remove the ums, retakes and long pauses',
		es: 'Quita las muletillas, las repeticiones y las pausas largas',
		tools: ['analyze_voice', 'plan_cleanup'],
	},
	{
		en: 'Fix the transcript from my script',
		es: 'Corrige la transcripción con mi guion',
		tools: ['attach_script', 'fix_transcript'],
	},
	{ en: 'Find where they say …', es: 'Busca dónde dice …', tools: ['transcript_search'] },
	{
		en: 'Cut the video by editing the text',
		es: 'Monta el vídeo editando el texto',
		tools: ['transcript_select', 'transcript_lift'],
	},
	{ en: 'Read the transcript', es: 'Lee la transcripción', tools: ['get_transcript'] },
	{ en: 'Add a transition', es: 'Añade una transición', tools: ['add_transition'] },
	{
		en: 'Add a short fade at every cut',
		es: 'Pon un fundido corto en cada corte',
		tools: ['apply_default_transitions'],
	},
	{ en: 'Color grade this clip', es: 'Corrige el color de este clip', tools: ['grade_clip'] },
	{ en: 'Match the colors between shots', es: 'Iguala el color entre planos', tools: ['color_match'] },
	{ en: 'Apply a LUT', es: 'Aplica una LUT', tools: ['import_lut', 'grade_clip'] },
	{ en: 'How loud is it?', es: '¿Qué volumen tiene?', tools: ['measure_loudness'] },
	{
		en: 'Normalize the loudness for delivery',
		es: 'Normaliza la sonoridad para la entrega',
		tools: ['set_loudness_normalization'],
	},
	{
		en: 'Lower the music when someone speaks',
		es: 'Baja la música cuando alguien habla',
		tools: ['auto_duck'],
	},
	{ en: 'Add background music', es: 'Pon música de fondo', tools: ['lay_music_bed'] },
	{
		en: 'Fit the music to the video length',
		es: 'Ajusta la música a la duración del vídeo',
		tools: ['fit_music_to_picture'],
	},
	{ en: 'Add sound effects', es: 'Añade efectos de sonido', tools: ['plan_sound_design'] },
	{ en: 'Find a whoosh sound', es: 'Busca un sonido de whoosh', tools: ['search_sounds'] },
	{ en: 'Check the sound mix', es: 'Revisa la mezcla de sonido', tools: ['sound_check'] },
	{ en: 'Reduce background noise', es: 'Reduce el ruido de fondo', tools: ['add_audio_effect'] },
	{
		en: 'Extract, denoise or conform a media file',
		es: 'Extrae, limpia o convierte un archivo de medios',
		tools: ['derive_media'],
	},
	{ en: 'Make it slow motion', es: 'Ponlo a cámara lenta', tools: ['set_segment_speed'] },
	{ en: 'Freeze this frame', es: 'Congela este fotograma', tools: ['add_frame_hold'] },
	{ en: 'Play this part backwards', es: 'Reproduce esta parte al revés', tools: ['add_reverse_segment'] },
	{ en: 'Make a vertical version', es: 'Haz una versión vertical', tools: ['auto_reframe_sequence'] },
	{ en: 'Stabilize the shaky shot', es: 'Estabiliza el plano movido', tools: ['stabilize_clip'] },
	{ en: 'Blur the faces', es: 'Difumina las caras', tools: ['blur_faces'] },
	{ en: 'Track an object', es: 'Sigue un objeto', tools: ['add_tracker', 'track'] },
	{ en: 'Mask part of the picture', es: 'Enmascara parte de la imagen', tools: ['add_mask'] },
	{ en: 'Add zoom punch-ins', es: 'Añade zooms de énfasis', tools: ['add_punch_ins'] },
	{ en: 'Apply a style recipe', es: 'Aplica una receta de estilo', tools: ['apply_style'] },
	{ en: 'Detect the scene cuts', es: 'Detecta los cambios de plano', tools: ['detect_scene_edits'] },
	{
		en: 'Sync several cameras',
		es: 'Sincroniza varias cámaras',
		tools: ['synchronize_clips', 'create_multicam_sequence'],
	},
	{ en: 'Nest these clips', es: 'Anida estos clips', tools: ['nest_clips'] },
	{ en: 'Find the gaps in the timeline', es: 'Busca los huecos de la línea de tiempo', tools: ['find_gaps'] },
	{ en: 'Export a still image', es: 'Exporta una imagen fija', tools: ['export_frame'] },
	{
		en: 'Send the edit to Premiere or Resolve',
		es: 'Pasa el montaje a Premiere o Resolve',
		tools: ['export_timeline'],
	},
	{ en: 'Make proxies', es: 'Crea proxies', tools: ['create_proxies'] },
	{
		en: 'Relink missing media',
		es: 'Vuelve a vincular los medios que faltan',
		tools: ['list_offline_media', 'link_media'],
	},
	{
		en: 'Go back to an earlier version',
		es: 'Vuelve a una versión anterior',
		tools: ['list_project_versions', 'restore_project_version'],
	},
	{ en: 'Smooth the animation', es: 'Suaviza la animación', tools: ['apply_ease'] },
	{ en: 'Install a font', es: 'Instala una fuente', tools: ['install_font'] },
	{ en: 'Take a screenshot of the editor', es: 'Haz una captura del editor', tools: ['ui_screenshot'] },
	{ en: 'List the open proposals', es: 'Enumera las propuestas abiertas', tools: ['list_proposals'] },
	{ en: 'Which tools are there?', es: '¿Qué herramientas hay?', tools: ['list_toolsets'] },
	{
		en: 'Use a tool that is not listed',
		es: 'Usa una herramienta que no aparece',
		tools: ['describe_tool', 'call_tool'],
	},
	{ en: 'How do I do …?', es: '¿Cómo se hace …?', tools: ['get_guide'] },
];

/** The routing table as markdown (`jasper://guide/routing`, `get_guide {topic: "routing"}`). */
export function routingMarkdown(): string {
	const cell = (s: string) => s.replace(/\|/g, '\\|');
	const rows = ROUTES.map(
		(r) =>
			`| ${cell(r.en)} | ${cell(r.es)} | ${r.tools.map((t) => `\`${t}\``).join(', ')} | ${[
				...new Set(r.tools.map((t) => toolsetOf(t) ?? '?')),
			].join(', ')} |`,
	);
	return `# Request → tool routing

Which tool answers a request, with its toolset. Tools of a toolset this session does not advertise: \`enable_toolsets\` {"names": [toolset]} or \`call_tool\` {"name", "arguments"}. Guides per topic: \`get_guide\`.

| Request | Petición | Tool | Toolset |
|---|---|---|---|
${rows.join('\n')}
`;
}

/** The guide resources (every topic, the routing table, the full guide) and core `get_guide {topic}`. */
export function registerGuides(ctx: ToolContext, topics: readonly GuideTopic[], full: string): void {
	const routing: GuideTopic = {
		topic: 'routing',
		title: 'Request → tool routing',
		description: 'Which tool (and toolset) answers a request, in English and Spanish.',
		text: routingMarkdown(),
	};
	const all = [...topics, routing];
	for (const t of all)
		ctx.server.registerResource(
			`guide-${t.topic}`,
			`jasper://guide/${t.topic}`,
			{ title: t.title, description: t.description, mimeType: 'text/markdown' },
			async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: t.text }] }),
		);
	ctx.server.registerResource(
		'editing-guide',
		'jasper://guide',
		{
			title: 'JasperEditor editing guide',
			description: 'Every guide in one text (large; prefer get_guide {topic} or jasper://guide/<topic>).',
			mimeType: 'text/markdown',
		},
		async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: full }] }),
	);
	const byTopic = new Map(all.map((t) => [t.topic, t]));
	const names = all.map((t) => t.topic);
	defineTool(
		ctx,
		'get_guide',
		{
			title: 'Read a guide',
			description: `A domain guide by topic (the same text as the resource jasper://guide/<topic>); "routing" maps requests to tools. Without a topic: the list of topics. Topics: ${names.join(', ')}.`,
			input: {
				topic: z
					.string()
					.min(1)
					.max(64)
					.optional()
					.describe('Guide topic, e.g. "color" or "routing"; omit for the list'),
			},
			annotations: READ_ONLY,
		},
		async ({ topic }) => {
			if (topic === undefined)
				return jsonResult({
					topics: all.map((t) => ({ topic: t.topic, title: t.title, chars: t.text.length })),
					hint: 'get_guide {topic}; the toolsets name their guides (list_toolsets).',
				});
			const t = byTopic.get(topic);
			if (!t)
				throw new ToolError('E_NOT_FOUND', `No guide topic "${topic}"`, `Topics: ${names.join(', ')}.`, {
					topic,
				});
			return { content: [{ type: 'text', text: t.text }] };
		},
	);
}
