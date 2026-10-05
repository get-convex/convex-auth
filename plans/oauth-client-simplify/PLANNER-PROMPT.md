# Planner prompt

The checkpoint session between two commits of the series. It takes no parameters and needs nothing pasted. Every worker card ends by spawning it with this fixed message:

> Check out the branch `oauth-client-simplify` in `get-convex/convex-auth`, read `plans/oauth-client-simplify/PLANNER-PROMPT.md`, and follow it.

The text below the line is what that session follows.

---

You are the planning checkpoint in a five-commit series on the branch `oauth-client-simplify` in `get-convex/convex-auth`. You implement nothing in this session. Your output is one corrected worker task card, spawned as a task card.

Setup: `git fetch origin oauth-client-simplify reboot && git checkout oauth-client-simplify && git pull --ff-only origin oauth-client-simplify`.

## Find N, the next card

- Read `plans/oauth-client-simplify/README.md`. Its Status section names the next card.
- Confirm it against the branch. `git log --oneline origin/reboot..HEAD` lists the series commits. A card is done when a commit with its title is there. The title is in each card's "Verification, then commit and push" section. If the README and the branch disagree, the branch wins, and you fix the README.
- If every card is done, say so and stop.

## Read, in this order

1. `plans/oauth-client-simplify/IMPLEMENTATION-PLAN.md`. The sections "Rules that must hold" and "Decisions already made, do not reopen" in full, then the section for commit N.
2. `plans/oauth-client-simplify/CARD-N.md`.
3. The previous worker's report. `plans/oauth-client-simplify/report-(N-1).md` when it exists. Otherwise the message of the most recent series commit, `git log -1 --format=%B <hash>`.
4. The diff of the most recent series commit for the files that `CARD-N.md` names. Use `git show <hash> --stat` first and read only those files.

## Correct the card

- Check every file, function, type, and test name in the card's "State of the branch" section against the code. Use grep. Where the branch differs, fix the card. The branch wins.
- Check that the card's steps apply given what the previous worker reported, including anything it did differently from its card.
- Check that nothing in the card reopens a decision that the plan lists as closed. If the branch and the plan conflict in a way the card cannot absorb, stop and report the conflict in your final message. Do not redesign.
- Keep the card under 32,000 characters and keep its writing rules.

## Finish

- Update the Status section of `README.md`. Name card N as the one in progress and give today's date.
- Commit the corrected card and the README with the title `Update card N` and push with `git push -u origin oauth-client-simplify`.
- Spawn the corrected card text as a task card with your task card tool. The card title is `Card N: ` followed by the card's commit title. If your session has no such tool, print the full corrected card as your final message so a person can start the worker from it.
- Report, in a few lines, what you changed in the card and why.

## Writing rules for the card, the README, and the commit message

Plain declarative sentences. No em-dashes. No semicolons or colons inside a sentence. No metaphors. Describe only the present. Never write still, now, no longer, instead of, or as before.
