---
name: pr-review
description: Use this skill when the user asks to do a code review for a pull request, review a PR, or review a GitHub PR URL. This includes phrases like "do a code review for this PR", "review PR #N", "review https://github.com/.../pull/N", or "check this PR".
---

When the user asks to review a pull request, follow these steps to review the diff and post inline comments directly to GitHub.

## 1. Resolve the PR number

Extract the PR number from the user's message (strip any URL prefix). If unclear, ask.

## 2. Gather metadata

```bash
gh pr view <number> --json headRefOid,baseRepository,title
```

You need:
- `headRefOid` — full 40-char SHA (required by the review API)
- `baseRepository.nameWithOwner` — e.g. `appspace/helix`

## 3. Fetch the diff

```bash
gh pr diff <number>
```

## 4. Calculate new-file line numbers

Each hunk starts with `@@ -old_start,old_count +new_start,new_count @@`. The `new_start` value is the line number in the new file for the first line of that hunk. Count down from it — both unchanged context lines and `+` added lines increment the counter. Removed `-` lines do not. Use this to find the exact new-file line for any `+` line you want to annotate.

## 5. Review the diff

Flag only real issues a senior engineer would call out:

- **Bugs**: logic errors, race conditions, incorrect null/edge-case handling
- **Security**: injection, unsafe deserialization, secrets in code, auth bypass
- **Correctness**: does the code do what it claims?

Do **not** flag:
- Style, formatting, naming — a linter handles those
- Pre-existing issues not introduced by this PR
- Speculative problems with no evidence they occur in practice
- Missing test coverage unless obviously critical

For each issue record: `path`, `line` (new-file line number), and a `body` with a clear explanation and concrete fix.

## 6. Write the review JSON to a temp file

**Always use the Write tool** — never a heredoc or inline shell string. Backticks inside Markdown code fences in heredocs are shell-expanded and will cause errors.

Write to `/tmp/review-<number>.json`:

```json
{
  "commit_id": "<full headRefOid>",
  "body": "Brief overall summary (1-2 sentences).",
  "event": "COMMENT",
  "comments": [
    {
      "path": "src/foo.ts",
      "line": 42,
      "side": "RIGHT",
      "body": "**Issue title**\n\nExplanation and suggested fix."
    }
  ]
}
```

- `side` is always `"RIGHT"` (the new version of the file)
- `line` must target a `+` line or unchanged context line — never a `-` line
- Put all comments in one call to keep them in a single review thread
- If there are no real issues, post with an empty `comments` array and a clean summary in `body`

## 7. Post the review

```bash
gh api repos/<owner>/<repo>/pulls/<number>/reviews \
  --method POST \
  --input /tmp/review-<number>.json
```

Report the returned `html_url` to the user.
