# Client simplification plan

Working material for the agents that implement the client simplification series on the branch `erquhart/oauth-client-simplify`. The last card deletes this folder. Everything a human needs is in the commit messages and the code.

## Files

- `IMPLEMENTATION-PLAN.md`, the full plan with the rules that must hold and the decisions that are closed.
- `CARD-1.md` to `CARD-5.md`, one worker task card per commit.
- `PLANNER-PROMPT.md`, the prompt for the checkpoint session that runs between commits and corrects the next card against the branch.
- `report-N.md`, each worker's final report, committed by the worker.

## How the series runs

1. A planner session starts from the fixed message in `PLANNER-PROMPT.md`. It finds the next card from this README and the branch, corrects it against the branch, commits the corrected card, and spawns it as a task card.
2. A worker session completes the card, commits, writes `report-N.md`, pushes, and spawns the next planner session as a task card.
3. Nobody pastes or edits anything by hand. The branch carries every input.

## Status on 5 October 2026

- Commit `219675d` "Build the auth client outside React" is on the branch. It was made from an earlier single task card that covered the whole series, and it contains the work of `CARD-1.md` and `CARD-2.md` together. The commit has no report file. Its commit message is its report.
- Commit `a27f23a` "Replace the ambient sign-in registry with OAuth flow functions" is on the branch, with `report-3.md`. The Next.js proxy sign-in API applies `retryOnNetworkError`.
- The docs site under `packages/docs` names none of the email secret keys, the passkey flow context, or the provider hooks that card 4 changes, so card 4 does not touch it. The `react-email-password` example calls the email hooks with signatures that card 4 keeps, so card 4 does not touch it either.
- Commit `1f5e153` "Read the auth client from useAuthClient in provider hooks" is on the branch, with `report-4.md`.
- The installed `convex` package is 1.46.0. Its `WebSocketManager` constructs the WebSocket in its own constructor and `expectAuth` only marks it paused, so card 5 observes sent messages and not socket construction.
- The card in progress is `CARD-5.md`, corrected against the branch by the planner on 5 October 2026.
