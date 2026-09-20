import {
  error,
  getBooleanInput,
  getInput,
  info,
  maskSecret,
  notice,
  readEventPayload,
  setOutput,
  summary,
  warn,
} from './core.mjs';
import {
  createComment,
  getPullRequest,
  getPullRequestDiff,
  getTokenLogin,
  listIssueComments,
  listReviewComments,
  listReviews,
  parseRepository,
  resolvePullRequestNumber,
  submitApproval,
} from './github.mjs';
import {
  buildQuestions,
  buildState,
  callJev,
  COMMENT_MARKER,
  decide,
  parseThreshold,
  QUESTION_KEY,
  truncateDiff,
} from './jev.mjs';

const ACTION_URL = 'https://github.com/metalbear-co/jev-auto-approve';

/** Link back to the run that produced the verdict, so the logs are one click from the comment. */
function workflowRunUrl() {
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT } = process.env;
  if (!GITHUB_REPOSITORY || !GITHUB_RUN_ID) return null;
  const server = (GITHUB_SERVER_URL || 'https://github.com').replace(/\/$/, '');
  const attempt = GITHUB_RUN_ATTEMPT ? `/attempts/${GITHUB_RUN_ATTEMPT}` : '';
  return `${server}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}${attempt}`;
}

function reviewBody({ decision, model, threshold, usage = {} }) {
  const inputTokens = usage.input_tokens ?? 'unknown';
  const outputTokens = usage.output_tokens ?? 'unknown';
  const runUrl = workflowRunUrl();
  return [
    COMMENT_MARKER,
    '🤖 **Jev auto-approve**',
    '',
    '| | |',
    '| --- | --- |',
    `| Verdict | \`${decision.verdict}\` |`,
    `| Confidence no human reviewer is required | \`${decision.confidence.toFixed(3)}\` (threshold \`${threshold}\`) |`,
    `| Probability a human reviewer is required | \`${decision.needsHumanProbability.toFixed(3)}\` |`,
    `| Tokens | \`${inputTokens}\` in / \`${outputTokens}\` out |`,
    `| Model | \`${model}\` |`,
    runUrl ? `| Run | [workflow run](${runUrl}) |` : null,
    '',
    decision.reason,
    '',
    `<sub>Posted by [jev-auto-approve](${ACTION_URL}) — automated verdict, a gate, not a substitute for a human reviewer.</sub>`,
  ]
    .filter((line) => line !== null)
    .join('\n');
}

/**
 * Comments and reviews are context for the verdict, so losing them changes the answer rather than
 * just thinning it. A permission gap is reported to the model as missing context instead of being
 * passed off as an empty discussion.
 */
async function readDiscussion({ token, owner, repo, number }) {
  try {
    const [issueComments, reviewComments, reviews] = await Promise.all([
      listIssueComments({ token, owner, repo, number }),
      listReviewComments({ token, owner, repo, number }),
      listReviews({ token, owner, repo, number }),
    ]);
    return { issueComments, reviewComments, reviews };
  } catch (err) {
    if (err.status === 403 || err.status === 404) {
      warn(`Could not read the pull request discussion (${err.status}); Jev will be told it is missing.`);
      return { unavailable: true };
    }
    throw err;
  }
}

async function run() {
  const jevApiKey = getInput('jev-api-key', { required: true });
  const approveToken = getInput('approve-token', { required: true });
  maskSecret(jevApiKey);
  maskSecret(approveToken);

  const githubToken = getInput('github-token', { required: true });
  const threshold = parseThreshold(getInput('confidence-threshold', { default: '0.9' }));
  const instructions = getInput('instructions');
  const criteria = getInput('criteria');
  const approver = getInput('approver');
  const model = getInput('model', { default: 'jev-latest' });
  const dryRun = getBooleanInput('dry-run', false);
  const commentOnSkip = getBooleanInput('comment-on-skip', true);
  const maxDiffBytes = Number.parseInt(getInput('max-diff-bytes', { default: '200000' }), 10);
  if (!Number.isInteger(maxDiffBytes) || maxDiffBytes <= 0) {
    throw new Error(`max-diff-bytes must be a positive integer, got "${getInput('max-diff-bytes')}"`);
  }

  const { owner, repo } = parseRepository();
  const number = resolvePullRequestNumber({
    payload: readEventPayload(),
    override: getInput('pr-number'),
  });
  setOutput('pr-number', String(number));
  info(`Evaluating ${owner}/${repo}#${number}`);

  // Fail before spending a Jev call if the approving identity is not who the caller expects.
  if (approver) {
    const login = await getTokenLogin({ token: approveToken });
    if (login === null) {
      warn(
        `approve-token has no user identity (likely a GitHub App installation token), so it could not be verified against "${approver}".`,
      );
    } else if (login.toLowerCase() !== approver.toLowerCase()) {
      throw new Error(`approve-token belongs to "${login}", but the approver input expects "${approver}".`);
    } else {
      info(`approve-token verified as ${login}.`);
    }
  }

  const [pullRequest, rawDiff, discussion] = await Promise.all([
    getPullRequest({ token: githubToken, owner, repo, number }),
    getPullRequestDiff({ token: githubToken, owner, repo, number }),
    readDiscussion({ token: githubToken, owner, repo, number }),
  ]);

  const { diff, truncated } = truncateDiff(rawDiff, maxDiffBytes);
  if (truncated) warn(`Diff exceeded ${maxDiffBytes} bytes and was truncated before being sent to Jev.`);

  const response = await callJev({
    apiKey: jevApiKey,
    model,
    state: buildState({ pullRequest, diff, truncated, discussion }),
    questions: buildQuestions({ instructions, criteria }),
  });
  info(`Jev usage: ${JSON.stringify(response.usage ?? {})}`);

  const decision = decide(response.answers?.[QUESTION_KEY], threshold);
  setOutput('verdict', decision.verdict);
  setOutput('confidence', String(decision.confidence));
  setOutput('needs-human-probability', String(decision.needsHumanProbability));
  setOutput('reason', decision.reason);

  const body = reviewBody({ decision, model: response.model ?? model, threshold, usage: response.usage });

  if (!decision.approved) {
    setOutput('approved', 'false');
    notice(decision.reason);
    if (commentOnSkip) {
      await createComment({ token: approveToken, owner, repo, number, body });
    }
    summary(`## Jev auto-approve\n\nNot approved. ${decision.reason}\n`);
    return;
  }

  if (dryRun) {
    setOutput('approved', 'false');
    notice(`dry-run: would have approved. ${decision.reason}`);
    summary(`## Jev auto-approve\n\nDry run — would have approved. ${decision.reason}\n`);
    return;
  }

  try {
    await submitApproval({ token: approveToken, owner, repo, number, body });
  } catch (err) {
    if (err.status === 422) {
      throw new Error(
        `GitHub rejected the approval (422). The most common causes are the token belonging to the pull request author (GitHub forbids approving your own PR) or the token lacking pull-requests: write. Original error: ${err.message}`,
      );
    }
    throw err;
  }

  setOutput('approved', 'true');
  notice(`Approved ${owner}/${repo}#${number}. ${decision.reason}`);
  summary(`## Jev auto-approve\n\nApproved. ${decision.reason}\n`);
}

run().catch((err) => {
  error(err.message);
  setOutput('approved', 'false');
  process.exitCode = 1;
});
