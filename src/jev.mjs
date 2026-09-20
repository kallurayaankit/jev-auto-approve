export const JEV_ENDPOINT = process.env.JEV_API_URL || 'https://api.typesafe.ai/v1/systemone';

export const DEFAULT_PROMPT = [
  'You are the last reviewer before this pull request merges.',
  'Approve only when the change is correct, self-consistent, and safe to ship as-is:',
  'no obvious defect, no unhandled failure path introduced, no secret or credential added,',
  'no silent behaviour change that callers are not prepared for, and tests updated when the',
  'change needs them. Anything you are unsure about belongs with a human.',
].join(' ');

export const VERDICT_CRITERIA = {
  approve: 'The change is correct and safe to merge as-is; a human reviewer would add nothing.',
  request_changes:
    'The change has a defect, a risk, a missing test, or anything else a human should look at before merge.',
};

export function buildState({ pullRequest, diff, truncated }) {
  const labels = (pullRequest.labels || []).map((label) => label.name).join(', ') || 'none';
  return [
    `Repository: ${pullRequest.base?.repo?.full_name ?? 'unknown'}`,
    `Pull request #${pullRequest.number}: ${pullRequest.title}`,
    `Author: ${pullRequest.user?.login ?? 'unknown'}`,
    `Base: ${pullRequest.base?.ref} <- Head: ${pullRequest.head?.ref}`,
    `Draft: ${Boolean(pullRequest.draft)}`,
    `Labels: ${labels}`,
    `Changed files: ${pullRequest.changed_files ?? 'unknown'} (+${pullRequest.additions ?? '?'} / -${pullRequest.deletions ?? '?'})`,
    '',
    'Description:',
    (pullRequest.body || '(no description)').trim(),
    '',
    truncated
      ? 'Diff (TRUNCATED - the full diff exceeded the size budget, so part of the change is not shown below):'
      : 'Diff:',
    diff,
  ].join('\n');
}

export function buildQuestions({ prompt }) {
  const instructions = [prompt?.trim() || DEFAULT_PROMPT, 'Decide whether this pull request can be approved as-is.']
    .join('\n\n');
  return {
    verdict: {
      type: 'choice',
      instructions,
      criteria: VERDICT_CRITERIA,
    },
  };
}

export function truncateDiff(diff, maxBytes) {
  const buffer = Buffer.from(diff, 'utf8');
  if (buffer.byteLength <= maxBytes) return { diff, truncated: false };
  return { diff: buffer.subarray(0, maxBytes).toString('utf8'), truncated: true };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function callJev({ apiKey, model, state, questions, attempts = 4, backoffMs = 1000 }) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await fetch(JEV_ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        'user-agent': 'jev-auto-approve',
      },
      body: JSON.stringify({ state, model, questions }),
    });

    if (response.ok) return response.json();

    const detail = (await response.text()).slice(0, 500);
    lastError = new Error(`Jev API returned ${response.status}: ${detail}`);
    // 429 and 529 are the documented retryable statuses; 5xx is worth one more go too.
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt === attempts) throw lastError;
    await sleep(backoffMs * 2 ** (attempt - 1) + Math.floor(Math.random() * 250));
  }
  throw lastError;
}

export function parseThreshold(raw) {
  const threshold = Number.parseFloat(raw);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new Error(
      `confidence-threshold must be a number between 0 and 1, got "${raw}"` +
        (Number.parseFloat(raw) > 1 ? ' (use 0.9, not 90)' : ''),
    );
  }
  return threshold;
}

/**
 * The approval gate. A choice answer carries both the picked option and a calibrated confidence,
 * so both have to line up: Jev has to pick approve, and be confident enough about it.
 */
export function decide(answer, threshold) {
  if (!answer || typeof answer.choice !== 'string' || typeof answer.confidence !== 'number') {
    throw new Error(`Unexpected Jev answer shape: ${JSON.stringify(answer)}`);
  }
  const { choice: verdict, confidence } = answer;
  const probabilities = answer.probabilities ?? {};
  const approveProbability = typeof probabilities.approve === 'number' ? probabilities.approve : null;

  if (verdict !== 'approve') {
    return {
      approved: false,
      verdict,
      confidence,
      approveProbability,
      probabilities,
      reason: `Jev returned "${verdict}" (confidence ${confidence.toFixed(3)}), so the pull request was not approved.`,
    };
  }
  if (confidence < threshold) {
    return {
      approved: false,
      verdict,
      confidence,
      approveProbability,
      probabilities,
      reason: `Jev returned "approve" but confidence ${confidence.toFixed(3)} is below the threshold of ${threshold}.`,
    };
  }
  return {
    approved: true,
    verdict,
    confidence,
    approveProbability,
    probabilities,
    reason: `Jev returned "approve" with confidence ${confidence.toFixed(3)} (threshold ${threshold}).`,
  };
}
