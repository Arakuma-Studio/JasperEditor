import {
	EnvelopeSchema,
	LeaseRequestSchema,
	ProjectCreateRequestSchema,
	ProjectViewSchema,
	RecoveryPutRequestSchema,
	VersionRestoreRequestSchema,
} from '@jasper/api';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { requireUserApproval } from '../agent/user-approval.ts';
import { guarded, HttpError, parseOr400 } from '../tools/reply.ts';
import { coreServices } from '../tools/services.ts';

type P = { Params: { projectId: string } };
type PL = { Params: { projectId: string; leaseId: string } };
type PV = { Params: { projectId: string; versionId: string } };
type PR = { Params: { projectId: string; sessionId: string }; Querystring: { leaseId?: string } };

function parseIfMatch(h: string | string[] | undefined): number | '*' {
	const v = (Array.isArray(h) ? h[0] : h)?.trim().replace(/^W\//, '').replace(/^"|"$/g, '');
	if (v === undefined || v === '')
		throw new HttpError(428, 'BAD_REQUEST', 'If-Match: <baseRevision> is required');
	if (v === '*') return '*';
	const n = Number(v);
	if (!Number.isInteger(n) || n < 0)
		throw new HttpError(400, 'BAD_REQUEST', 'If-Match must be a revision number');
	return n;
}

export default async function projectsRoutes(app: FastifyInstance): Promise<void> {
	const { projects, leases, recovery } = coreServices(app);

	// Security review AGT-3: what an agent (a client without the editor key) may do to a stored project without the
	// user's approval is fill in projects it created itself: `create_project`, `save_project_copy` and a version
	// restored as a copy write a new project and then save into it. projectId → the revision that agent's own last
	// write produced; once anyone else has saved the project (the revision moved on) it is the user's work, and
	// overwriting it is asked about. In memory: after an engine restart the agent asks.
	const agentOwned = new Map<string, number>();
	const ownByAgent = (req: FastifyRequest, projectId: string, revision: number) => {
		if (req.jasperEditor) return;
		if (agentOwned.size >= 10_000) agentOwned.delete(agentOwned.keys().next().value as string);
		agentOwned.set(projectId, revision);
	};
	const projectName = async (projectId: string): Promise<string> => {
		try {
			const name = (await projects.get(projectId)).envelope.document.name;
			return typeof name === 'string' && name ? `"${name.slice(0, 80)}"` : projectId;
		} catch {
			return projectId;
		}
	};

	app.get(
		'/api/projects',
		guarded(async () => ({ projects: await projects.list() })),
	);

	app.post(
		'/api/projects',
		guarded(async (req, reply) => {
			const body = parseOr400(ProjectCreateRequestSchema, req.body);
			const projectId = await projects.create(body);
			ownByAgent(req, projectId, (await projects.revision(projectId)) ?? 0);
			return reply.code(201).send({ projectId });
		}),
	);

	app.get<P>(
		'/api/projects/:projectId',
		guarded<P>(async (req) => projects.get(req.params.projectId)),
	);

	app.put<P>(
		'/api/projects/:projectId',
		guarded<P>(async (req) => {
			const ifMatch = parseIfMatch(req.headers['if-match']);
			const envelope = parseOr400(EnvelopeSchema, req.body);
			const { projectId } = req.params;
			if (!req.jasperEditor) {
				const current = await projects.revision(projectId);
				// Saving replaces the whole document. An agent edits through transactions (undoable, gated); a save from
				// one is only its own project being filled in. Anything else overwrites the user's work.
				if (current !== null && agentOwned.get(projectId) !== current)
					await requireUserApproval(app, req, {
						label: 'Overwrite a project',
						summary: `replace the saved project ${await projectName(projectId)} with another document`,
						reasons: ['replaces the whole project file outside the undo history'],
						projectId,
					});
			}
			const saved = await projects.save(projectId, envelope, ifMatch);
			if (agentOwned.has(projectId)) ownByAgent(req, projectId, saved.revision);
			return saved;
		}),
	);

	app.put<P>(
		'/api/projects/:projectId/view',
		guarded<P>(async (req) => {
			const view = parseOr400(ProjectViewSchema, req.body);
			await projects.saveView(req.params.projectId, view);
			return { ok: true as const };
		}),
	);

	app.get<P>(
		'/api/projects/:projectId/versions',
		guarded<P>(async (req) => ({ versions: await projects.versions(req.params.projectId) })),
	);

	// Saved versions (process workstream, D-39): read one, restore it in place or as a new project.
	app.get<PV>(
		'/api/projects/:projectId/versions/:versionId',
		guarded<PV>(async (req) => projects.version(req.params.projectId, req.params.versionId)),
	);

	app.post<PV>(
		'/api/projects/:projectId/versions/:versionId/restore',
		guarded<PV>(async (req) => {
			const body = parseOr400(VersionRestoreRequestSchema, req.body);
			const { projectId, versionId } = req.params;
			// Security review AGT-3: `replace` makes an older state the project's current one. The replaced state is
			// kept as a version, so nothing is lost, but the user's project changes under them: an agent asks first.
			// `copy` makes a new project and touches nothing.
			if (body.mode === 'replace')
				await requireUserApproval(app, req, {
					label: 'Restore a saved version',
					summary: `replace the current state of ${await projectName(projectId)} with its saved version ${versionId}`,
					reasons: ['the current state is kept as a version, but the project file is replaced'],
					projectId,
				});
			const restored = await projects.restoreVersion(projectId, versionId, body);
			if (body.mode === 'copy') ownByAgent(req, restored.projectId, restored.revision);
			return restored;
		}),
	);

	// Crash-recovery journals (S01:PER-021, AC-18, D-39).
	app.get<P>(
		'/api/projects/:projectId/recovery',
		guarded<P>(async (req) => {
			if ((await projects.revision(req.params.projectId)) === null)
				throw new HttpError(404, 'PROJECT_NOT_FOUND', 'Unknown project');
			return recovery.list(req.params.projectId);
		}),
	);

	app.get<PR>(
		'/api/projects/:projectId/recovery/:sessionId',
		guarded<PR>(async (req) => {
			const r = await recovery.read(req.params.projectId, req.params.sessionId);
			return { candidate: r.info, envelope: r.envelope };
		}),
	);

	app.put<PR>(
		'/api/projects/:projectId/recovery/:sessionId',
		guarded<PR>(async (req) => {
			const body = parseOr400(RecoveryPutRequestSchema, req.body);
			if ((await projects.revision(req.params.projectId)) === null)
				throw new HttpError(404, 'PROJECT_NOT_FOUND', 'Unknown project');
			const r = await recovery.write(req.params.projectId, req.params.sessionId, body);
			return { ok: true as const, savedAt: r.savedAt };
		}),
	);

	app.delete<PR>(
		'/api/projects/:projectId/recovery/:sessionId',
		guarded<PR>(async (req) => {
			// Security review AGT-3: a recovery journal holds unsaved work of a session that ended without saving;
			// discarding it is final. The editor discards its own journal after a save or when the user says so.
			await requireUserApproval(app, req, {
				label: 'Discard unsaved changes',
				summary: `discard the recoverable unsaved changes of a session of ${await projectName(req.params.projectId)}`,
				reasons: ['the unsaved edits in that recovery journal are lost for good'],
				projectId: req.params.projectId,
			});
			await recovery.remove(req.params.projectId, req.params.sessionId, req.query.leaseId);
			return { ok: true as const };
		}),
	);

	app.delete<P>(
		'/api/projects/:projectId',
		guarded<P>(async (req) => {
			const { projectId } = req.params;
			// Security review AGT-3: the project, its versions and its recovery journals are removed for good. An agent
			// may remove a project it created and nobody else has saved; any other needs the user's approval.
			const current = await projects.revision(projectId);
			if (current !== null && agentOwned.get(projectId) !== current)
				await requireUserApproval(app, req, {
					label: 'Delete a project',
					summary: `delete the project ${await projectName(projectId)} with its saved versions`,
					reasons: [
						'deletes the project file, its versions and its unsaved-changes journals; this cannot be undone',
					],
					projectId,
				});
			await projects.delete(projectId);
			agentOwned.delete(projectId);
			return { ok: true as const };
		}),
	);

	app.post<P>(
		'/api/projects/:projectId/lease',
		guarded<P>(async (req) => {
			const { sessionId, takeOver } = parseOr400(LeaseRequestSchema, req.body);
			if ((await projects.revision(req.params.projectId)) === null) {
				throw new HttpError(404, 'PROJECT_NOT_FOUND', 'Unknown project');
			}
			// Security review AGT-3: taking over turns the window that is editing the project read-only (its unsaved
			// edits stay in its recovery journal). The user decides that, in the editor's "Take over editing" dialog.
			const held = leases.get(req.params.projectId);
			if (takeOver && held && held.sessionId !== sessionId)
				await requireUserApproval(app, req, {
					label: 'Take over a project',
					summary: `take the project ${await projectName(req.params.projectId)} away from the editor window that is editing it`,
					reasons: ['the window that has the project open becomes read-only'],
					projectId: req.params.projectId,
				});
			return leases.acquire(req.params.projectId, sessionId, { takeOver });
		}),
	);

	app.post<PL>(
		'/api/projects/:projectId/lease/:leaseId/heartbeat',
		guarded<PL>(async (req) => leases.heartbeat(req.params.projectId, req.params.leaseId)),
	);

	app.delete<PL>(
		'/api/projects/:projectId/lease/:leaseId',
		guarded<PL>(async (req) => {
			leases.release(req.params.projectId, req.params.leaseId);
			return { ok: true as const };
		}),
	);
}
