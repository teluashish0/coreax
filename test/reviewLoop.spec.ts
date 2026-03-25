import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FileReviewLoopStore } from "../src/review-loop";
import {
  executeReviewedAction,
  normalizeActionProposal,
} from "../src/review-loop/client";
import type { ReviewLoopClient } from "../src/review-loop/client";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sec0-review-loop-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { force: true, recursive: true });
  }
});

describe("review-loop store", () => {
  it("lists pending reviews and keeps proposal-scoped resolutions", () => {
    const store = new FileReviewLoopStore({ rootDir: makeTempDir() });
    const baseProposal = normalizeActionProposal({
      run_id: "run-1",
      trace_id: "trace-1",
      tenant: "tenant-a",
      domain: "operations",
      agent_id: "agent-1",
      action_type: "tool_call",
      action_name: "submit_change_request",
      arguments: { request_id: "req-1", proposed_owner: "team-a" },
      observation_context: { requires_dual_approval: true },
      metadata: {},
    });

    const firstProposal = { ...baseProposal, proposal_id: "proposal-1" };
    const pendingProposal = {
      ...baseProposal,
      proposal_id: "proposal-2",
      arguments: { request_id: "req-2", proposed_owner: "team-b" },
      metadata: { review_id: "review-2" },
    };

    for (const proposal of [firstProposal, pendingProposal]) {
      store.appendProposal(proposal);
      store.appendDecision({
        proposal_id: proposal.proposal_id,
        decision: "escalate",
        findings: [],
        policy_reason: "requires_review",
        created_at: proposal.created_at,
      });
    }

    store.appendResolution({
      proposal_id: firstProposal.proposal_id,
      decision: "edit",
      reviewer: "alice",
      edited_arguments: { request_id: "req-1", proposed_owner: "team-security" },
      created_at: firstProposal.created_at,
    });

    const pending = store.listPendingReviews();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.proposal.proposal_id).toBe("proposal-2");
    expect(store.getLatestResolution(firstProposal.proposal_id)).toMatchObject({
      decision: "edit",
      edited_arguments: { request_id: "req-1", proposed_owner: "team-security" },
    });
    expect(store.getLatestResolution(pendingProposal.proposal_id)).toBeNull();
  });
});

describe("executeReviewedAction", () => {
  it("waits for a human edit and reports the edited execution", async () => {
    const submitProposal = vi.fn(async () => ({
      proposal: normalizeActionProposal({
        proposal_id: "proposal-1",
        run_id: "run-1",
        trace_id: "trace-1",
        tenant: "tenant-a",
        domain: "operations",
        agent_id: "agent-1",
        action_type: "tool_call",
        action_name: "assign_reviewer",
        arguments: { reviewer: "team-a" },
        observation_context: {},
        metadata: {},
      }),
      decision: {
        proposal_id: "proposal-1",
        decision: "escalate" as const,
        findings: [],
        policy_reason: "requires_review",
        created_at: new Date().toISOString(),
      },
      human_resolution: null,
      allow_execution: false,
      effective_arguments: { reviewer: "team-a" },
    }));
    const waitForHumanResolution = vi.fn(async () => ({
      resolution_id: "resolution-1",
      proposal_id: "proposal-1",
      decision: "edit" as const,
      reviewer: "alice",
      edited_arguments: { reviewer: "team-security" },
      created_at: new Date().toISOString(),
    }));
    const reportExecution = vi.fn(async (execution) => execution);

    const client: ReviewLoopClient = {
      submitProposal,
      listPendingReviews: vi.fn(),
      getHumanResolution: vi.fn(),
      waitForHumanResolution,
      resolveReview: vi.fn(),
      reportExecution,
      reportOutcome: vi.fn(),
    };

    const execute = vi.fn(async (args: { reviewer: string }) => ({
      applied_reviewer: args.reviewer,
    }));

    const result = await executeReviewedAction({
      client,
      proposal: {
        proposal_id: "proposal-1",
        run_id: "run-1",
        trace_id: "trace-1",
        tenant: "tenant-a",
        domain: "operations",
        agent_id: "agent-1",
        action_type: "tool_call",
        action_name: "assign_reviewer",
        arguments: { reviewer: "team-a" },
        observation_context: {},
        metadata: {},
        created_at: new Date().toISOString(),
      },
      waitForResolution: true,
      execute,
    });

    expect(waitForHumanResolution).toHaveBeenCalledWith("proposal-1", undefined);
    expect(execute).toHaveBeenCalledWith({ reviewer: "team-security" });
    expect(reportExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        proposal_id: "proposal-1",
        executed: true,
        final_arguments: { reviewer: "team-security" },
      }),
    );
    expect(result.value).toEqual({ applied_reviewer: "team-security" });
  });
});
