export const JEV_ENDPOINT = process.env.JEV_API_URL || 'https://api.typesafe.ai/v1/systemone';

/**
 * One question per thing worth being sure about, asked in a single call and answered in parallel.
 * `approve_when` records which answer supports approval, so a question can be phrased whichever way
 * reads naturally rather than being bent to a fixed polarity.
 */
export const DEFAULT_QUESTIONS = {
  ready_to_merge: {
    instructions: 'Is this pull request ready to be merged as it stands?',
    approve_when: 'yes',
    yes: 'Yes: the change is finished. Nothing in it is a draft, a debugging leftover, a placeholder, or work the author is still deciding about.',
    no: 'No: the change is unfinished, or something in it looks like it was not meant to merge.',
  },
  tests_sufficient: {
    instructions: 'Is the behaviour this pull request changes covered by testing?',
    approve_when: 'yes',
    yes: 'Yes: tests were added or updated that exercise what changed, or the pull request already had tests that cover it, or it records manual testing that actually exercises the change.',
    no: 'No: behaviour changed and nothing shown here exercises it.',
  },
  needs_human_review: {
    instructions: 'Does this pull request require a human reviewer before it can be merged?',
    approve_when: 'no',
    yes: 'Yes: this pull request should be read by a human before it is merged.',
    no: 'No: this pull request needs no human intervention. It can be approved as it stands.',
  },
};

const SIDES = ['yes', 'no'];

function validateSpec(key, spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new Error(`Question "${key}" must be an object.`);
  }
  const text = (value) => typeof value === 'string' && value.trim();
  if (!text(spec.instructions)) {
    throw new Error(`Question "${key}" needs a non-empty "instructions".`);
  }
  for (const side of SIDES) {
    if (!text(spec[side])) {
      throw new Error(`Question "${key}" needs a non-empty "${side}" saying what that answer means.`);
    }
  }
  if (!SIDES.includes(spec.approve_when)) {
    throw new Error(`Question "${key}" needs "approve_when" set to "yes" or "no".`);
  }
  return {
    instructions: spec.instructions.trim(),
    approve_when: spec.approve_when,
    yes: spec.yes.trim(),
    no: spec.no.trim(),
  };
}

/**
 * The questions input is a JSON object of question key -> {instructions, approve_when, yes, no}.
 * Empty means the defaults above.
 */
export function parseQuestions(raw) {
  const text = (raw ?? '').trim();
  if (!text) return DEFAULT_QUESTIONS;

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`questions must be a JSON object, but could not be parsed: ${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('questions must be a JSON object keyed by question name.');
  }
  const entries = Object.entries(parsed);
  if (entries.length === 0) throw new Error('questions must name at least one question.');

  return Object.fromEntries(entries.map(([key, spec]) => [key, validateSpec(key, spec)]));
}

export function buildQuestions(specs) {
  return Object.fromEntries(
    Object.entries(specs).map(([key, spec]) => [
      key,
      { type: 'noul', instructions: spec.instructions, criteria: { true: spec.yes, false: spec.no } },
    ]),
  );
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
 * The approval gate. Every question has to clear the threshold on its own: a noul answer is the
 * probability of yes, and `approve_when` says which side of that supports approval. Reporting the
 * weakest question as the overall confidence keeps the number honest - it is the one that would
 * have to improve for the pull request to be approved.
 */
export function decide({ answers, specs, threshold }) {
  const questions = Object.entries(specs).map(([key, spec]) => {
    const answer = answers?.[key];
    if (!answer || typeof answer.noul !== 'number' || answer.noul < 0 || answer.noul > 1) {
      throw new Error(`Unexpected Jev answer for "${key}": ${JSON.stringify(answer)}`);
    }
    const yesProbability = answer.noul;
    const confidence = spec.approve_when === 'yes' ? yesProbability : 1 - yesProbability;
    return {
      key,
      instructions: spec.instructions,
      approveWhen: spec.approve_when,
      yesProbability,
      confidence,
      passed: confidence >= threshold,
    };
  });

  const failed = questions.filter((question) => !question.passed);
  const approved = failed.length === 0;
  const weakest = questions.reduce((low, question) => (question.confidence < low.confidence ? question : low));

  return {
    approved,
    verdict: approved ? 'approve' : 'human_review_required',
    questions,
    confidence: weakest.confidence,
    reason: approved
      ? `Every question cleared the threshold of ${threshold}; the narrowest was "${weakest.key}" at ${weakest.confidence.toFixed(3)}.`
      : `${failed.map((question) => `"${question.key}" at ${question.confidence.toFixed(3)}`).join(', ')} did not clear the threshold of ${threshold}.`,
  };
}
