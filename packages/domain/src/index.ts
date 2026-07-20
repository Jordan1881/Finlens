export type StatementStatus =
  | "pending_upload"
  | "uploaded"
  | "processing"
  | "ready"
  | "failed";

/** Isolation unit; `tenantId` on Statements/API keys equals `workspaceId`. */
export interface WorkspaceRecord {
  workspaceId: string;
  name: string;
  ownerSub: string;
  createdAt: string;
  /**
   * Optional per-Workspace limit overrides (#23).
   * Keys: uploadsPerDay, asksPerDay, concurrentAnalyses.
   */
  quotas?: Record<string, number>;
}

export type WorkspaceMemberRole = "owner" | "member";

/** Cognito user → Workspace membership (v1: one personal Workspace per user). */
export interface WorkspaceMembership {
  cognitoSub: string;
  workspaceId: string;
  role: WorkspaceMemberRole;
  createdAt: string;
}

export interface FinancialSummary {
  currency: string;
  month: string | null;
  totalIncome: number;
  totalExpenses: number;
  netBalance: number;
  topCategories: Array<{ category: string; amount: number }>;
}

/** Structured line items produced by Analysis for later ask/compare tools. */
export interface ExtractedTransaction {
  date: string;
  description: string;
  amount: number;
  type: "income" | "expense";
  category?: string;
}

export interface StatementRecord {
  tenantId: string;
  statementId: string;
  status: StatementStatus;
  s3Key: string;
  sourceFormat?: "pdf" | "csv";
  createdAt: string;
  updatedAt: string;
  errorMessage?: string;
  financialSummary?: FinancialSummary;
  spendingInsights?: string[];
  /** Inline extract when modest; omitted when overflowed to S3. */
  transactionExtract?: ExtractedTransaction[];
  /** Tenant-prefixed S3 object when extract exceeds the DynamoDB size cap. */
  transactionExtractS3Key?: string;
  /** SHA-256 hex of uploaded bytes — used for practical upload idempotency. */
  contentHash?: string;
  /** Client-supplied Idempotency-Key — reused within the idempotency window. */
  idempotencyKey?: string;
}

export interface CreateStatementResponse {
  statementId: string;
  uploadUrl: string;
  expiresIn: number;
  s3Key: string;
}

export interface DirectUploadResponse {
  statementId: string;
  s3Key: string;
  status: StatementStatus;
  /** True when a recent duplicate (content hash or Idempotency-Key) was reused. */
  idempotentReplay?: boolean;
}

export interface StatementStatusResponse {
  statementId: string;
  status: StatementStatus;
  createdAt: string;
  updatedAt: string;
  sourceFormat?: "pdf" | "csv";
  errorMessage?: string;
  /** Structured failure — same shape as summary `error` when status is failed. */
  error?: StructuredError;
  financialSummary?: FinancialSummary;
  spendingInsights?: string[];
  /** Present on detail=full when Analysis completed (hydrated from DDB or S3). */
  transactionExtract?: ExtractedTransaction[];
  /** Set when extract lives in S3 and was not hydrated into transactionExtract. */
  transactionExtractS3Key?: string;
}

export interface StatementSummaryView {
  statementId: string;
  status: StatementStatus;
  createdAt: string;
  updatedAt: string;
  sourceFormat?: "pdf" | "csv";
  currency?: string;
  month?: string | null;
  totalIncome?: number;
  totalExpenses?: number;
  netBalance?: number;
  topCategories?: Array<{ category: string; amount: number }>;
  spendingInsights?: string[];
  error?: StructuredError;
}

export interface StatementListItem {
  statementId: string;
  status: StatementStatus;
  createdAt: string;
  updatedAt: string;
  month: string | null;
  sourceFormat?: "pdf" | "csv";
}

export interface ListStatementsParams {
  /** Page size (default 20, max 50). */
  limit?: number;
  /** Opaque cursor from a previous response's nextToken. */
  nextToken?: string;
  /** Optional status filter (may yield short pages — follow nextToken). */
  status?: StatementStatus;
}

export interface ListStatementsResponse {
  statements: StatementListItem[];
  count: number;
  /** Present when more results are available — pass as nextToken / cursor. */
  nextToken?: string;
}

export interface DeleteStatementResponse {
  statementId: string;
  deleted: true;
}

export interface StructuredError {
  code: string;
  message: string;
  retryable: boolean;
  nextStep: string;
}

export type ApiKeyStatus = "active" | "revoked";

/** Stored ApiKeysTable row — plaintext secret is never persisted. */
export interface ApiKeyRecord {
  keyHash: string;
  keyId: string;
  tenantId: string;
  createdAt: string;
  status: ApiKeyStatus;
  /** Short display prefix (e.g. flk_xxxx); not secret. */
  prefix: string;
}

/** List/mint metadata returned to clients (no hash, no secret). */
export interface ApiKeyMetadata {
  keyId: string;
  tenantId: string;
  createdAt: string;
  status: ApiKeyStatus;
  prefix: string;
}

export interface MintApiKeyResponse {
  keyId: string;
  tenantId: string;
  createdAt: string;
  status: ApiKeyStatus;
  prefix: string;
  /** Plaintext secret — returned once at mint time only. */
  apiKey: string;
}

export interface ListApiKeysResponse {
  keys: ApiKeyMetadata[];
  count: number;
}

export interface RevokeApiKeyResponse {
  keyId: string;
  revoked: true;
}
