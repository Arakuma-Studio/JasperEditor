// Script-guided transcript correction, the pure model (spec 17 §2.1–2.5; docs/wp-notes/script-correction.md
// "Model (alignment, candidates, decisions)"). Public entry: `@jasper/project/script-fix`.
//
// Flow per media transcript: parseScript → alignTranscript → findFixCandidates → buildScoreWindows →
// (engine: SC-092 score of scoreRequestWindows) → candidateScores → decideFix → replaceWordsEdit.

export {
	ALIGN_DEFAULTS,
	type AlignInput,
	type AlignmentReport,
	type AlignmentResult,
	type AlignOptions,
	type AlignStep,
	alignOptions,
	alignTranscript,
	alignTranscripts,
	type TranscriptToken,
	transcriptTokens,
	unusedScriptLines,
} from './align.ts';
export {
	type CandidateResult,
	displayWords,
	type FindCandidatesInput,
	type FixCandidate,
	type FixCategory,
	type FixKind,
	type FixWord,
	findFixCandidates,
	type GlossaryEntryInput,
	SKIP_REASONS,
	type SkippedRegion,
	type SkipReason,
} from './candidates.ts';
export {
	type CandidateScore,
	candidateScores,
	DECISION_PRESETS,
	type DecisionThresholds,
	decideFix,
	decideFixes,
	type FixDecision,
	type FixedWord,
	type FixGroup,
	type FixRule,
	type ReplaceWordsEdit,
	replaceWordsEdit,
	retimedWords,
	STRICTNESS_PRESETS,
	type StrictnessPreset,
	splitByCharacters,
} from './decide.ts';
export { keyDistance, PSIM_INDEL_COSTS, PSIM_SUBSTITUTION_COSTS, phoneticKey, psim } from './phonetic.ts';
export {
	isBrandLike,
	isHeadingLine,
	type ParsedScript,
	parseScript,
	type ScriptSection,
	type ScriptSummary,
	type ScriptToken,
	type ScriptTokenKind,
} from './script.ts';
export {
	ENGLISH_LOANWORDS,
	englishNumber,
	exactMatch,
	functionWords,
	isEnglishWord,
	isNumericToken,
	numberEqual,
	type ScriptFixLanguage,
	scriptFixLanguage,
	spanishNumber,
	spokenForm,
} from './text.ts';
export {
	ASR_READING_ID,
	buildScoreWindows,
	SCORE_WINDOW_DEFAULTS,
	type ScoreReading,
	type ScoreReadingResult,
	type ScoreRegion,
	type ScoreRequestWindow,
	type ScoreWindow,
	type ScoreWindowOptions,
	type ScoreWindowResult,
	type ScoreWordResult,
	scoreRequestWindows,
	type UnplacedCandidate,
	windowBounds,
	windowRanges,
} from './windows.ts';
