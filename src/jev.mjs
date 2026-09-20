export const JEV_ENDPOINT = process.env.JEV_API_URL || 'https://api.typesafe.ai/v1/systemone';

export const QUESTION_KEY = 'needs_human_review';

export const DEFAULT_INSTRUCTIONS =
  'Does this pull request require a human reviewer before it can be merged?';

// Each side says what the answer means. Directives ("weigh this", "answer yes when") belong in
// neither: the question is the question, and the criteria are the definitions it is answered against.
export const DEFAULT_CRITERIA = {
  false: [
    'No: the change is verified, and how far it reaches is understood.',
    'Behaviour that changed is covered by tests that were added or updated, or by manual testing the pull request records.',
    'Where a human has already reviewed it, what they raised was addressed - in the code, or in an answer that holds up.',
    'Where the change reaches past this codebase - HTTP endpoints and their payloads, public function or method signatures, exported types, stored schemas, CLI flags, configuration keys - it is small and deliberate, and the pull request accounts for the callers it affects.',
    'Nothing in it touches privileged automation.',
  ].join('\n'),
  true: [
    'Yes: something about the change is unsettled, or it reaches somewhere no machine should sign off.',
    'Behaviour changed with neither tests nor a record of manual testing.',
    'Or something raised in review is unaddressed, or answered in a way that does not hold up.',
    'Or the change alters something others depend on, and the consequences for them are not accounted for.',
    'Or it touches privileged automation: CI, release, publishing, signing or credential configuration, or anything else that runs with write-capable credentials, whatever else the change does.',
    'Or the pull request does not show enough to tell which of these is the case.',
  ].join('\n'),
};

/**
 * The criteria input is free text describing when no human reviewer is needed, which is the side
 * that gates the approval. A JSON object with `true` and `false` keys is passed through instead,
 * for callers who want to phrase both sides themselves.
 */
export function parseCriteria(raw) {
  const text = (raw ?? '').trim();
  if (!text) return DEFAULT_CRITERIA;

  if (text.startsWith('{')) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new Error(`criteria looks like JSON but could not be parsed: ${err.message}`);
    }
    const hasSide = (key) => typeof parsed?.[key] === 'string' && parsed[key].trim();
    if (!hasSide('true') || !hasSide('false')) {
      throw new Error('criteria given as JSON must be an object with non-empty "true" and "false" strings.');
    }
    return { true: parsed.true.trim(), false: parsed.false.trim() };
  }

  return { false: text, true: DEFAULT_CRITERIA.true };
}

// Marks the action's own comments so a previous run's verdict is not fed back in as discussion.
export const COMMENT_MARKER = '<!-- jev-auto-approve -->';

const MAX_COMMENT_CHARS = 2000;
const MAX_COMMENTS = 50;

function trim(text) {
  const body = (text ?? '').trim();
  if (!body) return '(empty)';
  return body.length > MAX_COMMENT_CHARS ? `${body.slice(0, MAX_COMMENT_CHARS)}\n[... comment truncated]` : body;
}

const isOwnComment = (comment) => (comment.body ?? '').includes(COMMENT_MARKER);

/**
 * Renders the pull request discussion: the conversation, inline comments on the diff, and any
 * review already submitted. Ordered oldest first so the thread reads as it happened.
 */
export function formatDiscussion({ issueComments = [], reviewComments = [], reviews = [], unavailable = false }) {
  if (unavailable) {
    return ['Discussion: could not be retrieved, so any concerns raised on this pull request are NOT shown below.'];
  }

  const entries = [
    ...issueComments
      .filter((comment) => !isOwnComment(comment))
      .map((comment) => ({
        at: comment.created_at,
        line: `[comment by @${comment.user?.login ?? 'unknown'}]\n${trim(comment.body)}`,
      })),
    ...reviewComments.map((comment) => ({
      at: comment.created_at,
      line: `[review comment by @${comment.user?.login ?? 'unknown'} on ${comment.path}${
        comment.line ? `:${comment.line}` : ''
      }]\n${trim(comment.body)}`,
    })),
    ...reviews
      .filter((review) => review.state !== 'PENDING' && !isOwnComment(review))
      .map((review) => ({
        at: review.submitted_at,
        line: `[review by @${review.user?.login ?? 'unknown'} - ${review.state}]\n${trim(review.body)}`,
      })),
  ].sort((a, b) => String(a.at).localeCompare(String(b.at)));

  if (entries.length === 0) return ['Discussion: no comments or reviews on this pull request.'];

  const shown = entries.slice(-MAX_COMMENTS);
  return [
    `Discussion (${entries.length} comment(s)/review(s)${
      shown.length < entries.length ? `, showing the most recent ${shown.length}` : ''
    }):`,
    ...shown.map((entry) => entry.line),
  ];
}

export function buildState({ pullRequest, diff, truncated, discussion = {} }) {
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
    ...formatDiscussion(discussion),
    '',
    truncated
      ? 'Diff (TRUNCATED - the full diff exceeded the size budget, so part of the change is not shown below):'
      : 'Diff:',
    diff,
  ].join('\n');
}

export function buildQuestions({ instructions, criteria }) {
  return {
    [QUESTION_KEY]: {
      type: 'noul',
      instructions: instructions?.trim() || DEFAULT_INSTRUCTIONS,
      criteria: parseCriteria(criteria),
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
 * The approval gate. A noul answer is the probability that the question is answered yes, so the
 * probability a human reviewer IS required. Its complement is how sure Jev is that nobody needs to
 * look, and that is what the threshold is compared against.
 */
export function decide(answer, threshold) {
  if (!answer || typeof answer.noul !== 'number' || answer.noul < 0 || answer.noul > 1) {
    throw new Error(`Unexpected Jev answer shape: ${JSON.stringify(answer)}`);
  }
  const needsHumanProbability = answer.noul;
  const confidence = 1 - needsHumanProbability;
  const approved = confidence >= threshold;

  return {
    approved,
    verdict: approved ? 'approve' : 'human_review_required',
    confidence,
    needsHumanProbability,
    reason: approved
      ? `Jev put the probability that a human reviewer is required at ${needsHumanProbability.toFixed(3)}, so confidence that none is required is ${confidence.toFixed(3)} (threshold ${threshold}).`
      : `Jev put the probability that a human reviewer is required at ${needsHumanProbability.toFixed(3)}, so confidence that none is required is ${confidence.toFixed(3)}, below the threshold of ${threshold}.`,
  };
}
