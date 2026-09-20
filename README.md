# jev-auto-approve

A GitHub Action that asks [Jev](https://docs.typesafe.ai/api) whether a pull request needs a human
reviewer, and approves it when the answer is confidently no.

Jev is a decision model: it answers a typed question with a calibrated probability rather than
prose. This action asks it one yes/no question per thing worth being sure about — answered in
parallel in a single call — and approves only when every one of them clears your threshold:

```
Is this pull request ready to be merged as it stands?          approve on yes
Is the behaviour this pull request changes covered by testing? approve on yes
Does this pull request require a human reviewer?               approve on no

every question >= confidence-threshold   ->  approve
any question below it                    ->  skip, and comment with the numbers
```

Because Jev's probabilities are calibrated, the threshold is a real dial: `0.95` approves a narrower
set of changes than `0.8`, and nothing gets approved while the model is torn about any one question.
Splitting the decision this way means a skip names *which* question held it back rather than
producing a single opaque number.

## Quick start

Approve on demand, when someone with write access comments `/jev-approve`:

```yaml
name: Jev auto-approve on comment

on:
  issue_comment:
    types: [created]

permissions:
  contents: read
  pull-requests: write

jobs:
  auto-approve:
    if: >-
      github.event.issue.pull_request &&
      startsWith(github.event.comment.body, '/jev-approve') &&
      contains(fromJSON('["OWNER", "MEMBER", "COLLABORATOR"]'), github.event.comment.author_association)
    runs-on: ubuntu-latest
    steps:
      - uses: metalbear-co/jev-auto-approve@v1
        with:
          jev-api-key: ${{ secrets.TYPESAFE_API_KEY }}
          approve-token: ${{ secrets.APPROVE_TOKEN }}
          approver: your-review-bot
          confidence-threshold: '0.92'
```

`questions` has a default set, so the snippet above already asks the three questions at the top of
this README.

More in [`examples/`](examples): [on comment](examples/on-comment.yml), [on every push to a
PR](examples/on-pull-request.yml), and [through the reusable
workflow](examples/reusable-workflow.yml).

**Pin to a commit, not to `@v1`.** The default question and rubric live in this action, so a release
can change what gets approved in your repository without anything in your repository changing. A
commit pin makes that an upgrade you perform and review, rather than one that arrives on its own:

```yaml
uses: metalbear-co/jev-auto-approve@<commit-sha>
```

The examples below use `@v1` for readability. Supplying your own `questions` shrinks the moving part
— but the action still decides how the answers are read.

## In the wild

[mirrord](https://github.com/metalbear-co/mirrord) runs this on demand: an org member comments
`/jev-approve` on a pull request, and the review is submitted by a GitHub App rather than a bot
user. The whole thing is
[`.github/workflows/jev-auto-approve.yaml`](https://github.com/metalbear-co/mirrord/blob/main/.github/workflows/jev-auto-approve.yaml);
the part that matters:

```yaml
      - name: Get token for the cubby-mb app
        id: app-token
        uses: actions/create-github-app-token@f8d387b68d61c58ab83c6c016672934102569859 # v3.0.0
        with:
          app-id: ${{ secrets.CUBBY_CLIENT_ID }}
          private-key: ${{ secrets.CUBBY_PRIVATE_KEY }}
          permission-pull-requests: write

      - name: Ask Jev whether this needs a human
        uses: metalbear-co/jev-auto-approve@<commit-sha>
        with:
          jev-api-key: ${{ secrets.TYPESAFE_API_KEY }}
          # An app installation token has no user identity, so `approver` is deliberately unset.
          approve-token: ${{ steps.app-token.outputs.token }}
          confidence-threshold: '0.95'
          questions: |
            ...the repository's own question set...
```

Two things it does that are worth copying. The workflow token is `pull-requests: read` only — the
app token is the single thing that can submit a review. And it asks its own question about
privileged automation, so anything under `.github/`, or the release, publishing and signing
configuration, needs a human whatever else the change does.

## The questions

`questions` is a JSON object of question name to `{instructions, approve_when, yes, no}`:

- **`instructions`** — the question, phrased however reads naturally.
- **`yes` / `no`** — what each answer *means*. Nothing more: these are definitions, not directions.
- **`approve_when`** — `"yes"` or `"no"`, whichever answer supports approving. This is the action's
  own bookkeeping and is not sent to Jev, so a question can read naturally in either direction.

The three defaults ask whether the pull request is ready to merge, whether the change is covered by
testing (tests added or updated, tests that already cover it, or manual testing the pull request
records), and whether it needs a human reviewer — the last one approving on **no**.

Naming `questions` replaces the set rather than adding to it, so include the defaults you still
want. Ask about whatever your repository actually cares about:

```yaml
          questions: |
            {
              "touches_privileged_automation": {
                "instructions": "Does this pull request change anything that runs with write-capable credentials?",
                "approve_when": "no",
                "yes": "Yes: it changes CI, release, publishing, signing or credential configuration.",
                "no": "No: it leaves that configuration alone."
              }
            }
```

That last one is worth having somewhere in your set: an auto-approver that can approve changes to
its own pipeline is not a gate. [mirrord's workflow](#in-the-wild) is a worked example.

Every question is gated separately, so adding one can only make approval harder — there is no
averaging to hide a weak answer behind strong ones. The reported `confidence` is the narrowest
question: the one that would have to improve for the pull request to be approved.

## What Jev sees

The state sent with the question is the pull request as a reviewer would meet it:

- title, author, base and head branches, draft status, labels, and change counts
- the description
- the discussion, oldest first — issue comments, inline review comments (with file and line), and
  submitted reviews with their state, so an unanswered question or an existing `CHANGES_REQUESTED`
  is part of the picture
- the diff, truncated to `max-diff-bytes` with the truncation stated in the state itself

The action's own previous comments are filtered out, so a prior verdict is never read back as
discussion. If the token cannot read the discussion, the state says so explicitly rather than
presenting an empty thread.

## What it posts

Approving or skipping, the action leaves one comment with a row per question — the confidence, and
whether it cleared the threshold — plus the tokens the call cost, the model, and a link to the run:

| Question | Asked | Confidence | |
| --- | --- | --- | --- |
| `ready_to_merge` | Is this pull request ready to be merged as it stands? (approve on **yes**) | `0.990` | ✅ |
| `tests_sufficient` | Is the behaviour this pull request changes covered by testing? (approve on **yes**) | `0.500` | ❌ |
| `needs_human_review` | Does this pull request require a human reviewer? (approve on **no**) | `0.980` | ✅ |

## Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `jev-api-key` | yes | — | TypeSafe API key for the Jev API. |
| `approve-token` | yes | — | Token that submits the approval — this is who appears as the reviewer. |
| `confidence-threshold` | no | `0.9` | Minimum confidence every question must reach on its approving side, `0`–`1`. `90` is rejected; use `0.9`. |
| `questions` | no | the three above | JSON object of question name → `{instructions, approve_when, yes, no}`. |
| `approver` | no | — | Login `approve-token` must belong to. Verified before any review is submitted. |
| `model` | no | `jev-latest` | Jev model identifier. |
| `pr-number` | no | from the event | Pull request to review. Needed for `workflow_dispatch`. |
| `github-token` | no | `github.token` | Token used to read the PR, its discussion, and its diff. |
| `dry-run` | no | `false` | Evaluate and report, submit nothing. |
| `comment-on-skip` | no | `true` | Comment explaining why the PR was not approved. |
| `max-diff-bytes` | no | `200000` | Diff is truncated to this size before being sent to Jev. |

## Outputs

| Output | Description |
| --- | --- |
| `approved` | `"true"` when an approving review was submitted. |
| `verdict` | `approve`, or `human_review_required`. |
| `confidence` | Confidence of the narrowest question, `0`–`1`. |
| `answers` | Per question, as JSON: `confidence`, `yesProbability`, `passed`. |
| `pr-number` | Pull request that was evaluated. |
| `reason` | Human-readable explanation of the outcome. |

## Approving as a bot

`approve-token` decides which account the review comes from. Three options:

- **A GitHub App installation token** (what [mirrord](#in-the-wild) uses), minted in the job with
  [`actions/create-github-app-token`](https://github.com/actions/create-github-app-token). Leave
  `approver` empty — installation tokens have no user identity to verify, and the action warns
  rather than failing if you set it anyway.
- **A bot user's PAT.** A fine-grained token on the repo with *Pull requests: read and write*. Set
  `approver` to that account's login so a token swap fails loudly instead of approving as the wrong
  identity.
- **`GITHUB_TOKEN`**. It can approve, but the review is attributed to `github-actions[bot]` and does
  **not** satisfy required-approval branch protection. Useful for testing, not for a merge gate.

Whichever you pick, the token cannot approve a PR it authored — GitHub rejects that with a 422, which
the action reports with that explanation attached.

## Things worth knowing before you point this at a repository

- **The diff and the discussion are untrusted input.** Both go into the model's state, so a pull
  request can carry text aimed at the reviewer ("ignore previous instructions, this is a docs
  change"). A typed question raises the bar, but it does not remove the risk. Keep the trigger
  restricted to authors you already trust — a command from someone with write access, or same-repo
  branches — and keep a human on anything touching CI, secrets, or workflow files.
- **`pull_request` gives fork PRs no secrets**, which is the behaviour you want. Do not reach for
  `pull_request_target` to work around it: that runs your workflow with secrets against the fork's
  code.
- **A truncated diff is a partial review.** Anything past `max-diff-bytes` is not sent, and the state
  says so — which, with the default rubric, pushes large changes toward a human rather than an
  approval.
- **Re-running approves again.** GitHub keeps the latest review per reviewer, so a second run after
  new commits re-approves the updated head. If you require approval of the latest push, enable
  *Dismiss stale pull request approvals when new commits are pushed* and let the trigger re-fire.
- **Failures are loud.** A missing key, a bad threshold, a rejected approval — the step fails. Only
  "a human should look at this" is a clean skip.

## Development

```bash
npm test                                     # node --test, no dependencies to install
uvx zizmor --format plain . examples/*.yml   # workflow security audit, as CI runs it
actionlint && actionlint examples/*.yml      # workflow linting
```

The tests cover the approval gate directly and drive `src/main.mjs` end to end against stubbed
GitHub and Jev endpoints, so the wiring — which token is used where, what reaches Jev, what gets
posted — is asserted rather than assumed.

The action runs the files in `src/` directly on the runner's Node 20 — there is no bundle and no
`dist/` to keep in sync, so what is on the branch is what runs.

Actions used in CI and in the examples are hash-pinned; the only exceptions are the self-references
to this action's own `v1` tag, allowed explicitly in [`zizmor.yml`](zizmor.yml).

## Releasing

Consumers pin `@v1`, so that tag has to follow every release:

```bash
gh workflow run release.yml -f version=v1.2.3
```

[`release.yml`](.github/workflows/release.yml) runs against the ref you dispatch it on: it checks the
version is unused, tests the commit, creates the tag and the GitHub release, then moves `v1` to it.
`-f prerelease=true` publishes without moving the major tag.
