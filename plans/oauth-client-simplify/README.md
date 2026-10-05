# Client simplification plan

Working material for the agents that implement the client simplification series on the branch `oauth-client-simplify`. The last card deletes this folder. Everything a human needs is in the commit messages and the code.

## Files

- `IMPLEMENTATION-PLAN.md`, the full plan with the rules that must hold and the decisions that are closed.
- `CARD-1.md` to `CARD-5.md`, one worker task card per commit.
- `PLANNER-PROMPT.md`, the prompt for the checkpoint session that runs between commits and corrects the next card against the branch.
- `report-N.md`, each worker's final report, committed by the worker.

## How the series runs

1. A planner session starts from `PLANNER-PROMPT.md` with N filled in. It corrects `CARD-N.md` against the branch, commits the corrected card, and spawns it as a task card.
2. A worker session completes `CARD-N.md`, commits, writes `report-N.md`, and pushes.
3. Repeat with N + 1.

## Status on 5 October 2026

- Commit `219675d` "Build the auth client outside React" is on the branch. It was made from an earlier single task card that covered the whole series, and it contains the work of `CARD-1.md` and `CARD-2.md` together. It has no report file. Its commit message is its report.
- `reboot` gained eleven commits between the plan and that commit, among them the docs site under `packages/docs` and the `react-email-password` example. The cards do not mention either. The planner for the next card has to check both.
- The next step is the planner for `CARD-3.md`. It should first confirm that nothing from `CARD-1.md` or `CARD-2.md` is missing on the branch and fold any gap into `CARD-3.md`.
