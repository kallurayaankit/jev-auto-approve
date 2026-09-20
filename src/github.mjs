const API_VERSION = '2022-11-28';

function baseUrl() {
  return (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, '');
}

async function request(path, { token, method = 'GET', accept = 'application/vnd.github+json', body } = {}) {
  const response = await fetch(`${baseUrl()}${path}`, {
    method,
    headers: {
      accept,
      authorization: `Bearer ${token}`,
      'x-github-api-version': API_VERSION,
      'user-agent': 'jev-auto-approve',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  if (!response.ok) {
    const detail = text.slice(0, 500);
    const err = new Error(`GitHub ${method} ${path} failed: ${response.status} ${detail}`);
    err.status = response.status;
    err.body = text;
    throw err;
  }
  if (accept.includes('json')) {
    return text ? JSON.parse(text) : null;
  }
  return text;
}

/**
 * Works out which pull request the run is about. Covers the events people actually wire this to:
 * pull_request / pull_request_target, issue_comment on a PR, pull_request_review(_comment), and
 * an explicit number for workflow_dispatch.
 */
export function resolvePullRequestNumber({ payload, override }) {
  if (override) {
    const parsed = Number.parseInt(override, 10);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(`pr-number must be a positive integer, got "${override}"`);
    }
    return parsed;
  }
  if (payload?.pull_request?.number) return payload.pull_request.number;
  if (payload?.issue?.pull_request && payload?.issue?.number) return payload.issue.number;
  if (payload?.inputs?.['pr-number']) return Number.parseInt(payload.inputs['pr-number'], 10);
  throw new Error(
    'Could not determine the pull request number from the event payload. Pass the pr-number input.',
  );
}

export function parseRepository(full = process.env.GITHUB_REPOSITORY || '') {
  const [owner, repo] = full.split('/');
  if (!owner || !repo) throw new Error(`Could not parse repository from "${full}"`);
  return { owner, repo };
}

export const getPullRequest = ({ token, owner, repo, number }) =>
  request(`/repos/${owner}/${repo}/pulls/${number}`, { token });

export const getPullRequestDiff = ({ token, owner, repo, number }) =>
  request(`/repos/${owner}/${repo}/pulls/${number}`, {
    token,
    accept: 'application/vnd.github.diff',
  });

const listFirstPage = (path, token) => request(`${path}?per_page=100`, { token });

export const listIssueComments = ({ token, owner, repo, number }) =>
  listFirstPage(`/repos/${owner}/${repo}/issues/${number}/comments`, token);

export const listReviewComments = ({ token, owner, repo, number }) =>
  listFirstPage(`/repos/${owner}/${repo}/pulls/${number}/comments`, token);

export const listReviews = ({ token, owner, repo, number }) =>
  listFirstPage(`/repos/${owner}/${repo}/pulls/${number}/reviews`, token);

export const submitApproval = ({ token, owner, repo, number, body }) =>
  request(`/repos/${owner}/${repo}/pulls/${number}/reviews`, {
    token,
    method: 'POST',
    body: { event: 'APPROVE', body },
  });

export const createComment = ({ token, owner, repo, number, body }) =>
  request(`/repos/${owner}/${repo}/issues/${number}/comments`, {
    token,
    method: 'POST',
    body: { body },
  });

/**
 * Resolves the login behind a token. Installation tokens have no user identity, so a 403 here
 * means "app token", not "bad token".
 */
export async function getTokenLogin({ token }) {
  try {
    const user = await request('/user', { token });
    return user?.login ?? null;
  } catch (err) {
    if (err.status === 403 || err.status === 401) return null;
    throw err;
  }
}
