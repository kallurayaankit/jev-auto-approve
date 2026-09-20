import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildQuestions, callJev, decide, parseThreshold, truncateDiff, VERDICT_CRITERIA } from '../src/jev.mjs';
import { parseRepository, resolvePullRequestNumber } from '../src/github.mjs';

const answer = (overrides) => ({
  type: 'choice',
  choice: 'approve',
  confidence: 0.95,
  probabilities: { approve: 0.96, request_changes: 0.04 },
  ...overrides,
});

test('approves when the verdict is approve and confidence clears the threshold', () => {
  const decision = decide(answer(), 0.9);
  assert.equal(decision.approved, true);
  assert.equal(decision.approveProbability, 0.96);
});

test('confidence exactly at the threshold approves', () => {
  assert.equal(decide(answer({ confidence: 0.9 }), 0.9).approved, true);
});

test('does not approve below the threshold', () => {
  const decision = decide(answer({ confidence: 0.89 }), 0.9);
  assert.equal(decision.approved, false);
  assert.match(decision.reason, /below the threshold/);
});

test('does not approve a request_changes verdict however confident', () => {
  const decision = decide(answer({ choice: 'request_changes', confidence: 0.99 }), 0.9);
  assert.equal(decision.approved, false);
  assert.match(decision.reason, /request_changes/);
});

test('rejects a malformed answer rather than guessing', () => {
  assert.throws(() => decide({ choice: 'approve' }, 0.9), /Unexpected Jev answer shape/);
  assert.throws(() => decide(undefined, 0.9), /Unexpected Jev answer shape/);
});

test('threshold parsing rejects percentages and nonsense', () => {
  assert.equal(parseThreshold('0.85'), 0.85);
  assert.throws(() => parseThreshold('90'), /use 0\.9, not 90/);
  assert.throws(() => parseThreshold('high'), /between 0 and 1/);
});

test('custom prompt is carried into the verdict question, criteria are not', () => {
  const questions = buildQuestions({ prompt: 'Only approve docs changes.' });
  assert.equal(questions.verdict.type, 'choice');
  assert.match(questions.verdict.instructions, /Only approve docs changes\./);
  assert.deepEqual(questions.verdict.criteria, VERDICT_CRITERIA);
});

test('empty prompt falls back to the built-in rubric', () => {
  assert.match(buildQuestions({ prompt: '  ' }).verdict.instructions, /last reviewer/);
});

test('diff truncation respects the byte budget', () => {
  assert.deepEqual(truncateDiff('abc', 10), { diff: 'abc', truncated: false });
  const { diff, truncated } = truncateDiff('a'.repeat(50), 10);
  assert.equal(truncated, true);
  assert.equal(diff.length, 10);
});

test('pull request number comes from whichever event shape is present', () => {
  assert.equal(resolvePullRequestNumber({ payload: { pull_request: { number: 7 } } }), 7);
  assert.equal(resolvePullRequestNumber({ payload: { issue: { number: 9, pull_request: {} } } }), 9);
  assert.equal(resolvePullRequestNumber({ payload: {}, override: '12' }), 12);
  // An issue comment on an issue is not a pull request.
  assert.throws(() => resolvePullRequestNumber({ payload: { issue: { number: 9 } } }), /Could not determine/);
  assert.throws(() => resolvePullRequestNumber({ payload: {}, override: 'x' }), /positive integer/);
});

test('repository parsing', () => {
  assert.deepEqual(parseRepository('metalbear-co/mirrord'), { owner: 'metalbear-co', repo: 'mirrord' });
  assert.throws(() => parseRepository('mirrord'), /Could not parse repository/);
});

test('callJev retries a 429 and gives up on a 401', async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });

  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls < 3) return new Response('rate limited', { status: 429 });
    return new Response(JSON.stringify({ answers: { verdict: answer() } }), { status: 200 });
  };
  const result = await callJev({ apiKey: 'k', model: 'jev-latest', state: 's', questions: {}, backoffMs: 1 });
  assert.equal(calls, 3);
  assert.equal(result.answers.verdict.choice, 'approve');

  calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response('bad key', { status: 401 });
  };
  await assert.rejects(
    callJev({ apiKey: 'k', model: 'jev-latest', state: 's', questions: {}, backoffMs: 1 }),
    /Jev API returned 401/,
  );
  assert.equal(calls, 1);
});
