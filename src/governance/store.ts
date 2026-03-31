import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type {
  ClarificationAnswer,
  ClarificationRequest,
  ExecutionRecord,
  ExecutionReflectionRecord,
  GovernanceJsonObject,
  GovernanceJsonValue,
  GovernanceRecord,
  GovernanceSubmission,
  GovernanceDecision,
  HumanResolution,
  ImprovementProposal,
  OutcomeRecord,
  PendingGovernanceReview,
  PreferenceComparison,
  PreferenceExample,
  PromotionEvaluation,
  ReplayEventRow,
  RewardOutcomeRow,
} from "./types";

export interface FileGovernanceStorePaths {
  submissions: string;
  decisions: string;
  clarifications: string;
  clarificationAnswers: string;
  resolutions: string;
  executions: string;
  reflections: string;
  outcomes: string;
  improvements: string;
  promotions: string;
}

export interface FileGovernanceStoreConfig {
  rootDir: string;
  paths?: Partial<FileGovernanceStorePaths>;
}

function defaultPaths(rootDir: string): FileGovernanceStorePaths {
  return {
    submissions: resolve(rootDir, "governance-submissions.ndjson"),
    decisions: resolve(rootDir, "governance-decisions.ndjson"),
    clarifications: resolve(rootDir, "clarification-requests.ndjson"),
    clarificationAnswers: resolve(rootDir, "clarification-answers.ndjson"),
    resolutions: resolve(rootDir, "human-resolutions.ndjson"),
    executions: resolve(rootDir, "execution-records.ndjson"),
    reflections: resolve(rootDir, "execution-reflections.ndjson"),
    outcomes: resolve(rootDir, "outcome-records.ndjson"),
    improvements: resolve(rootDir, "improvement-proposals.ndjson"),
    promotions: resolve(rootDir, "promotion-evaluations.ndjson"),
  };
}

function ensureParent(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
}

function appendNdjson(filePath: string, row: unknown): void {
  ensureParent(filePath);
  appendFileSync(filePath, `${JSON.stringify(row)}\n`, "utf8");
}

function readNdjson<T>(filePath: string): T[] {
  if (!existsSync(filePath)) {
    return [];
  }
  return readFileSync(filePath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as T);
}

function stableJson(value: GovernanceJsonValue | undefined): GovernanceJsonValue {
  if (Array.isArray(value)) {
    return value.map((item) => stableJson(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nestedValue]) => [key, stableJson(nestedValue)]),
    );
  }
  return value ?? null;
}

function stringifyStable(value: GovernanceJsonValue | undefined): string {
  return JSON.stringify(stableJson(value));
}

function hashValue(value: GovernanceJsonValue | undefined): string {
  return createHash("sha256").update(stringifyStable(value)).digest("hex");
}

function submissionPrompt(submission: GovernanceSubmission): string {
  return [
    `tenant_id: ${submission.tenant_id}`,
    `workflow_id: ${submission.workflow_id}`,
    `node_id: ${submission.node_id}`,
    `run_id: ${submission.run_id}`,
    `event_kind: ${submission.event_kind}`,
    `actor: ${stringifyStable(submission.actor as unknown as GovernanceJsonValue)}`,
    `target: ${stringifyStable(submission.target as unknown as GovernanceJsonValue)}`,
    `authority: ${stringifyStable(submission.authority as unknown as GovernanceJsonValue)}`,
    `payload: ${stringifyStable(submission.payload)}`,
    `state_slice: ${stringifyStable((submission.state_slice || {}) as GovernanceJsonValue)}`,
    `provenance: ${stringifyStable(submission.provenance as GovernanceJsonValue)}`,
    `metadata: ${stringifyStable(submission.metadata)}`,
  ].join("\n");
}

function assistantCompletion(payload: GovernanceJsonObject): PreferenceComparison["completion_A"] {
  return [{ role: "assistant", content: JSON.stringify(payload) }];
}

function chosenAndRejectedForResolution(
  submission: GovernanceSubmission,
  resolution: HumanResolution,
): {
  chosen: GovernanceJsonObject;
  rejected: GovernanceJsonObject;
} {
  const executeOriginal: GovernanceJsonObject = {
    mode: "execute",
    event_kind: submission.event_kind,
    target: stableJson(submission.target as unknown as GovernanceJsonValue) as GovernanceJsonObject,
    payload: stableJson(submission.payload) as GovernanceJsonObject,
  };
  if (resolution.action === "edit") {
    return {
      chosen: {
        mode: "execute",
        event_kind: submission.event_kind,
        target: stableJson(submission.target as unknown as GovernanceJsonValue) as GovernanceJsonObject,
        payload: stableJson(resolution.edited_payload || {}) as GovernanceJsonObject,
      },
      rejected: executeOriginal,
    };
  }
  if (resolution.action === "reject") {
    return {
      chosen: {
        mode: "reject",
        event_kind: submission.event_kind,
        target: stableJson(submission.target as unknown as GovernanceJsonValue) as GovernanceJsonObject,
        reason: resolution.feedback || "human_rejected",
      },
      rejected: executeOriginal,
    };
  }
  return {
    chosen: executeOriginal,
    rejected: {
      mode: "escalate",
      event_kind: submission.event_kind,
      target: stableJson(submission.target as unknown as GovernanceJsonValue) as GovernanceJsonObject,
      reason: "unnecessary_human_review",
    },
  };
}

function latestBySubmissionId<T extends { submission_id: string }>(rows: T[]): Map<string, T> {
  const out = new Map<string, T>();
  for (const row of rows) {
    out.set(row.submission_id, row);
  }
  return out;
}

function latestByImprovementId<T extends { improvement_id: string }>(rows: T[]): Map<string, T> {
  const out = new Map<string, T>();
  for (const row of rows) {
    out.set(row.improvement_id, row);
  }
  return out;
}

function latestOutcomeBySubmissionId(rows: OutcomeRecord[]): Map<string, OutcomeRecord> {
  const out = new Map<string, OutcomeRecord>();
  for (const row of rows) {
    if (row.submission_id) {
      out.set(row.submission_id, row);
    }
  }
  return out;
}

function replayPayload(row: unknown): GovernanceJsonObject {
  return JSON.parse(JSON.stringify(row)) as GovernanceJsonObject;
}

export class FileGovernanceStore {
  readonly paths: FileGovernanceStorePaths;

  constructor(config: FileGovernanceStoreConfig) {
    this.paths = {
      ...defaultPaths(config.rootDir),
      ...(config.paths || {}),
    };
  }

  appendSubmission(submission: GovernanceSubmission): GovernanceSubmission {
    appendNdjson(this.paths.submissions, submission);
    return submission;
  }

  appendDecision(decision: GovernanceDecision): GovernanceDecision {
    const normalized = {
      ...decision,
      decision_id: decision.decision_id || randomUUID(),
    };
    appendNdjson(this.paths.decisions, normalized);
    return normalized;
  }

  appendClarificationRequest(
    clarification: Omit<ClarificationRequest, "clarification_id"> & { clarification_id?: string },
  ): ClarificationRequest {
    const normalized: ClarificationRequest = {
      ...clarification,
      clarification_id: clarification.clarification_id || randomUUID(),
    };
    appendNdjson(this.paths.clarifications, normalized);
    return normalized;
  }

  appendClarificationAnswer(
    answer: Omit<ClarificationAnswer, "answer_id"> & { answer_id?: string },
  ): ClarificationAnswer {
    const normalized: ClarificationAnswer = {
      ...answer,
      answer_id: answer.answer_id || randomUUID(),
    };
    appendNdjson(this.paths.clarificationAnswers, normalized);
    return normalized;
  }

  appendResolution(
    resolution: Omit<HumanResolution, "resolution_id"> & { resolution_id?: string },
  ): HumanResolution {
    const normalized: HumanResolution = {
      ...resolution,
      resolution_id: resolution.resolution_id || randomUUID(),
    };
    appendNdjson(this.paths.resolutions, normalized);
    return normalized;
  }

  appendExecution(result: ExecutionRecord): ExecutionRecord {
    appendNdjson(this.paths.executions, result);
    return result;
  }

  appendReflection(
    reflection: Omit<ExecutionReflectionRecord, "reflection_id" | "event_kind"> & { reflection_id?: string },
  ): ExecutionReflectionRecord {
    const normalized: ExecutionReflectionRecord = {
      ...reflection,
      event_kind: "execution_reflection",
      reflection_id: reflection.reflection_id || randomUUID(),
    };
    appendNdjson(this.paths.reflections, normalized);
    return normalized;
  }

  appendOutcome(outcome: OutcomeRecord): OutcomeRecord {
    const normalized: OutcomeRecord = {
      ...outcome,
      outcome_id: outcome.outcome_id || randomUUID(),
    };
    appendNdjson(this.paths.outcomes, normalized);
    return normalized;
  }

  appendImprovement(
    improvement: Omit<ImprovementProposal, "improvement_id"> & { improvement_id?: string },
  ): ImprovementProposal {
    const normalized: ImprovementProposal = {
      ...improvement,
      improvement_id: improvement.improvement_id || randomUUID(),
    };
    appendNdjson(this.paths.improvements, normalized);
    return normalized;
  }

  appendPromotionEvaluation(
    evaluation: Omit<PromotionEvaluation, "evaluation_id"> & { evaluation_id?: string },
  ): PromotionEvaluation {
    const normalized: PromotionEvaluation = {
      ...evaluation,
      evaluation_id: evaluation.evaluation_id || randomUUID(),
    };
    appendNdjson(this.paths.promotions, normalized);
    return normalized;
  }

  readSubmissions(): GovernanceSubmission[] {
    return readNdjson<GovernanceSubmission>(this.paths.submissions);
  }

  readDecisions(): GovernanceDecision[] {
    return readNdjson<GovernanceDecision>(this.paths.decisions);
  }

  readClarificationRequests(): ClarificationRequest[] {
    return readNdjson<ClarificationRequest>(this.paths.clarifications);
  }

  readClarificationAnswers(): ClarificationAnswer[] {
    return readNdjson<ClarificationAnswer>(this.paths.clarificationAnswers);
  }

  readResolutions(): HumanResolution[] {
    return readNdjson<HumanResolution>(this.paths.resolutions);
  }

  readExecutions(): ExecutionRecord[] {
    return readNdjson<ExecutionRecord>(this.paths.executions);
  }

  readReflections(): ExecutionReflectionRecord[] {
    return readNdjson<ExecutionReflectionRecord>(this.paths.reflections);
  }

  readOutcomes(): OutcomeRecord[] {
    return readNdjson<OutcomeRecord>(this.paths.outcomes);
  }

  readImprovements(): ImprovementProposal[] {
    return readNdjson<ImprovementProposal>(this.paths.improvements);
  }

  readPromotions(): PromotionEvaluation[] {
    return readNdjson<PromotionEvaluation>(this.paths.promotions);
  }

  getSubmission(submissionId: string): GovernanceSubmission | null {
    return this.readSubmissions().find((submission) => submission.submission_id === submissionId) || null;
  }

  getDecision(submissionId: string): GovernanceDecision | null {
    return this.readDecisions().find((decision) => decision.submission_id === submissionId) || null;
  }

  getLatestClarificationRequest(submissionId: string): ClarificationRequest | null {
    const matches = this.readClarificationRequests().filter(
      (clarification) => clarification.submission_id === submissionId,
    );
    return matches.at(-1) || null;
  }

  getLatestClarificationAnswer(submissionId: string): ClarificationAnswer | null {
    const matches = this.readClarificationAnswers().filter((answer) => answer.submission_id === submissionId);
    return matches.at(-1) || null;
  }

  getLatestResolution(submissionId: string): HumanResolution | null {
    const matches = this.readResolutions().filter((resolution) => resolution.submission_id === submissionId);
    return matches.at(-1) || null;
  }

  getReflections(submissionId: string): ExecutionReflectionRecord[] {
    return this.readReflections().filter((reflection) => reflection.submission_id === submissionId);
  }

  listPendingReviews(): PendingGovernanceReview[] {
    const submissions = latestBySubmissionId(this.readSubmissions());
    const decisions = latestBySubmissionId(this.readDecisions());
    const resolutions = latestBySubmissionId(this.readResolutions());
    const clarifications = latestBySubmissionId(this.readClarificationRequests());
    const clarificationAnswers = latestBySubmissionId(this.readClarificationAnswers());

    return [...decisions.values()]
      .filter((decision) => decision.decision === "escalate" || decision.decision === "clarify")
      .filter((decision) => {
        if (decision.decision === "clarify") {
          const clarification = clarifications.get(decision.submission_id);
          if (!clarification) return true;
          if (clarification.status === "answered") return false;
          return !clarificationAnswers.has(decision.submission_id);
        }
        return !resolutions.has(decision.submission_id);
      })
      .map((decision) => ({
        submission: submissions.get(decision.submission_id)!,
        decision,
        clarification_request: clarifications.get(decision.submission_id) || null,
        latest_resolution: resolutions.get(decision.submission_id) || null,
      }))
      .filter((pending) => Boolean(pending.submission));
  }

  getReviewKey(submission: GovernanceSubmission): string {
    const explicitKey = submission.metadata?.review_key;
    if (typeof explicitKey === "string" && explicitKey.trim()) {
      return explicitKey;
    }
    return hashValue({
      tenant_id: submission.tenant_id,
      workflow_id: submission.workflow_id,
      event_kind: submission.event_kind,
      action_type: submission.target.action_type,
      action_name: submission.target.action_name,
      payload: submission.payload,
    });
  }

  getLatestResolutionForEquivalentSubmission(submission: GovernanceSubmission): HumanResolution | null {
    const reviewKey = this.getReviewKey(submission);
    const submissionsById = latestBySubmissionId(this.readSubmissions());
    const resolutions = this.readResolutions();
    const matches = resolutions.filter((resolution) => {
      const candidateSubmission = submissionsById.get(resolution.submission_id);
      return Boolean(candidateSubmission) && this.getReviewKey(candidateSubmission!) === reviewKey;
    });
    return matches.at(-1) || null;
  }

  getJoinedRecords(): GovernanceRecord[] {
    const submissions = this.readSubmissions();
    const decisions = latestBySubmissionId(this.readDecisions());
    const clarifications = latestBySubmissionId(this.readClarificationRequests());
    const clarificationAnswers = latestBySubmissionId(this.readClarificationAnswers());
    const resolutions = latestBySubmissionId(this.readResolutions());
    const executions = latestBySubmissionId(this.readExecutions());
    const reflections = this.readReflections();
    const outcomes = latestOutcomeBySubmissionId(this.readOutcomes());
    const improvements = this.readImprovements();
    const promotionsByImprovement = latestByImprovementId(this.readPromotions());

    return submissions.map((submission) => {
      const submissionImprovements = improvements.filter(
        (improvement) => improvement.submission_id === submission.submission_id,
      );
      return {
        submission,
        decision: decisions.get(submission.submission_id),
        clarification_request: clarifications.get(submission.submission_id) || null,
        clarification_answer: clarificationAnswers.get(submission.submission_id) || null,
        human_resolution: resolutions.get(submission.submission_id) || null,
        execution_record: executions.get(submission.submission_id) || null,
        reflection_records: reflections.filter(
          (reflection) => reflection.submission_id === submission.submission_id,
        ),
        outcome_record: outcomes.get(submission.submission_id) || null,
        improvements: submissionImprovements,
        promotion_evaluations: submissionImprovements
          .map((improvement) => promotionsByImprovement.get(improvement.improvement_id))
          .filter((entry): entry is PromotionEvaluation => Boolean(entry)),
      };
    });
  }

  exportPreferenceExamples(): PreferenceExample[] {
    return this.getJoinedRecords()
      .filter(
        (record): record is GovernanceRecord & { human_resolution: HumanResolution } =>
          Boolean(record.human_resolution) &&
          (record.human_resolution!.action === "approve" ||
            record.human_resolution!.action === "reject" ||
            record.human_resolution!.action === "edit"),
      )
      .map((record) => {
        const resolution = record.human_resolution!;
        const { chosen, rejected } = chosenAndRejectedForResolution(record.submission, resolution);
        return {
          submission_id: record.submission.submission_id,
          resolution_id: resolution.resolution_id,
          preference_kind: resolution.action as "approve" | "reject" | "edit",
          comparison: {
            prompt_conversation: [
              {
                role: "system",
                content:
                  "Choose the preferred governance outcome for this workflow event.",
              },
              {
                role: "user",
                content: submissionPrompt(record.submission),
              },
            ],
            completion_A: assistantCompletion(chosen),
            completion_B: assistantCompletion(rejected),
          },
          label: "A",
          chosen_completion: chosen,
          rejected_completion: rejected,
          metadata: {
            review_key: this.getReviewKey(record.submission),
            submission_payload_hash: hashValue(record.submission.payload),
            resolution_feedback: resolution.feedback || null,
          },
        };
      });
  }

  exportRewardOutcomeRows(): RewardOutcomeRow[] {
    return this.getJoinedRecords().map((record) => ({
      ...record,
      submission_id: record.submission.submission_id,
      run_id: record.submission.run_id,
    }));
  }

  exportReplayRows(): ReplayEventRow[] {
    const submissions = this.readSubmissions().map((submission) => ({
      submission_id: submission.submission_id,
      run_id: submission.run_id,
      event_type: "governance_submission" as const,
      created_at: submission.created_at,
      payload: replayPayload(submission),
    }));
    const decisions = this.readDecisions().map((decision) => ({
      submission_id: decision.submission_id,
      run_id: this.getSubmission(decision.submission_id)?.run_id || null,
      event_type: "governance_decision" as const,
      created_at: decision.created_at,
      payload: replayPayload(decision),
    }));
    const clarifications = this.readClarificationRequests().map((clarification) => ({
      submission_id: clarification.submission_id,
      run_id: this.getSubmission(clarification.submission_id)?.run_id || null,
      event_type: "clarification_request" as const,
      created_at: clarification.created_at,
      payload: replayPayload(clarification),
    }));
    const clarificationAnswers = this.readClarificationAnswers().map((answer) => ({
      submission_id: answer.submission_id,
      run_id: this.getSubmission(answer.submission_id)?.run_id || null,
      event_type: "clarification_answer" as const,
      created_at: answer.created_at,
      payload: replayPayload(answer),
    }));
    const resolutions = this.readResolutions().map((resolution) => ({
      submission_id: resolution.submission_id,
      run_id: this.getSubmission(resolution.submission_id)?.run_id || null,
      event_type: "human_resolution" as const,
      created_at: resolution.created_at,
      payload: replayPayload(resolution),
    }));
    const executions = this.readExecutions().map((execution) => ({
      submission_id: execution.submission_id,
      run_id: this.getSubmission(execution.submission_id)?.run_id || null,
      event_type: "execution_record" as const,
      created_at: execution.created_at,
      payload: replayPayload(execution),
    }));
    const reflections = this.readReflections().map((reflection) => ({
      submission_id: reflection.submission_id,
      run_id: reflection.run_id || this.getSubmission(reflection.submission_id)?.run_id || null,
      event_type: "execution_reflection" as const,
      created_at: reflection.created_at,
      payload: replayPayload(reflection),
    }));
    const outcomes = this.readOutcomes().map((outcome) => ({
      submission_id: outcome.submission_id || "",
      run_id: outcome.run_id || this.getSubmission(String(outcome.submission_id || ""))?.run_id || null,
      event_type: "outcome_record" as const,
      created_at: outcome.created_at,
      payload: replayPayload(outcome),
    }));
    const improvements = this.readImprovements().map((improvement) => ({
      submission_id: improvement.submission_id,
      run_id: this.getSubmission(improvement.submission_id)?.run_id || null,
      event_type: "improvement_proposal" as const,
      created_at: improvement.created_at,
      payload: replayPayload(improvement),
    }));
    const promotions = this.readPromotions().map((evaluation) => ({
      submission_id:
        this.readImprovements().find((improvement) => improvement.improvement_id === evaluation.improvement_id)
          ?.submission_id || "",
      run_id: null,
      event_type: "promotion_evaluation" as const,
      created_at: evaluation.created_at,
      payload: replayPayload(evaluation),
    }));

    return [
      ...submissions,
      ...decisions,
      ...clarifications,
      ...clarificationAnswers,
      ...resolutions,
      ...executions,
      ...reflections,
      ...outcomes,
      ...improvements,
      ...promotions,
    ]
      .filter(
        (row) =>
          typeof row.submission_id === "string" && row.submission_id.length > 0,
      )
      .sort((left, right) => left.created_at.localeCompare(right.created_at));
  }
}
