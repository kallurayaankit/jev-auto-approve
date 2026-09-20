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
  parseRepository,
  resolvePullRequestNumber,
  submitApproval,
} from './github.mjs';
import { buildQuestions, buildState, callJev, decide, parseThreshold, truncateDiff } from './jev.mjs';

function reviewBody({ decision, model, threshold }) {
  return [
    '🤖 **Jev auto-approve**',
    '',
    `Verdict: \`${decision.verdict}\` · confidence \`${decision.confidence.toFixed(3)}\` · threshold \`${threshold}\``,
    decision.approveProbability !== null
      ? `Probability of approve: \`${decision.approveProbability.toFixed(3)}\``
      : null,
    '',
    decision.reason,
    '',
    `<sub>Model: \`${model}\`. This approval is automated — it is a gate, not a substitute for a human reviewer.</sub>`,
  ]
    .filter((line) => line !== null)
    .join('\n');
}

async function run() {
  const jevApiKey = getInput('jev-api-key', { required: true });
  const approveToken = getInput('approve-token', { required: true });
  maskSecret(jevApiKey);
  maskSecret(approveToken);

  const githubToken = getInput('github-token', { required: true });
  const threshold = parseThreshold(getInput('confidence-threshold', { default: '0.9' }));
  const prompt = getInput('prompt');
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

  const [pullRequest, rawDiff] = await Promise.all([
    getPullRequest({ token: githubToken, owner, repo, number }),
    getPullRequestDiff({ token: githubToken, owner, repo, number }),
  ]);

  const { diff, truncated } = truncateDiff(rawDiff, maxDiffBytes);
  if (truncated) warn(`Diff exceeded ${maxDiffBytes} bytes and was truncated before being sent to Jev.`);

  const response = await callJev({
    apiKey: jevApiKey,
    model,
    state: buildState({ pullRequest, diff, truncated }),
    questions: buildQuestions({ prompt }),
  });
  info(`Jev usage: ${JSON.stringify(response.usage ?? {})}`);

  const decision = decide(response.answers?.verdict, threshold);
  setOutput('verdict', decision.verdict);
  setOutput('confidence', String(decision.confidence));
  setOutput('approve-probability', decision.approveProbability === null ? '' : String(decision.approveProbability));
  setOutput('probabilities', JSON.stringify(decision.probabilities));
  setOutput('reason', decision.reason);

  const body = reviewBody({ decision, model: response.model ?? model, threshold });

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
