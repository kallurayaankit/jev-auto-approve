import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildQuestions,
  buildState,
  callJev,
  DEFAULT_QUESTIONS,
  decide,
  formatDiscussion,
  parseQuestions,
  parseThreshold,
  truncateDiff,
} from '../src/jev.mjs';
import { parseRepository, resolvePullRequestNumber } from '../src/github.mjs';

const SPECS = {
  tests_sufficient: { instructions: 'Tested?', approve_when: 'yes', yes: 'Yes: ...', no: 'No: ...' },
  needs_human_review: { instructions: 'Human?', approve_when: 'no', yes: 'Yes: ...', no: 'No: ...' },
};

// A noul answer is the probability that the question is answered yes.
const noul = (value) => ({ type: 'noul', noul: value });
const gate = (tested, needsHuman, threshold = 0.9) =>
  decide({
    answers: { tests_sufficient: noul(tested), needs_human_review: noul(needsHuman) },
    specs: SPECS,
    threshold,
  });

test('approves when every question clears the threshold on its approving side', () => {
  const decision = gate(0.97, 0.02);
  assert.equal(decision.approved, true);
  assert.equal(decision.verdict, 'approve');
  // The reported confidence is the narrowest question, not an average.
  assert.ok(Math.abs(decision.confidence - 0.97) < 1e-9);
  assert.deepEqual(decision.questions.map((q) => q.passed), [true, true]);
});

test('approve_when: no inverts the probability that gates the question', () => {
  const [, human] = gate(0.97, 0.02).questions;
  assert.equal(human.yesProbability, 0.02);
  assert.ok(Math.abs(human.confidence - 0.98) < 1e-9);
});

test('one failing question is enough to withhold approval', () => {
  const decision = gate(0.4, 0.01);
  assert.equal(decision.approved, false);
  assert.equal(decision.verdict, 'human_review_required');
  assert.match(decision.reason, /"tests_sufficient" at 0\.400/);
  // The passing question is not what held it back, and is not named.
  assert.ok(!decision.reason.includes('needs_human_review'));
});

test('confidence exactly at the threshold passes', () => {
  assert.equal(gate(0.9, 0.1).approved, true);
});

test('every failing question is named', () => {
  const decision = gate(0.4, 0.8);
  assert.match(decision.reason, /tests_sufficient/);
  assert.match(decision.reason, /needs_human_review/);
});

test('a missing or malformed answer for any question is an error, not an approval', () => {
  assert.throws(
    () => decide({ answers: { tests_sufficient: noul(0.99) }, specs: SPECS, threshold: 0.9 }),
    /Unexpected Jev answer for "needs_human_review"/,
  );
  assert.throws(
    () => decide({ answers: { tests_sufficient: noul(1.4), needs_human_review: noul(0) }, specs: SPECS, threshold: 0.9 }),
    /Unexpected Jev answer for "tests_sufficient"/,
  );
});

test('threshold parsing rejects percentages and nonsense', () => {
  assert.equal(parseThreshold('0.85'), 0.85);
  assert.throws(() => parseThreshold('90'), /use 0\.9, not 90/);
  assert.throws(() => parseThreshold('high'), /between 0 and 1/);
});

test('each question is sent as its own noul with both sides defined', () => {
  const built = buildQuestions(DEFAULT_QUESTIONS);
  assert.deepEqual(Object.keys(built), Object.keys(DEFAULT_QUESTIONS));
  for (const [key, question] of Object.entries(built)) {
    assert.equal(question.type, 'noul', key);
    assert.equal(question.instructions, DEFAULT_QUESTIONS[key].instructions);
    assert.equal(question.criteria.true, DEFAULT_QUESTIONS[key].yes);
    assert.equal(question.criteria.false, DEFAULT_QUESTIONS[key].no);
    // approve_when is the action's own bookkeeping and is not part of the API payload.
    assert.ok(!('approve_when' in question));
  }
});

test('the defaults ask about readiness, testing, and whether a human is needed', () => {
  assert.deepEqual(Object.keys(DEFAULT_QUESTIONS), ['ready_to_merge', 'tests_sufficient', 'needs_human_review']);
  assert.equal(DEFAULT_QUESTIONS.needs_human_review.approve_when, 'no');
  assert.equal(DEFAULT_QUESTIONS.tests_sufficient.approve_when, 'yes');
  assert.match(DEFAULT_QUESTIONS.tests_sufficient.yes, /manual testing/);
});

test('questions parse from JSON and are validated', () => {
  const one = parseQuestions('{"q": {"instructions": "Ready?", "approve_when": "yes", "yes": "Y", "no": "N"}}');
  assert.deepEqual(one, { q: { instructions: 'Ready?', approve_when: 'yes', yes: 'Y', no: 'N' } });
  assert.deepEqual(parseQuestions('  '), DEFAULT_QUESTIONS);

  const bad = (json, pattern) => assert.throws(() => parseQuestions(json), pattern);
  bad('{"q": {"instructions": "Ready?", "yes": "Y", "no": "N"}}', /"approve_when" set to "yes" or "no"/);
  bad('{"q": {"instructions": "Ready?", "approve_when": "maybe", "yes": "Y", "no": "N"}}', /"yes" or "no"/);
  bad('{"q": {"instructions": "Ready?", "approve_when": "yes", "yes": "Y"}}', /needs a non-empty "no"/);
  bad('{"q": {"approve_when": "yes", "yes": "Y", "no": "N"}}', /needs a non-empty "instructions"/);
  bad('{}', /at least one question/);
  bad('[]', /keyed by question name/);
  bad('nope', /could not be parsed/);
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
    return new Response(JSON.stringify({ answers: { needs_human_review: noul(0.02) } }), { status: 200 });
  };
  const result = await callJev({ apiKey: 'k', model: 'jev-latest', state: 's', questions: {}, backoffMs: 1 });
  assert.equal(calls, 3);
  assert.equal(result.answers.needs_human_review.noul, 0.02);

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
