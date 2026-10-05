# Planner prompt

Paste the text below the line as the first message of a new session. Replace N with the card number. If no `report-(N-1).md` exists on the branch, paste the previous worker's final message at the end.

---

You are the planning checkpoint before commit N of a five-commit series in `get-convex/convex-auth`, on the branch `oauth-client-simplify`. You implement nothing in this session. Your output is a corrected task card.

Setup: `git fetch origin oauth-client-simplify && git checkout oauth-client-simplify && git pull --ff-only origin oauth-client-simplify`.

Read, in this order:

1. `plans/oauth-client-simplify/README.md`.
2. `plans/oauth-client-simplify/IMPLEMENTATION-PLAN.md`. Read the sections "Rules that must hold" and "Decisions already made, do not reopen" in full, then the section for commit N.
3. `plans/oauth-client-simplify/CARD-N.md`.
4. The previous worker's report, `plans/oauth-client-simplify/report-(N-1).md` if it exists, otherwise the report pasted at the end of this message.
5. The last commit on the branch, `git show --stat HEAD`, and the diff of the files that `CARD-N.md` names.

Then:

- Check every file, function, type, and test name in the card's "State of the branch" section against the code. Use grep. Where the branch differs, fix the card. The branch wins.
- Check that the card's steps apply given what the previous worker reported, including anything it did differently from its card.
- Check that nothing in the card reopens a decision that the plan lists as closed. If the branch and the plan conflict in a way the card cannot absorb, stop and report the conflict. Do not redesign.
- Keep the card under 32,000 characters and keep its writing rules.
- Commit the corrected card with the title `Update card N` and push with `git push -u origin oauth-client-simplify`.
- Spawn the corrected card text as a task card if your session has a tool for that. Otherwise print the full corrected card as your final message so a person can start the worker from it.
- Report, in a few lines, what you changed in the card and why.

Writing rules for the card and the commit message. Plain declarative sentences. No em-dashes. No semicolons or colons inside a sentence. No metaphors. Describe only the present, never write still, now, no longer, instead of, or as before.

Previous worker's report, if no report file exists:
