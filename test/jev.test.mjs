import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildQuestions,
  buildState,
  callJev,
  DEFAULT_CRITERIA,
  DEFAULT_INSTRUCTIONS,
  decide,
  formatDiscussion,
  parseCriteria,
  parseThreshold,
  QUESTION_KEY,
  truncateDiff,
} from '../src/jev.mjs';
import { parseRepository, resolvePullRequestNumber } from '../src/github.mjs';

// A noul answer is the probability that the answer to the question is yes - that a human IS needed.
const answer = (needsHuman) => ({ type: 'noul', noul: needsHuman });

test('approves when Jev is confident no human reviewer is required', () => {
  const decision = decide(answer(0.02), 0.9);
  assert.equal(decision.approved, true);
  assert.equal(decision.verdict, 'approve');
  assert.equal(decision.needsHumanProbability, 0.02);
  assert.ok(Math.abs(decision.confidence - 0.98) < 1e-9);
});

test('confidence exactly at the threshold approves', () => {
  assert.equal(decide(answer(0.1), 0.9).approved, true);
});

test('does not approve when a human reviewer is probably required', () => {
  const decision = decide(answer(0.11), 0.9);
  assert.equal(decision.approved, false);
  assert.equal(decision.verdict, 'human_review_required');
  assert.match(decision.reason, /below the threshold/);
});

test('an undecided answer does not approve', () => {
  assert.equal(decide(answer(0.5), 0.9).approved, false);
});

test('rejects a malformed answer rather than guessing', () => {
  assert.throws(() => decide({ choice: 'approve' }, 0.9), /Unexpected Jev answer shape/);
  assert.throws(() => decide({ noul: 1.4 }, 0.9), /Unexpected Jev answer shape/);
  assert.throws(() => decide(undefined, 0.9), /Unexpected Jev answer shape/);
});

test('threshold parsing rejects percentages and nonsense', () => {
  assert.equal(parseThreshold('0.85'), 0.85);
  assert.throws(() => parseThreshold('90'), /use 0\.9, not 90/);
  assert.throws(() => parseThreshold('high'), /between 0 and 1/);
});

test('instructions and criteria are sent as a single noul question', () => {
  const questions = buildQuestions({
    instructions: 'Does this pull request need a human?',
    criteria: 'No human is needed for documentation-only changes.',
  });
  const question = questions[QUESTION_KEY];
  assert.equal(question.type, 'noul');
  assert.equal(question.instructions, 'Does this pull request need a human?');
  assert.equal(question.criteria.false, 'No human is needed for documentation-only changes.');
  // The yes side keeps the built-in wording, including the "answer yes when unsure" instruction.
  assert.equal(question.criteria.true, DEFAULT_CRITERIA.true);
});

test('empty inputs fall back to the built-in question and rubric', () => {
  const question = buildQuestions({ instructions: '  ', criteria: '' })[QUESTION_KEY];
  assert.equal(question.instructions, DEFAULT_INSTRUCTIONS);
  assert.deepEqual(question.criteria, DEFAULT_CRITERIA);
  assert.match(question.instructions, /require a human reviewer/);
  // An existing review that was addressed counts towards no further human being needed.
  assert.match(question.instructions, /already left/);
  assert.match(question.criteria.false, /Tests were added or updated|manual testing/);
  assert.match(question.criteria.false, /A human reviewed this pull request/);
  // An external change weighs on the answer rather than settling it.
  assert.match(question.criteria.false, /weighs towards needing a human/);
  assert.match(question.criteria.false, /does not on its own require one/);
});

test('criteria can be given as JSON to phrase both sides', () => {
  assert.deepEqual(parseCriteria('{"true": "needs a human", "false": "does not"}'), {
    true: 'needs a human',
    false: 'does not',
  });
  assert.throws(() => parseCriteria('{"true": "only one side"}'), /non-empty "true" and "false"/);
  assert.throws(() => parseCriteria('{nope}'), /could not be parsed/);
});

test('state carries the title, description, discussion, and diff', () => {
  const state = buildState({
    pullRequest: {
      number: 5,
      title: 'Add a retry',
      body: 'Tested by hand against staging.',
      base: { ref: 'main', repo: { full_name: 'acme/widgets' } },
      head: { ref: 'retry' },
      user: { login: 'someone' },
    },
    diff: 'diff --git a/x b/x',
    truncated: false,
    discussion: {
      issueComments: [
        { created_at: '2026-01-02', user: { login: 'alice' }, body: 'does this change the API?' },
        { created_at: '2026-01-03', user: { login: 'cubby-mb' }, body: '<!-- jev-auto-approve --> earlier verdict' },
      ],
      reviewComments: [{ created_at: '2026-01-04', user: { login: 'bob' }, path: 'src/x.rs', line: 12, body: 'nit' }],
      reviews: [{ submitted_at: '2026-01-05', user: { login: 'bob' }, state: 'CHANGES_REQUESTED', body: 'add a test' }],
    },
  });
  assert.match(state, /Add a retry/);
  assert.match(state, /Tested by hand against staging\./);
  assert.match(state, /does this change the API\?/);
  assert.match(state, /review comment by @bob on src\/x\.rs:12/);
  assert.match(state, /review by @bob - CHANGES_REQUESTED/);
  assert.match(state, /diff --git/);
  // The action's own earlier verdict is not fed back in as discussion.
  assert.ok(!state.includes('earlier verdict'));
});

test('missing discussion is reported as missing, not as an empty thread', () => {
  const lines = formatDiscussion({ unavailable: true });
  assert.match(lines.join('\n'), /could not be retrieved/);
  assert.match(formatDiscussion({}).join('\n'), /no comments or reviews/);
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
    return new Response(JSON.stringify({ answers: { [QUESTION_KEY]: answer(0.02) } }), { status: 200 });
  };
  const result = await callJev({ apiKey: 'k', model: 'jev-latest', state: 's', questions: {}, backoffMs: 1 });
  assert.equal(calls, 3);
  assert.equal(result.answers[QUESTION_KEY].noul, 0.02);

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
