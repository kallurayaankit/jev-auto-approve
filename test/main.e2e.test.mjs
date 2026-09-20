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

function jevAnswer(confidence, choice = 'approve') {
  return {
    model: 'jev-1.13.0',
    answers: {
      verdict: {
        type: 'choice',
        choice,
        confidence,
        probabilities: { approve: confidence, request_changes: 1 - confidence },
      },
    },
    usage: { input_tokens: 10, output_tokens: 2 },
  };
}

async function startStub({ jevResponse }) {
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

async function runAction({ jevResponse, inputs = {} }) {
  const { server, seen, base } = await startStub({ jevResponse });
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
        'INPUT_JEV-API-KEY': 'jev-key',
        'INPUT_APPROVE-TOKEN': 'bot-token',
        'INPUT_GITHUB-TOKEN': 'read-token',
        'INPUT_CONFIDENCE-THRESHOLD': '0.9',
        INPUT_PROMPT: 'Approve documentation-only changes.',
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
  const { status, seen, outputs, stdout } = await runAction({ jevResponse: jevAnswer(0.97) });
  assert.equal(status, 0);
  assert.equal(outputs.approved, 'true');
  assert.equal(outputs.verdict, 'approve');
  assert.equal(outputs['pr-number'], '5');

  const review = seen.find((call) => call.url.endsWith('/reviews'));
  assert.ok(review, 'expected an approving review');
  assert.equal(JSON.parse(review.body).event, 'APPROVE');
  assert.equal(review.auth, 'Bearer bot-token');
  // The PR is read with the read token, never the approving one.
  assert.equal(seen.find((call) => call.accept?.includes('diff')).auth, 'Bearer read-token');
  // Secrets are masked in the log.
  assert.match(stdout, /::add-mask::jev-key/);

  const jev = JSON.parse(seen.find((call) => call.url === '/v1/systemone').body);
  assert.match(jev.state, /Fix typo in the README/);
  assert.match(jev.state, /diff --git/);
  assert.match(jev.questions.verdict.instructions, /Approve documentation-only changes\./);
});

test('comments instead of approving when confidence is below the threshold', async () => {
  const { status, seen, outputs } = await runAction({
    jevResponse: jevAnswer(0.5),
    inputs: { 'INPUT_CONFIDENCE-THRESHOLD': '0.95' },
  });
  assert.equal(status, 0);
  assert.equal(outputs.approved, 'false');
  assert.match(outputs.reason, /below the threshold/);
  assert.ok(!seen.some((call) => call.url.endsWith('/reviews')));
  assert.ok(seen.some((call) => call.url.endsWith('/issues/5/comments')));
});

test('dry-run submits nothing', async () => {
  const { status, seen, outputs } = await runAction({
    jevResponse: jevAnswer(0.99),
    inputs: { 'INPUT_DRY-RUN': 'true' },
  });
  assert.equal(status, 0);
  assert.equal(outputs.approved, 'false');
  assert.ok(!seen.some((call) => call.method === 'POST' && call.url.startsWith('/repos')));
});

test('fails when the approve-token is not the expected approver', async () => {
  const { status, stdout, seen } = await runAction({
    jevResponse: jevAnswer(0.99),
    inputs: { INPUT_APPROVER: 'someone-else' },
  });
  assert.equal(status, 1);
  assert.match(stdout, /::error::approve-token belongs to "cubby-mb"/);
  // Bails before spending a Jev call.
  assert.ok(!seen.some((call) => call.url === '/v1/systemone'));
});

test('skips a request_changes verdict without touching the pull request', async () => {
  const { status, outputs, seen } = await runAction({ jevResponse: jevAnswer(0.99, 'request_changes') });
  assert.equal(status, 0);
  assert.equal(outputs.approved, 'false');
  assert.equal(outputs.verdict, 'request_changes');
  assert.ok(!seen.some((call) => call.url.endsWith('/reviews')));
});
