// The JasperEditor MCP server (tools, resources, prompts). Transport-agnostic: `cli.ts` serves it over
// stdio (jasper-mcp), the engine serves the same definitions over Streamable HTTP at /mcp.
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { loadDoc, makeContext, type ToolContext } from './context.ts';
import { pickSequence, timelineTable } from './format.ts';
import type { EngineConnection } from './link.ts';
import { COLOR_GUIDE, registerColorTools } from './tools/color.ts';
import { COMPOSITION_GUIDE, registerCompositionTools } from './tools/compositions.ts';
import { registerEditingTools } from './tools/editing.ts';
import { PROCESSING_GUIDE, registerProcessingTools } from './tools/processing.ts';
import { registerProjectTools } from './tools/projects.ts';
import { registerRenderTools } from './tools/render.ts';
import { registerTrackingTools, TRACKING_GUIDE } from './tools/tracking.ts';
import { registerTransitionTools, TRANSITION_GUIDE } from './tools/transitions.ts';
import { MCP_SERVER_VERSION } from './version.ts';

export const MCP_SERVER_NAME = 'jasper-editor';

/** How to drive JasperEditor; sent as the server's `instructions` and by the `edit-video` prompt. */
export const EDITING_GUIDE = `JasperEditor is a Premiere-style video editor. These tools edit its projects through the local engine.

Workflow:
1. list_projects (or create_project) → projectId. open_project_in_editor if the user wants to watch; edits then appear live in their editor window, each as one undoable "Agent: <label>" History entry.
2. import_media with absolute file paths → mediaIds. get_media_info for durations and streams.
3. Build the cut: add_clip / move_clip / trim_clip / split_at / delete_clips / add_text / add_marker / add_motion_graphic / add_transition, or apply_commands for anything else (describe_commands lists every command with schemas and examples). Several related changes belong in one apply_commands transaction (atomic, one undo step).
4. Check it: get_timeline (text table) and render_frame (PNG of the Program output at a time).
5. start_export → wait_for_job → the output file.

Rules:
- Times are sequence frames; every time argument also accepts {"seconds": x} or timecode "HH:MM:SS:FF". Results give both frames and timecode.
- Tracks are "V1", "V2"… (video, V1 lowest) and "A1", "A2"… (audio). A video file placed with add_clip creates a linked video+audio pair.
- Deleting tracks/items or anything with force: true needs the user's approval in an open editor window; if they deny it (E_APPROVAL_DENIED), do not retry without asking.
- Undo/redo only touch this agent's own History entries.
- Errors come back as tool errors with a code and a hint on what to do next.`;

const FULL_GUIDE = [
	EDITING_GUIDE,
	COLOR_GUIDE,
	PROCESSING_GUIDE,
	COMPOSITION_GUIDE,
	TRACKING_GUIDE,
	TRANSITION_GUIDE,
].join('\n\n');

export type JasperMcpOptions = {
	link: EngineConnection;
	/** Name recorded in History origins; default = the MCP client's name (e.g. "claude-code"). */
	agentName?: string;
};

export function createJasperMcpServer(opts: JasperMcpOptions): { server: McpServer; ctx: ToolContext } {
	const server = new McpServer(
		{ name: MCP_SERVER_NAME, title: 'JasperEditor', version: MCP_SERVER_VERSION },
		{
			instructions: FULL_GUIDE,
			capabilities: { tools: {}, resources: {}, prompts: {}, logging: {} },
		},
	);
	const ctx = makeContext(server, opts.link, opts.agentName);
	registerProjectTools(ctx);
	registerEditingTools(ctx);
	registerRenderTools(ctx);
	registerColorTools(ctx);
	registerProcessingTools(ctx);
	registerCompositionTools(ctx);
	registerTrackingTools(ctx);
	registerTransitionTools(ctx);
	registerResources(ctx);
	registerPrompts(ctx);
	return { server, ctx };
}

function registerResources(ctx: ToolContext): void {
	const list = async () => {
		const { projects } = await ctx.engine((c) => c.listProjects());
		return projects;
	};
	ctx.server.registerResource(
		'project-document',
		new ResourceTemplate('jasper://projects/{projectId}/document', {
			list: async () => ({
				resources: (await list()).map((p) => ({
					uri: `jasper://projects/${p.projectId}/document`,
					name: `${p.name} (document)`,
					mimeType: 'application/json',
				})),
			}),
		}),
		{
			title: 'Project document',
			description:
				'The full JasperEditor project document (JSON, schema @jasper/project): media, items, sequences, tracks, clips with every property. Large; prefer get_project / get_timeline for overviews.',
			mimeType: 'application/json',
		},
		async (uri, { projectId }) => {
			const { doc } = await loadDoc(ctx, String(projectId));
			return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(doc) }] };
		},
	);
	ctx.server.registerResource(
		'project-timeline',
		new ResourceTemplate('jasper://projects/{projectId}/timeline', {
			list: async () => ({
				resources: (await list()).map((p) => ({
					uri: `jasper://projects/${p.projectId}/timeline`,
					name: `${p.name} (timeline)`,
					mimeType: 'text/plain',
				})),
			}),
		}),
		{
			title: 'Project timeline',
			description: 'The first sequence of a project as the get_timeline text table.',
			mimeType: 'text/plain',
		},
		async (uri, { projectId }) => {
			const { doc, revision, live } = await loadDoc(ctx, String(projectId));
			const seq = pickSequence(doc);
			return {
				contents: [
					{ uri: uri.href, mimeType: 'text/plain', text: timelineTable(doc, seq, { revision, live }) },
				],
			};
		},
	);
	ctx.server.registerResource(
		'editing-guide',
		'jasper://guide',
		{
			title: 'JasperEditor editing guide',
			description: 'How to drive JasperEditor with these tools.',
			mimeType: 'text/markdown',
		},
		async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: FULL_GUIDE }] }),
	);
}

function registerPrompts(ctx: ToolContext): void {
	ctx.server.registerPrompt(
		'edit-video',
		{
			title: 'Edit a video with JasperEditor',
			description: 'Guidance and a plan template for editing a video project with the JasperEditor tools.',
			argsSchema: {
				goal: z.string().describe('What the edit should achieve, e.g. "a 30 s teaser from interview.mp4"'),
				projectId: z.string().optional().describe('Existing project to edit (default: create one)'),
			},
		},
		({ goal, projectId }) => ({
			messages: [
				{
					role: 'user',
					content: {
						type: 'text',
						text: `${FULL_GUIDE}

Task: ${goal}
${projectId ? `Work in project ${projectId} (start with get_project).` : 'Create a project for it (create_project), or ask which existing project to use (list_projects).'}
Plan the cut first (shots, order, timings), apply it in a few well-labelled transactions, check key frames with render_frame, then tell me what you did and offer to export.`,
					},
				},
			],
		}),
	);
}
