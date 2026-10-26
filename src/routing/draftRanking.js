// Rank unverified route suggestions for practical access. These weights are
// heuristic: a metre of first-leg access matters extra, transfers add a small
// fixed burden, and rough travel time breaks otherwise similar options.
const walkMeters = (option) => option.routedWalkMeters ?? option.totalWalkMeters ?? Infinity;
const accessMeters = (option) => option.routedAccessWalkMeters ?? option.accessWalkMeters ?? Infinity;

export function draftAccessibilityScore(option) {
  const transfers = Math.max(0, Number(option.transfers) || 0);
  const minutes = Number.isFinite(option.estimatedMinutes) ? option.estimatedMinutes : Infinity;
  return accessMeters(option) * 1.5 + walkMeters(option) + transfers * 250 + minutes * 10;
}

const stableTieBreak = (a, b) => accessMeters(a) - accessMeters(b) ||
  walkMeters(a) - walkMeters(b) || a.transfers - b.transfers ||
  a.estimatedMinutes - b.estimatedMinutes || String(a.id).localeCompare(String(b.id));

export function rankDraftCandidates(candidates) {
  const recommended = [...candidates].sort((a, b) => draftAccessibilityScore(a) - draftAccessibilityScore(b) || stableTieBreak(a, b))[0] ?? null;
  const fastest = [...candidates].sort((a, b) => a.estimatedMinutes - b.estimatedMinutes || stableTieBreak(a, b))[0] ?? null;
  const leastWalking = [...candidates].sort((a, b) => walkMeters(a) - walkMeters(b) || stableTieBreak(a, b))[0] ?? null;
  candidates.forEach((option) => {
    option.isRecommended = option === recommended;
    option.isFastest = option === fastest;
    option.isLeastWalking = option === leastWalking;
  });
  return { recommended, fastest, leastWalking };
}
