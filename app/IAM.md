# IAM scoping plan — one deploy policy, provisioning separated out

> **IMPLEMENTED (2026-06) — see `app/lambda/iam/README.md` for the live runbook.**
> The chosen design is a pragmatic variant of the proposal below:
> - **Foundation stack** `cog-stac-foundation` (`app/lambda/foundation.yaml`) now
>   owns the **viewer bucket** (admin, one-time). It absorbed
>   `bootstrap-app-bucket.sh` (removed). _(The former CloudFront CORS/cache tile
>   proxy was later removed entirely — the viewer reads the public source COG
>   buckets directly via their own CORS — so there is no longer a distribution,
>   tile base, or cache invalidation anywhere in this stack.)_
> - **Deploy identity** is an **SSO-assumed role `cog-stac-deploy`** (no static
>   keys; `app/.env` now uses `AWS_PROFILE`). Its policy
>   (`iam/cog-stac-deploy.json`) dropped all bucket-admin actions; it needs **no
>   CloudFront permissions** (the proxy is gone).
> - **Exec roles stay SAM-created** (kept `iam:CreateRole`/`PassRole` +
>   `CAPABILITY_IAM`) — only the *stateful* bucket+CDN moved to foundation, not
>   the roles. (The fuller "roles in foundation / drop CAPABILITY_IAM" idea below
>   remains deferred.)
> - **Application deployment is split** into `cog-stac-ingest` (container) and
>   `cog-stac-read` (zip). The read deploy consumes the ingest stack's
>   `IngestUrl` output as a parameter; no SSM parameter is used.
>
> The original design note follows, for context.

## Goal

Use one scoped, git-managed policy on the SSO-assumed `cog-stac-deploy` role.
Keep that policy small and safe by provisioning privileged, stateful resources
independently through the admin-owned foundation stack.

## Principle: separate *provisioning* from *deployment*

Two layers, by blast radius and change frequency:

| layer | who | what it owns | changes |
|-------|-----|--------------|---------|
| **Foundation** | admin (independent, one-time) | the bucket, the Lambda **roles**, the ECR repo, the SAM artifacts bucket | rare, privileged |
| **App** | `cog-stac-deploy` (`deploy-*.sh`) | Lambda **code/config**, function URLs, the lake data | frequent, scoped |

Creating buckets is independent of application deployment. Keeping that in the
foundation stack removes those privileged operations from the routine deploy
role:

- bucket creation → no `s3:CreateBucket` / `PutBucketPolicy` / `DeleteBucket`
- role creation → no `iam:CreateRole` / `AttachRolePolicy` / `PutRolePolicy`

…leaving only the *one* safe IAM action the deployer needs: **`iam:PassRole`**
(pass a pre-created role to Lambda). That distinction — "deploy code that *uses* a
role" vs "mint/attach roles" — is the whole point.

## Foundation resources (created independently, admin)

1. **Bucket** — `cog-stac-viewer-<acct>-<region>` (viewer + lake/ + detections/).
   **Already done**: out-of-band `bootstrap-app-bucket.sh`, `Retain` in the
   template, referenced by ARN. Keep.
2. **Lambda execution roles** — pre-create both, with their runtime policies (see
   next section). The app stack will reference them by ARN instead of creating
   them. *(New: today SAM auto-creates these via `CAPABILITY_IAM`.)*
3. **ECR repository** — for the ingest container image. Pre-create so the deployer
   needs only push, not `ecr:CreateRepository`. Pin via samconfig
   `image_repositories`.
4. **SAM artifacts bucket** — the `sam deploy` packaging bucket. Pre-create and pin
   via samconfig `s3_bucket=` so the deployer needs no `s3:CreateBucket`.

Cleanest form: a small **foundation CloudFormation stack** (admin-deployed) that
creates 2–4 above and exports the role ARNs + repo URI; the app SAM stack imports
them (SSM or `ImportValue`). (A bootstrap script is the lighter alternative.)

## The two Lambda execution roles (runtime permissions)

Derive the exact statements from the current SAM template's `Policies:` blocks when
implementing; at a high level:

- **read role** (`cog-stac-read`): `s3:ListBucket` on the viewer bucket;
  `s3:GetObject` on `viewer-bucket/lake/*` + `/detections/*`; `GetObject`+
  `ListBucket` on `cog-stac-catalog` (manifest index) and `naip-analytic` (NAIP
  source, requester-pays); CloudWatch Logs write.
- **ingest role** (`cog-stac-ingest`): read `naip-analytic` + `cog-stac-catalog`;
  **read/write** the viewer bucket `lake/*`; Logs write.

**Important:** the public collections (KyFromAbove, New Jersey) are read with an
**unsigned/anonymous** S3 client, which **bypasses the role's identity policy** — so
neither role needs (or should get) permissions for `kyfromabove` / `njogis-imagery`.
(This is exactly why a *signed* request to those cross-account public buckets got
`AccessDenied` and the unsigned client fixed it.)

## The `cog-stac-deploy` policy

Scoped to `cog-stac-*` resources + `aws:RequestedRegion = us-west-2`:

- `cloudformation:*` on the app stack(s) + changesets.
- `lambda:*` on the app functions (+ Function URL config).
- `ecr:GetAuthorizationToken` (account) + push actions on the **existing** repo.
- `s3` RW on the **existing** SAM artifacts bucket + viewer bucket (objects);
  `GetObject`/`ListBucket` on `cog-stac-catalog` + `naip-analytic`.
- `iam:PassRole` on the **two pre-created role ARNs only**, with
  `Condition: { StringEquals: { iam:PassedToService: lambda.amazonaws.com } }`.
- CloudWatch Logs read (`FilterLogEvents`/`GetLogEvents`/`DescribeLogGroups`) for
  `aws logs tail`.
- `sts:GetCallerIdentity`.

**Explicitly NOT in it** (stay admin/foundation): `iam:CreateRole`/`*RolePolicy`,
`s3:CreateBucket`/`PutBucketPolicy`/`DeleteBucket`, `ecr:CreateRepository`,
`cloudfront:*`, `servicequotas:*`, `ssm:PutParameter`, `budgets:*`.

This set is small enough to fit one customer-managed policy (well under the 6,144-
char limit), which the original "one policy" goal required.

## Required app-stack changes (when implemented)

- Each `AWS::Serverless::Function`: set `Role: <foundation-role-arn>` (param/SSM).
  This **drops `CAPABILITY_IAM`** from the deploy.
- Consequence: SAM no longer auto-generates each function's runtime policy from
  `Policies:`/events — those permissions **move into the foundation role** (admin-
  owned). New runtime permission (e.g., a new source bucket) → admin edits the
  role, not a template change. Document each role's grants so the handoff is clear.
- `samconfig.toml`: pin `s3_bucket` (artifacts) and `image_repositories` (ingest)
  to the pre-created ones.

## Trade-offs / caveats

- **Runtime perms live in the role, not the template** — a coordination point
  (admin owns identity *and* its permissions). Acceptable; document it.
- **`iam:PassRole` is still required** — it's the safe IAM action, scoped to the
  two role ARNs + the lambda service condition.
- **Short-lived sessions only:** `cog-stac-deploy` is assumed through AWS SSO;
  the repository does not use IAM-user access keys.
- **More bootstrap up front** (roles + ECR + artifacts bucket) for ongoing safety +
  a stable, rarely-edited deploy policy. Matches the bucket pattern already chosen.

## Status

- ✅ **Foundation stack** (`foundation.yaml`, `cog-stac-foundation`) owns the
  viewer bucket (Retain'd bucket; absorbed `bootstrap-app-bucket.sh`). _CloudFront
  CORS/cache tile proxy since removed — the viewer reads public source COGs
  directly._
- ✅ **Deploy identity = SSO-assumed role `cog-stac-deploy`** (no static `.env`
  keys; `cog-stac-deploy-trust.json` + `AWS_PROFILE`).
- ✅ Scoped deploy policy: bucket-admin actions removed; no CloudFront
  permissions (proxy removed) (`iam/cog-stac-deploy.json`).
- ✅ Independent read and ingest stacks; read updates no longer rebuild the
  ingest container.
- ⬜ Deferred (this pass kept exec roles SAM-created): roles/ECR/artifacts bucket
  moved to foundation, `Role:` references, dropping `CAPABILITY_IAM`, `samconfig` pins.

## Verify checklist (for the implementation pass)

1. Pre-create roles/ECR/artifacts bucket (foundation); record ARNs/URIs.
2. Attach the scoped policy to `cog-stac-deploy`.
3. Run the split ingest and read deployment scripts.
4. `deploy-viewer.sh` — succeeds (S3 RW only).
5. A real ingest via run-sync — succeeds (role reads sources + writes lake;
   public buckets via unsigned).
6. `aws logs tail` — works.
7. Only then delete the superseded policies.
