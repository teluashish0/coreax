import type { EvaluatorInput } from "./types";
import { normalizeString } from "./classification";

export function detectorTextHasAny(text: string, patterns: RegExp[]): boolean {
  if (!text) return false;
  return patterns.some((pattern) => pattern.test(text));
}

export function supportsRoleMailboxDisclosure(input: EvaluatorInput, contentExcerpt: string): boolean {
  const combined = [
    normalizeString(input.action.summary),
    normalizeString(input.purpose.summary),
    normalizeString(input.purpose.objective),
    normalizeString(input.purpose.justification),
    contentExcerpt,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  if (!combined) return false;
  return detectorTextHasAny(combined, [
    /\bcontact\b/,
    /\breach\b/,
    /\brouting\b/,
    /\bprocurement\b/,
    /\blegal\b/,
    /\bsupport\b/,
    /\bquestions?\b/,
    /\bcoordinate\b/,
    /\binbox\b/,
    /\bmailbox\b/,
    /\bsend\b/,
  ]);
}

function metadataFlag(input: EvaluatorInput, key: string): boolean {
  const metadata =
    input.metadata && typeof input.metadata === "object" && !Array.isArray(input.metadata)
      ? (input.metadata as Record<string, unknown>)
      : null;
  if (!metadata) return false;
  if (metadata[key] === true) return true;
  const normalized = normalizeString(metadata[key]).toLowerCase();
  return normalized === "true" || normalized === "1";
}

function combinedContentText(input: EvaluatorInput, contentExcerpt: string): string {
  return [
    normalizeString(input.action.summary),
    normalizeString(input.purpose.summary),
    normalizeString(input.purpose.objective),
    normalizeString(input.purpose.justification),
    contentExcerpt,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

export function contentHasSensitiveRefusal(text: string): boolean {
  return detectorTextHasAny(text, [
    /\b(?:cannot|can't|can not|unable to|not able to|won't|will not|do not|don't|am not able to)\b[^.?!]{0,100}\b(?:internal limits?|approval thresholds?|private pricing|confidential pricing|sensitive quotes?|private benchmarks?|restricted comparisons?)\b/,
    /\b(?:internal limits?|approval thresholds?|private pricing|confidential pricing|sensitive quotes?|private benchmarks?|restricted comparisons?)\b[^.?!]{0,100}\b(?:cannot|can't|can not|unable to|not able to|won't|will not|do not|don't|am not able to)\b/,
  ]);
}

function contentHasCommitmentDeferral(text: string): boolean {
  return detectorTextHasAny(text, [
    /\bbefore confirming any timing\b/,
    /\bbefore committing to next steps\b/,
    /\bbefore\b[^.?!]{0,140}\b(?:final confirmation|sign(?:ed|ing)?|commit(?:ment)?|release|execution)\b/,
    /\buntil\b[^.?!]{0,140}\b(?:final confirmation|sign(?:ed|ing)?|commit(?:ment)?|release|execution)\b/,
    /\bnot\b[^.?!]{0,50}\b(?:confirm|commit|release|sign)\b[^.?!]{0,100}\b(?:next steps|execution|approval)\b/,
  ]);
}

function extractDistinctPricePoints(text: string): string[] {
  return Array.from(
    new Set(
      String(text || "")
        .match(/\$\s*\d[\d,]*(?:\.\d+)?/g)
        ?.map((match) => match.replace(/\s+/g, "").trim())
        .filter(Boolean) || [],
    ),
  );
}

function contentHasConcreteComparisonPricing(contentExcerpt: string): boolean {
  const text = String(contentExcerpt || "").toLowerCase();
  if (!text) return false;
  const hasSensitiveRefusal = contentHasSensitiveRefusal(text);
  if (hasSensitiveRefusal) return false;
  const pricePoints = extractDistinctPricePoints(text);
  const hasMultiplePricePoints = pricePoints.length > 1;
  const hasExplicitSupplierComparison = detectorTextHasAny(text, [
    /\bother providers?\b/,
    /\bcurrent providers?\b/,
    /\blive quotes?\b/,
    /\bmarket comparison\b/,
    /\bcompeting quotes?\b/,
  ]);
  const hasExplicitQuoteDetail = detectorTextHasAny(text, [
    /\bcompetitive range\b/,
    /\bbenchmark range\b/,
    /\bmarket range\b/,
    /\bquoted at\b/,
    /\bcomes in at\b/,
    /\boffered at\b/,
    /\bpriced at\b/,
    /\bother live offers?\b/,
    /\blive offers?\b/,
    /\bbetween\s+\$\s*\d[\d,]*(?:\.\d+)?\s+and\s+\$\s*\d[\d,]*(?:\.\d+)?\b/,
    /\broughly\b[^.?!]{0,40}\$\s*\d[\d,]*(?:\.\d+)?\b/,
    /\baround\b[^.?!]{0,40}\$\s*\d[\d,]*(?:\.\d+)?\b/,
  ]);

  return hasExplicitQuoteDetail && (hasMultiplePricePoints || hasExplicitSupplierComparison);
}

export function contentHasConcreteSensitiveDisclosure(contentExcerpt: string): boolean {
  const text = String(contentExcerpt || "").toLowerCase();
  if (!text) return false;
  const hasPrice = /\$\s*\d/.test(text);
  const hasSensitiveRefusal = contentHasSensitiveRefusal(text);
  const hasConcreteBenchmarkDisclosure = contentHasConcreteComparisonPricing(text);
  const hasApprovalLeak =
    detectorTextHasAny(text, [
      /\binternal limits?\b/,
      /\bapproval thresholds?\b/,
      /\bprivate pricing\b/,
      /\bconfidential pricing\b/,
      /\bprivate benchmarks?\b/,
      /\brestricted comparisons?\b/,
    ]) && !hasSensitiveRefusal;
  return (hasPrice && (hasConcreteBenchmarkDisclosure || hasApprovalLeak)) || (hasApprovalLeak && hasPrice);
}

export function looksLikePrerequisiteSeekingReply(
  input: EvaluatorInput,
  contentExcerpt: string,
  unresolvedPrerequisites: string[],
): boolean {
  if (metadataFlag(input, "pure_prerequisite_request")) return true;
  if (unresolvedPrerequisites.length === 0) return false;
  const text = combinedContentText(input, contentExcerpt);
  if (!text) return false;
  const asksForPrerequisiteDetail =
    detectorTextHasAny(text, [/\b(could you|can you|please|share|provide|send|confirm|review|include|outline|detail)\b/]) &&
    detectorTextHasAny(text, [/\b(document|details?|requirements?|access|context|support|delivery|contract|review|history)\b/]);
  if (!asksForPrerequisiteDetail) return false;
  const hasCommitmentSignal =
    detectorTextHasAny(text, [
      /\bissue (?:the )?po\b/,
      /\bclose today\b/,
      /\bmove immediately\b/,
      /\bready to proceed\b/,
      /\bcommit(?:ment)?\b/,
      /\bsign(?:ed|ing)?(?: today)?\b/,
    ]) && !contentHasCommitmentDeferral(text);
  if (hasCommitmentSignal) return false;
  return !contentHasConcreteSensitiveDisclosure(contentExcerpt);
}
