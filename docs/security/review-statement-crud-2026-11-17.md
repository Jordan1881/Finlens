# Security review: Finlens statement CRUD / upload / Bedrock / S3

Date: 2026-11-17  
Scope: Statement HTTP/MCP handlers, statement libs, Bedrock analyze/ask, `on-s3-upload`, IAM/S3/CORS in `infra/lib/finlens-stack.ts`, `infra/cdk.json`, `infra/bin/finlens.ts`.

## Summary

Tenant isolation on DynamoDB `(tenantId, statementId)` is generally solid: authenticated Workspace resolution, no cross-tenant list cursor, no cross-tenant get/delete/compare/ask. No classic SQL/command injection or SSRF in scope. The strongest issues are **availability/cost**: unconditional `processing` transitions + fixed Step Functions execution names, unbounded presigned PUT size, and a committed shared `DEV_API_KEY` for the public-ish Dev stack.

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 2 |
| Medium | 6 |

---

## Findings (HIGH / MEDIUM)

### H1 — HIGH: Re-PUT to statement object bricks row in `processing` (ExecutionAlreadyExists)

**Files:** `apps/api/src/handlers/on-s3-upload.ts` (approx. lines 42–118), `apps/api/src/handlers/create-statement.ts` (90–98)

**Code:**

```89:118:apps/api/src/handlers/on-s3-upload.ts
    await ddb.send(
      new UpdateCommand({
        TableName: tableName,
        Key: { tenantId, statementId },
        UpdateExpression: "SET #status = :status, updatedAt = :updatedAt",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":status": "processing",
          ":updatedAt": now,
        },
      }),
    );

    try {
      await sfn.send(
        new StartExecutionCommand({
          stateMachineArn,
          name: statementId,
          input: JSON.stringify({ tenantId, statementId, bucket, key }),
        }),
      );
    } catch (error) {
      if (error instanceof ExecutionAlreadyExists) {
        console.warn("Analysis already started for", statementId);
        continue;
      }
      throw error;
    }
```

**Attack / failure chain:**

1. Authenticated caller `POST /v1/statements` → pending row + presigned `PutObject` URL (900s) for `statements/{tenantId}/{statementId}.pdf|csv`.
2. Client uploads; `on-s3-upload` sets `processing` and `StartExecution` with `name: statementId`.
3. Pipeline finishes (`ready` or `failed`). Execution name remains reserved ~90 days.
4. Same URL is reused (HTTP retry, client bug, or intentional overwrite) → new `OBJECT_CREATED`.
5. Handler **unconditionally** sets `status = processing` (no `ConditionExpression` on prior status).
6. `StartExecution` throws `ExecutionAlreadyExists` → swallowed → **row stuck in `processing`** with no running execution.
7. Ask/compare/categories return `STATEMENT_NOT_READY`; user must upload a *new* statement (new UUID) to recover. Same-tenant DoS of that statement; capability URL holder can brick it within URL lifetime.

**Existing controls:** Execution name idempotency helps *duplicate events during the first run*, but fights *legitimate re-uploads* after completion/failure. Quota failed-path uses a condition; the success path to `processing` does not.

**Confidence:** High

**Remediation:** Conditional update only from `pending_upload` (or `uploaded`); on `ExecutionAlreadyExists` after a failed conditional path, do not demote `ready`/`failed`; or use unique execution names per attempt and gate re-analysis explicitly.

---

### H2 — HIGH: Shared `DEV_API_KEY` committed and injected into Dev Lambdas

**Files:** `infra/cdk.json` (line 13), `infra/lib/finlens-stack.ts` (37, 135–149, 770–772), `apps/api/src/lib/auth.ts` (31–34)

**Code:**

```13:13:infra/cdk.json
    "devApiKey": "finlens-dev-local-key",
```

```31:34:apps/api/src/lib/auth.ts
  const devKey = process.env.DEV_API_KEY;
  if (devKey && timingSafeStringEqual(apiKey, devKey)) {
    return "dev";
  }
```

**Attack chain:**

1. Key is in git + emitted as stack output `DevApiKey` for Dev.
2. Anyone who can reach the Dev API URL uses `X-Api-Key: finlens-dev-local-key`.
3. `resolveTenantId` maps to Workspace `dev` → full statement upload/list/get/delete/ask/MCP for that tenant (financial PDFs/CSVs, extracts, Bedrock spend within quotas).

**Existing controls:** Prod explicitly forbids `DEV_API_KEY` in Lambda env (stack throw). Does **not** protect the Dev environment if API is network-reachable.

**Confidence:** High (impact depends on Dev API exposure; treat as High if Dev is public)

**Remediation:** Remove plaintext key from repo; inject via Secrets Manager/SSM at deploy; rotate; restrict Dev API with IAM/WAF/IP allowlist; prefer short-lived Cognito-only Dev auth.

---

### M1 — MEDIUM: Presigned `PutObject` has no size (or Content-MD5) bound

**Files:** `apps/api/src/handlers/create-statement.ts` (90–98), contrast `apps/api/src/lib/file-validation.ts` (`MAX_UPLOAD_BYTES` = 7MB on direct path only)

**Code:**

```90:98:apps/api/src/handlers/create-statement.ts
  const uploadUrl = await getSignedUrl(
    s3,
    new PutObjectCommand({
      Bucket: deps.bucketName,
      Key: s3Key,
      ContentType: contentType,
    }),
    { expiresIn: UPLOAD_EXPIRY_SECONDS },
  );
```

**Attack chain:**

1. Auth + pass upload quota (20/day).
2. Obtain presigned URL (only `ContentType` constrained).
3. PUT multi‑GB object (SigV4 typically does not bind body length for this presign style).
4. Direct upload’s 7MB check never runs. Object stored (90-day lifecycle); `on-s3-upload` may start analysis; `validateForBedrock` fails only at ~4.5MB during analyze.
5. Cost/storage DoS within daily create quota; analysis fails late.

**Existing controls:** Daily upload quota; Bedrock size check at analyze; bucket not public. No `content-length-range` / max object size policy on statement PUTs.

**Confidence:** High

**Remediation:** Prefer `createPresignedPost` with `content-length-range`; or S3 bucket policy / Lambda@Edge limits; or disable presigned path and keep direct upload only.

---

### M2 — MEDIUM: Analyze path skips PDF/CSV validation (magic bytes / encrypt)

**Files:** `apps/api/src/handlers/analyze-statement.ts` (75–80), `apps/api/src/lib/file-validation.ts` (`validateForBedrock` = size only)

**Code:**

```75:80:apps/api/src/handlers/analyze-statement.ts
    const bedrockSizeError = validateForBedrock(body);
    if (bedrockSizeError) {
      throw new Error(bedrockSizeError.message);
    }

    const analysis = await analyzeStatementFile(body, fileType);
```

**Attack chain:**

1. Presigned upload with `Content-Type: application/pdf` of non-PDF / encrypted / adversarial bytes (direct path would often reject).
2. Key extension selects PDF vs CSV model path.
3. Bytes sent to Bedrock Converse → wasted invoke cost / error retries (SFN retries).

**Existing controls:** Direct/MCP upload runs `validateStatementBytes`. Presigned path does not re-validate before Bedrock.

**Confidence:** High

**Remediation:** Call `validateStatementBytes` (or equivalent) in analyze before Bedrock; reject in SFN with clear `failed` reason.

---

### M3 — MEDIUM: Concurrent analysis quota TOCTOU

**Files:** `apps/api/src/lib/quota-service.ts` (290–300), `apps/api/src/handlers/on-s3-upload.ts` (46–100)

**Attack chain:** Parallel S3 completions / creates both observe `processing` count below limit, then both flip to `processing` and start Bedrock → exceeds `concurrentAnalyses` (default 2).

**Existing controls:** Documented as accepted v1 residual in `docs/security/phase-quotas.md`. Daily upload/ask counters are atomic; concurrent path is not leased.

**Confidence:** High

**Remediation:** Atomic lease counter (conditional `ADD` like daily quotas) before `StartExecution`.

---

### M4 — MEDIUM: Ask question length uncapped (Bedrock cost)

**Files:** `apps/api/src/handlers/ask-statement.ts` (35–59), `apps/api/src/lib/statement-power-tools.ts` (286–333), `apps/api/src/lib/bedrock-ask.ts`

**Attack chain:** Auth → ready statement → `POST .../ask` with multi‑MB `question` (API GW ~10MB) → full text in Bedrock user message. Extract is capped (80 txs / 12k chars); question is not. Up to asks/day quota (100).

**Existing controls:** Ask daily quota; authz; extract truncation.

**Confidence:** High

**Remediation:** Hard max on question chars (e.g. 2–4k) before quota consume / Bedrock.

---

### M5 — MEDIUM: Over-broad Lambda IAM (S3 bucket-wide + Bedrock `*` models + Marketplace Subscribe)

**Files:** `infra/lib/finlens-stack.ts` (339–410)

**Notes:**

- `statementsBucket.grantPut|grantRead|grantDelete` → all object keys, not `statements/${!tenantId}/*`.
- Bedrock: `arn:aws:bedrock:*::foundation-model/*` and `inference-profile/*`.
- `aws-marketplace:Subscribe|Unsubscribe|ViewSubscriptions` on `*`.

**Impact:** Compromised analyze/MCP/ask/create role → read/write any tenant prefix; invoke any foundation model; marketplace subscribe. Not remotely exploitable alone; enlarges blast radius.

**Confidence:** High

**Remediation:** Prefix-condition IAM where feasible; pin model ARNs from context; drop Unsubscribe if unused; tighten Marketplace actions.

---

### M6 — MEDIUM: Unconditional `ready`/`failed` → `processing` without matching `s3Key`

**Files:** `apps/api/src/handlers/on-s3-upload.ts` (27–40, 89–100)

**Related to H1.** Handler trusts key → `(tenantId, statementId)`, loads item, does not assert `existing.Item.s3Key === key`, and does not restrict prior status before setting `processing`.

**Cross-tenant spoof via key alone:** Blocked for normal API users (presigned URL key-bound; direct upload builds key from auth `tenantId`). Remains defense-in-depth gap if anything else can `PutObject` under another prefix (over-broad `grantPut`, compromised creds).

**Confidence:** Medium–High for same-tenant status confusion; Low for cross-tenant without extra Put privilege

---

## Ruled out (with reasons)

| Concern | Verdict |
|---------|---------|
| **IDOR across tenantId** | **Ruled out.** All CRUD/power tools use `resolveTenantId` + `GetItem`/`Query` with `tenantId` PK. Missing/wrong tenant → null / 404, no existence leak (`fetchStatementRecord`, compare both-or-neither). |
| **nextToken cross-tenant forgery** | **Ruled out.** `decodeListCursor` requires `parsed.tenantId ===` auth tenant; query also `tenantId = :tenantId`. Unsigned cursor → same-tenant skip only. |
| **S3 path traversal in keys** | **Ruled out.** Keys from `statements/${tenantId}/${uuid}.ext` with `ws_`+UUID tenant ids and `randomUUID` statement ids; user `filename` only affects type sniff, not key. |
| **S3 event confused deputy (foreign bucket)** | **Ruled out.** CDK notification permission is tied to `statementsBucket`; key tenant spoof needs Put on victim key (not available via other tenants’ URLs). |
| **Unauthenticated statement endpoints** | **Ruled out.** Handlers/MCP require Bearer or API key. Public OAuth metadata is intentional. Analyze is SFN-invoked, not HTTP. |
| **SQL injection** | **Ruled out.** DynamoDB Document Client + attribute values; no string-built queries. |
| **Command injection** | **Ruled out.** No shell/`exec` in scoped handlers/libs. |
| **SSRF** | **Ruled out in scope.** No user URL fetch in statement handlers. OAuth proxy talks to configured Cognito only. |
| **Classic deserialization RCE** | **Ruled out.** `JSON.parse` of bodies/cursors/model JSON; no `eval`/yaml/pickle. Node 20 object spread does not prototype-pollute via `__proto__` the way `Object.assign` historically could. |
| **Mass assignment on statements** | **Ruled out.** Create builds fixed record fields; no client-controlled Dynamo attribute merge. |
| **Prompt injection → other tenants’ data** | **Ruled out for real cross-tenant impact.** Analyze/ask prompts contain only that statement’s bytes/summary/extract. No tools/RAG across tenants. Same-tenant instruction override / misleading insights remain residual LLM risk without isolation break. |
| **Quota silent bypass if tables missing** | **Mostly ruled out in deployed CDK** (`WORKSPACES_TABLE` always set). `create-statement` fails closed on missing table; direct upload omits quota seam only if env unset (misconfig). |
| **Prototype pollution via list cursor** | **Ruled out / negligible.** Cursor validated for required string fields + tenant match before use as `ExclusiveStartKey`. |
| **Hardcoded prod secrets** | **Prod DEV key:** blocked by stack. **Account IDs / Cognito IDs in cdk.json:** config not credentials (except Dev API key → H2). |

---

## Positive controls observed

- Composite-key tenant isolation; removed global `byStatementId` GSI pattern called out in docs.
- Timing-safe Dev key compare; hashed API keys; Cognito JWT verify via `aws-jwt-verify`.
- S3: BlockPublicAccess, SSL, SSE-KMS + rotation, access logs, 90-day lifecycle.
- Prod CORS allowlist = CloudFront origin; prod cannot get `DEV_API_KEY`.
- Direct upload: type/size/encrypt checks; idempotency tenant-scoped; ask extract truncated.
- MCP rejects remote `file_path` reads.
