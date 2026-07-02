# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

Report vulnerabilities privately through GitHub's built-in tool:
**Security → Report a vulnerability**
(https://github.com/mwkorver/deckgl-s3-cog-s1m/security/advisories/new).
This keeps the report confidential until a fix is available.

Please include:

- a description of the issue and its impact,
- steps to reproduce (or a proof of concept),
- affected component (viewer, read API, ingest, IaC) and version/commit.

You can expect an initial acknowledgement within a few business days.

## Scope notes

This project reads public and requester-pays data from Amazon S3 and signs
per-object URLs. Findings that are especially in scope:

- the URL signer exposing private or role-readable buckets
  (see `app/api/test_endpoints.py::test_sign_rejects_private_and_unknown_buckets`),
- credential handling in the read/ingest APIs,
- the IAM roles and policies under `app/lambda/iam/`.

Out of scope: costs incurred by running the app against requester-pays buckets
(this is expected behavior — see the "Costs to expect" section in
`app/README.md`).
