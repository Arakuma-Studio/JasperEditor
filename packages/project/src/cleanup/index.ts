// Transcript cleanup (spec 14): voice analysis contract, detector, planner, settings and presets.

export {
	CleanupAnalysisSchema,
	CleanupFindingSchema,
	CleanupPlanSchema,
	CleanupStatsSchema,
	RetakeGroupSchema,
} from './analysis-schema.ts';
export {
	type CleanupSegmentIn,
	type CleanupVoice,
	type CleanupWordIn,
	type DetectInput,
	type DetectResult,
	detectCleanup,
	effectiveLists,
	findingFingerprint,
	type ScriptLineReport,
} from './detector.ts';
export { edgeThreshold, levelInPoint, levelOutPoint, snapEdge } from './edges.ts';
export { languageFillerHits } from './fillers.ts';
export {
	builtinLists,
	CLEANUP_LANGUAGES,
	type CleanupLanguage,
	type CleanupLanguageLists,
	cleanupLanguageOf,
	cleanupNorm,
} from './lists.ts';
export { isHarshCut, type MediaPlan, type MediaPlanInput, planMediaCuts } from './plan.ts';
export {
	cleanupApplyCommands,
	cleanupFindingFrames,
	cleanupFindingMedia,
	cleanupRejectionChanges,
} from './review.ts';
export { lcs } from './rules.ts';
export {
	BUILTIN_CLEANUP_PRESETS,
	builtinCleanupSettings,
	CLEANUP_MAX_LIST_ENTRIES,
	CLEANUP_MAX_LIST_LANGUAGES,
	CLEANUP_MAX_REJECTED,
	CLEANUP_SCRIPT_MAX_BYTES,
	type CleanupFinding,
	CleanupFingerprintSchema,
	CleanupListLanguageSchema,
	type CleanupLists,
	CleanupListsSchema,
	type CleanupOverrides,
	CleanupOverridesSchema,
	type CleanupPreset,
	CleanupPresetSchema,
	type CleanupScript,
	CleanupScriptSchema,
	type CleanupSettings,
	CleanupSettingsSchema,
	EDGE_MODES,
	FAST_SETTINGS,
	FINDING_KINDS,
	type FindingKind,
	type FindingReason,
	type FindingSuggestion,
	mergeCleanupSettings,
	NATURAL_SETTINGS,
	type RetakeGroup,
	type RetakeTake,
	type RuleAction,
	readSequenceCleanup,
	repairSequenceCleanup,
	resolvePresetSettings,
	type SequenceCleanup,
	SequenceCleanupSchema,
	sequenceCleanupIssue,
} from './schema.ts';
export { scriptLines, scriptTokens } from './script.ts';
export {
	type AnalyzeSequenceInput,
	analyzeSequenceCleanup,
	type CleanupAnalysis,
	type CleanupDecisions,
	type CleanupMediaReport,
	type CleanupPlan,
	type CleanupPlanRange,
	type CleanupRefusal,
	type CleanupScope,
	type CleanupStats,
	isAccepted,
	sequenceCleanupSettings,
	speechClipsOf,
	transcriptSegments,
	type VoiceLookup,
} from './sequence.ts';
