// Exercises src/main.mjs the way the runner does: real process, stubbed GitHub and Jev endpoints.
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const MAIN = fileURLToPath(new URL('../src/main.mjs', import.meta.url));

const PULL_REQUEST = {
  number: 5,
  title: 'Fix typo in the README',
  body: 'One word.',
  draft: false,
  labels: [{ name: 'docs' }],
  user: { login: 'someone' },
  base: { ref: 'main', repo: { full_name: 'acme/widgets' } },
  head: { ref: 'typo' },
  changed_files: 1,
  additions: 1,
  deletions: 1,
};

// One noul per default question; each is the probability that question is answered yes.
function jevAnswer({ ready = 0.99, tested = 0.98, needsHuman = 0.02 } = {}) {
  return {
    model: 'jev-1.13.0',
    answers: {
      ready_to_merge: { type: 'noul', noul: ready },
      tests_sufficient: { type: 'noul', noul: tested },
      needs_human_review: { type: 'noul', noul: needsHuman },
    },
    usage: { input_tokens: 1234, output_tokens: 20 },
  };
}

const ISSUE_COMMENTS = [
  { created_at: '2026-01-02', user: { login: 'alice' }, body: 'Did you run this against staging?' },
  { created_at: '2026-01-03', user: { login: 'cubby-mb' }, body: '<!-- jev-auto-approve --> an earlier verdict' },
];
const REVIEW_COMMENTS = [
  { created_at: '2026-01-04', user: { login: 'bob' }, path: 'README.md', line: 3, body: 'typo of a typo fix' },
];
const REVIEWS = [
  { submitted_at: '2026-01-05', user: { login: 'bob' }, state: 'COMMENTED', body: 'looks fine to me' },
];

async function startStub({ jevResponse, forbidDiscussion = false }) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, accept: req.headers.accept, auth: req.headers.authorization, body });
      const send = (code, payload, type = 'application/json') => {
        res.writeHead(code, { 'content-type': type });
        res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
      };
      if (req.url === '/user') return send(200, { login: 'cubby-mb' });
      if (req.url === '/repos/acme/widgets/pulls/5') {
        return req.headers.accept.includes('diff')
          ? send(200, 'diff --git a/README.md b/README.md\n+fixed\n', 'text/plain')
          : send(200, PULL_REQUEST);
      }
      if (req.url.includes('per_page=100') && forbidDiscussion) return send(403, { message: 'forbidden' });
      if (req.url === '/repos/acme/widgets/pulls/5/reviews?per_page=100') return send(200, REVIEWS);
      if (req.url === '/repos/acme/widgets/pulls/5/comments?per_page=100') return send(200, REVIEW_COMMENTS);
      if (req.url === '/repos/acme/widgets/issues/5/comments?per_page=100') return send(200, ISSUE_COMMENTS);
      if (req.url === '/repos/acme/widgets/pulls/5/reviews') return send(200, { id: 1, state: 'APPROVED' });
      if (req.url === '/repos/acme/widgets/issues/5/comments') return send(201, { id: 2 });
      if (req.url === '/v1/systemone') return send(200, jevResponse);
      return send(404, { message: 'not found' });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, seen, base: `http://127.0.0.1:${server.address().port}` };
}

function parseOutputs(raw) {
  const outputs = {};
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(/^([\w-]+)<<(ghadelimiter_.+)$/);
    if (!match) continue;
    const [, name, delimiter] = match;
    const value = [];
    for (i += 1; i < lines.length && lines[i] !== delimiter; i += 1) value.push(lines[i]);
    outputs[name] = value.join('\n');
  }
  return outputs;
}

async function runAction({ jevResponse, inputs = {}, forbidDiscussion = false }) {
  const { server, seen, base } = await startStub({ jevResponse, forbidDiscussion });
  const dir = mkdtempSync(join(tmpdir(), 'jev-auto-approve-'));
  const eventPath = join(dir, 'event.json');
  const outputPath = join(dir, 'output.txt');
  // issue_comment payload: the PR number has to come off the issue, not a pull_request object.
  writeFileSync(eventPath, JSON.stringify({ issue: { number: 5, pull_request: {} } }));
  writeFileSync(outputPath, '');

  const result = await new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(process.execPath, [MAIN], {
      env: {
        PATH: process.env.PATH,
        GITHUB_API_URL: base,
        JEV_API_URL: `${base}/v1/systemone`,
        GITHUB_REPOSITORY: 'acme/widgets',
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_OUTPUT: outputPath,
        GITHUB_STEP_SUMMARY: join(dir, 'summary.md'),
        GITHUB_SERVER_URL: 'https://github.com',
        GITHUB_RUN_ID: '42',
        GITHUB_RUN_ATTEMPT: '1',
        'INPUT_JEV-API-KEY': 'jev-key',
        'INPUT_APPROVE-TOKEN': 'bot-token',
        'INPUT_GITHUB-TOKEN': 'read-token',
        'INPUT_CONFIDENCE-THRESHOLD': '0.9',
        INPUT_QUESTIONS: '',
        INPUT_APPROVER: 'cubby-mb',
        INPUT_MODEL: 'jev-latest',
        'INPUT_DRY-RUN': 'false',
        'INPUT_COMMENT-ON-SKIP': 'true',
        'INPUT_MAX-DIFF-BYTES': '200000',
        ...inputs,
      },
    });
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (status) => resolve({ stdout, stderr, status }));
  });

  server.close();
  return { ...result, seen, outputs: parseOutputs(readFileSync(outputPath, 'utf8')) };
}

test('approves the pull request as the approve-token identity', async () => {
  const { status, seen, outputs, stdout } = await runAction({ jevResponse: jevAnswer() });
  assert.equal(status, 0);
  assert.equal(outputs.approved, 'true');
  assert.equal(outputs.verdict, 'approve');
  assert.deepEqual(JSON.parse(outputs.answers).needs_human_review, {
    confidence: 0.98,
    yesProbability: 0.02,
    passed: true,
  });
  assert.equal(outputs['pr-number'], '5');

  const review = seen.find((call) => call.method === 'POST' && call.url.endsWith('/pulls/5/reviews'));
  assert.ok(review, 'expected an approving review');
  const submitted = JSON.parse(review.body);
  assert.equal(submitted.event, 'APPROVE');
  assert.equal(review.auth, 'Bearer bot-token');
  // The comment carries the verdict, a row per question, the tokens spent, and a link to the run.
  assert.match(submitted.body, /Verdict: `approve`/);
  assert.match(submitted.body, /\| `ready_to_merge` \|.*`0\.990` \| ✅ \|/);
  assert.match(submitted.body, /\| `needs_human_review` \|.*approve on \*\*no\*\*.*`0\.980` \| ✅ \|/);
  assert.match(submitted.body, /`1234` in \/ `20` out/);
  assert.match(submitted.body, /https:\/\/github\.com\/acme\/widgets\/actions\/runs\/42\/attempts\/1/);

  // The PR is read with the read token, never the approving one.
  assert.equal(seen.find((call) => call.accept?.includes('diff')).auth, 'Bearer read-token');
  // Secrets are masked in the log.
  assert.match(stdout, /::add-mask::jev-key/);

  const jev = JSON.parse(seen.find((call) => call.url === '/v1/systemone').body);
  assert.match(jev.state, /Fix typo in the README/, 'title');
  assert.match(jev.state, /One word\./, 'description');
  assert.match(jev.state, /Did you run this against staging\?/, 'issue comment');
  assert.match(jev.state, /review comment by @bob on README\.md:3/, 'inline review comment');
  assert.match(jev.state, /review by @bob - COMMENTED/, 'submitted review');
  assert.match(jev.state, /diff --git/, 'diff');
  // A previous verdict from this action is not fed back in as discussion.
  assert.ok(!jev.state.includes('an earlier verdict'));

  // Every default question is asked in the one call.
  assert.deepEqual(Object.keys(jev.questions), ['ready_to_merge', 'tests_sufficient', 'needs_human_review']);
  assert.equal(jev.questions.tests_sufficient.type, 'noul');
  assert.match(jev.questions.tests_sufficient.instructions, /covered by testing/);
  assert.ok(jev.questions.needs_human_review.criteria.true.startsWith('Yes:'));
});

test('comments instead of approving when confidence is below the threshold', async () => {
  const { status, seen, outputs } = await runAction({
    jevResponse: jevAnswer({ tested: 0.5 }),
    inputs: { 'INPUT_CONFIDENCE-THRESHOLD': '0.95' },
  });
  assert.equal(status, 0);
  assert.equal(outputs.approved, 'false');
  assert.equal(outputs.verdict, 'human_review_required');
  assert.match(outputs.reason, /"tests_sufficient" at 0\.500 did not clear the threshold/);
  assert.ok(!seen.some((call) => call.method === 'POST' && call.url.endsWith('/pulls/5/reviews')));
  const comment = seen.find((call) => call.method === 'POST' && call.url.endsWith('/issues/5/comments'));
  assert.ok(comment, 'expected an explanatory comment');
  const body = JSON.parse(comment.body).body;
  assert.match(body, /Verdict: `human_review_required`/);
  // The question that held it back is marked, the ones that passed are not.
  assert.match(body, /\| `tests_sufficient` \|.*`0\.500` \| ❌ \|/);
  assert.match(body, /\| `ready_to_merge` \|.*✅ \|/);
  assert.match(body, /`1234` in \/ `20` out/);
  assert.match(body, /actions\/runs\/42/);
  // Carries the marker so the next run does not read its own verdict back as discussion.
  assert.match(body, /<!-- jev-auto-approve -->/);
});

test('dry-run submits nothing', async () => {
  const { status, seen, outputs } = await runAction({
    jevResponse: jevAnswer(),
    inputs: { 'INPUT_DRY-RUN': 'true' },
  });
  assert.equal(status, 0);
  assert.equal(outputs.approved, 'false');
  assert.ok(!seen.some((call) => call.method === 'POST' && call.url.startsWith('/repos')));
});

test('a discussion the token cannot read is reported to Jev as missing', async () => {
  const { status, seen } = await runAction({
    jevResponse: jevAnswer(),
    forbidDiscussion: true,
  });
  assert.equal(status, 0);
  const jev = JSON.parse(seen.find((call) => call.url === '/v1/systemone').body);
  assert.match(jev.state, /Discussion: could not be retrieved/);
});

test('fails when the approve-token is not the expected approver', async () => {
  const { status, stdout, seen } = await runAction({
    jevResponse: jevAnswer(),
    inputs: { INPUT_APPROVER: 'someone-else' },
  });
  assert.equal(status, 1);
  assert.match(stdout, /::error::approve-token belongs to "cubby-mb"/);
  // Bails before spending a Jev call.
  assert.ok(!seen.some((call) => call.url === '/v1/systemone'));
});

test('a confident yes - a human is needed - does not approve', async () => {
  const { status, outputs, seen } = await runAction({ jevResponse: jevAnswer({ needsHuman: 0.99 }) });
  assert.equal(status, 0);
  assert.equal(outputs.approved, 'false');
  assert.equal(outputs.verdict, 'human_review_required');
  assert.ok(!seen.some((call) => call.method === 'POST' && call.url.endsWith('/pulls/5/reviews')));
});
