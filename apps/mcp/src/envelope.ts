import type { EnvelopeJson } from '@jasper/api';
import { makeEnvelope, type ProjectDocument } from '@jasper/project';

export function toolEnvelope(doc: ProjectDocument, revision = 0): EnvelopeJson {
	return makeEnvelope(doc, { revision, savedAt: new Date().toISOString(), platform: 'mcp' });
}
