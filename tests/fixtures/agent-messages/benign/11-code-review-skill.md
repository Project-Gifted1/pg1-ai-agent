# Code review skill

Reviews a pull request diff and returns comments.

## Input

- `diff`: a unified diff, up to 200 KB.
- `language`: optional, for example `python` or `typescript`.

## Output

A list of comments with `file`, `line`, `severity` (`info`, `warning`, `error`) and `message`.

## Guidance

- Point out bugs first, then style.
- Never include secrets you find in the diff in a comment; say that a secret was found and where.
- Keep each comment under 300 characters.

Endpoint: https://review.codelens.dev/api/review — 0.02 USDC per review via x402.
