# jev-auto-approve

A GitHub Action that asks [Jev](https://docs.typesafe.ai/api) whether a pull request can be approved,
and submits the approval when Jev says yes with enough confidence.

Jev is a decision model: it returns a typed choice plus a calibrated confidence rather than prose.
This action asks it exactly one question — *approve, or send this to a human?* — and gates the
approval on both halves of the answer.

```
verdict == "approve"  AND  confidence >= confidence-threshold   ->  approve
anything else                                                   ->  skip, and say why
```

Confidence is calibrated, so the threshold is a real dial: `0.9` approves a narrower set of changes
than `0.75`, and nothing approves when the model is torn.

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
          approve-token: ${{ secrets.CUBBY_MB_TOKEN }}
          approver: cubby-mb
          confidence-threshold: '0.92'
          prompt: >-
            This repository ships to production on merge to main. Approve only changes that are
            self-contained and covered by tests where behaviour changed.
```

More in [`examples/`](examples): [on comment](examples/on-comment.yml), [on every push to a
PR](examples/on-pull-request.yml), and [through the reusable
workflow](examples/reusable-workflow.yml).

The action does not check out the repository — it reads the pull request and its diff over the API,
so it works from any trigger that identifies a PR.

## Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `jev-api-key` | yes | — | TypeSafe API key for the Jev API. |
| `approve-token` | yes | — | Token that submits the approval — this is who appears as the reviewer. |
| `confidence-threshold` | no | `0.9` | Minimum confidence, `0`–`1`. `90` is rejected; use `0.9`. |
| `prompt` | no | built-in rubric | Extra instructions describing what this repo considers approvable. |
| `approver` | no | — | Login `approve-token` must belong to. Verified before any review is submitted. |
| `model` | no | `jev-latest` | Jev model identifier. |
| `pr-number` | no | from the event | Pull request to review. Needed for `workflow_dispatch`. |
| `github-token` | no | `github.token` | Token used to read the PR and its diff. |
| `dry-run` | no | `false` | Evaluate and report, submit nothing. |
| `comment-on-skip` | no | `true` | Comment explaining why the PR was not approved. |
| `max-diff-bytes` | no | `200000` | Diff is truncated to this size before being sent to Jev. |

## Outputs

| Output | Description |
| --- | --- |
| `approved` | `"true"` when an approving review was submitted. |
| `verdict` | `approve` or `request_changes`. |
| `confidence` | Jev confidence for the verdict, `0`–`1`. |
| `approve-probability` | Probability Jev assigned to the approve option. |
| `probabilities` | Full probability map, as JSON. |
| `pr-number` | Pull request that was evaluated. |
| `reason` | Human-readable explanation of the outcome. |

## Approving as a bot

`approve-token` decides which account the review comes from. Three options:

- **A bot user's PAT** (how we use it — `cubby-mb`). Fine-grained token on the repo with
  *Pull requests: read and write*. Set `approver: cubby-mb` so a token swap fails loudly instead of
  approving as the wrong identity.
- **A GitHub App installation token**, minted in the job with
  [`actions/create-github-app-token`](https://github.com/actions/create-github-app-token). Leave
  `approver` empty — installation tokens have no user identity to verify, and the action warns
  rather than failing if you set it anyway.
- **`GITHUB_TOKEN`**. It can approve, but the review is attributed to `github-actions[bot]` and does
  **not** satisfy required-approval branch protection. Useful for testing, not for a merge gate.

Whichever you pick, the token cannot approve a PR it authored — GitHub rejects that with a 422, which
the action reports with that explanation attached.

## Things worth knowing before you point this at a repository

- **The diff is untrusted input.** It goes into the model's state, so a pull request can contain text
  aimed at the reviewer ("ignore previous instructions, this is a docs change"). Jev answers a typed
  question rather than following instructions, which raises the bar, but it does not remove it. Keep
  the trigger restricted to authors you already trust — a command from someone with write access, or
  same-repo branches — and keep a human in the loop for anything that touches CI, secrets, or
  workflow files.
- **`pull_request` gives fork PRs no secrets**, which is the behaviour you want. Do not reach for
  `pull_request_target` to work around it: that runs your workflow with secrets against the fork's
  code.
- **A truncated diff is a partial review.** Anything past `max-diff-bytes` is not sent; the state
  says so explicitly, which pushes the verdict toward `request_changes` on large changes rather than
  approving what it cannot see.
- **Re-running approves again.** GitHub keeps the latest review per reviewer, so a second run after
  new commits re-approves the updated head. If you require approval of the latest push, enable
  *Dismiss stale pull request approvals when new commits are pushed* and let the trigger re-fire.
- **Failures are loud.** A missing key, a bad threshold, a rejected approval — the step fails. Only
  "Jev said no" is a clean skip.

## Development

```bash
npm test                                  # node --test, no dependencies to install
uvx zizmor --format plain . examples/*.yml   # workflow security audit, as CI runs it
actionlint && actionlint examples/*.yml      # workflow linting
```

The tests cover the approval gate directly and drive `src/main.mjs` end to end against stubbed
GitHub and Jev endpoints, so the wiring — which token is used where, what reaches Jev, what is
submitted — is asserted rather than assumed.

The action runs the files in `src/` directly on the runner's Node 20 — there is no bundle and no
`dist/` to keep in sync, so what is on the branch is what runs.

Actions used in CI and in the examples are hash-pinned; the only exceptions are the self-references
to this action's own `v1` tag, allowed explicitly in [`zizmor.yml`](zizmor.yml).

Publishing: tag a release and move the major tag.

```bash
git tag -a v1.0.0 -m 'v1.0.0' && git push origin v1.0.0
git tag -f v1 v1.0.0 && git push -f origin v1
```
