import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type {
  ActionProposal,
  ExecutionResult,
  HumanResolution,
  OutcomeRecord,
  PendingReview,
  Sec0Decision,
} from "./types";

export interface FileReviewLoopStorePaths {
  proposals: string;
  decisions: string;
  resolutions: string;
  executions: string;
  outcomes: string;
}

export interface FileReviewLoopStoreConfig {
  rootDir: string;
  paths?: Partial<FileReviewLoopStorePaths>;
}

function defaultPaths(rootDir: string): FileReviewLoopStorePaths {
  return {
    proposals: resolve(rootDir, "action-proposals.ndjson"),
    decisions: resolve(rootDir, "sec0-decisions.ndjson"),
    resolutions: resolve(rootDir, "human-resolutions.ndjson"),
    executions: resolve(rootDir, "execution-results.ndjson"),
    outcomes: resolve(rootDir, "outcome-records.ndjson"),
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

function latestByProposalId<T extends { proposal_id: string }>(rows: T[]): Map<string, T> {
  const out = new Map<string, T>();
  for (const row of rows) {
    out.set(row.proposal_id, row);
  }
  return out;
}

export class FileReviewLoopStore {
  readonly paths: FileReviewLoopStorePaths;

  constructor(config: FileReviewLoopStoreConfig) {
    this.paths = {
      ...defaultPaths(config.rootDir),
      ...(config.paths || {}),
    };
  }

  appendProposal(proposal: ActionProposal): ActionProposal {
    appendNdjson(this.paths.proposals, proposal);
    return proposal;
  }

  appendDecision(decision: Sec0Decision): Sec0Decision {
    appendNdjson(this.paths.decisions, decision);
    return decision;
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

  appendExecution(result: ExecutionResult): ExecutionResult {
    appendNdjson(this.paths.executions, result);
    return result;
  }

  appendOutcome(
    outcome: OutcomeRecord,
  ): OutcomeRecord {
    const normalized: OutcomeRecord = {
      ...outcome,
      outcome_id: outcome.outcome_id || randomUUID(),
    };
    appendNdjson(this.paths.outcomes, normalized);
    return normalized;
  }

  readProposals(): ActionProposal[] {
    return readNdjson<ActionProposal>(this.paths.proposals);
  }

  readDecisions(): Sec0Decision[] {
    return readNdjson<Sec0Decision>(this.paths.decisions);
  }

  readResolutions(): HumanResolution[] {
    return readNdjson<HumanResolution>(this.paths.resolutions);
  }

  readExecutions(): ExecutionResult[] {
    return readNdjson<ExecutionResult>(this.paths.executions);
  }

  readOutcomes(): OutcomeRecord[] {
    return readNdjson<OutcomeRecord>(this.paths.outcomes);
  }

  getProposal(proposalId: string): ActionProposal | null {
    return this.readProposals().find((proposal) => proposal.proposal_id === proposalId) || null;
  }

  getDecision(proposalId: string): Sec0Decision | null {
    return this.readDecisions().find((decision) => decision.proposal_id === proposalId) || null;
  }

  getLatestResolution(proposalId: string): HumanResolution | null {
    const matches = this.readResolutions().filter((resolution) => resolution.proposal_id === proposalId);
    return matches.at(-1) || null;
  }

  getLatestResolutionByReviewId(reviewId: string): HumanResolution | null {
    const matches = this.readResolutions().filter(
      (resolution) => String(resolution.metadata?.review_id || "") === reviewId,
    );
    return matches.at(-1) || null;
  }

  listPendingReviews(): PendingReview[] {
    const proposals = latestByProposalId(this.readProposals());
    const decisions = latestByProposalId(this.readDecisions());
    const resolutions = latestByProposalId(this.readResolutions());

    return [...decisions.values()]
      .filter((decision) => decision.decision === "escalate")
      .filter((decision) => !resolutions.has(decision.proposal_id))
      .map((decision) => ({
        proposal: proposals.get(decision.proposal_id)!,
        decision,
        latest_resolution: null,
      }))
      .filter((pending) => Boolean(pending.proposal));
  }
}
