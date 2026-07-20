"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { api, apiConfigured, getApiUrl, getMcpUrl } from "../lib/api";
import {
  beginLogin,
  beginLogout,
  isAuthenticated,
  isCognitoConfigured,
} from "../lib/auth";

const fadeUp = {
  initial: { opacity: 0, y: 14 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.45, ease: [0.22, 1, 0.36, 1] as const },
};

const stagger = {
  animate: { transition: { staggerChildren: 0.06 } },
};

const POLL_MS = 15_000;
const LIST_PAGE_SIZE = 20;
const MCP_KEY_PLACEHOLDER = "<paste-minted-api-key>";

type Section = "dashboard" | "statements" | "insights" | "api-keys" | "mcp-setup";

type StatementRow = {
  statementId: string;
  status: string;
  createdAt: string;
  month?: string | null;
  sourceFormat?: "pdf" | "csv";
};

type ApiKeyRow = {
  keyId: string;
  tenantId: string;
  createdAt: string;
  status: "active" | "revoked";
  prefix: string;
};

type MintApiKeyResult = ApiKeyRow & {
  apiKey: string;
};

type StatementDetail = {
  statementId: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  currency?: string;
  month?: string | null;
  totalIncome?: number;
  totalExpenses?: number;
  netBalance?: number;
  topCategories?: Array<{ category: string; amount: number }>;
  spendingInsights?: string[];
  error?: { message: string; nextStep?: string; code?: string; retryable?: boolean };
};

type CategoryBreakdown = {
  statementId: string;
  status: string;
  currency?: string;
  month?: string | null;
  source: "summary" | "extract";
  categories: Array<{ category: string; amount: number; share?: number }>;
  totalCategorized: number;
};

type CompareSide = {
  statementId: string;
  month: string | null;
  currency: string;
  totalIncome: number;
  totalExpenses: number;
  netBalance: number;
  topCategories: Array<{ category: string; amount: number }>;
};

type CompareResult = {
  a: CompareSide;
  b: CompareSide;
  deltas: {
    totalIncome: number;
    totalExpenses: number;
    netBalance: number;
    categories: Array<{
      category: string;
      amountA: number;
      amountB: number;
      delta: number;
    }>;
  };
};

function formatMoney(value: number | undefined, currency = "ILS") {
  if (value === undefined) {
    return "—";
  }
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    }).format(value);
  } catch {
    return `${value.toLocaleString()} ${currency}`;
  }
}

function formatDelta(value: number, currency = "ILS") {
  const formatted = formatMoney(Math.abs(value), currency);
  if (value > 0) {
    return `+${formatted}`;
  }
  if (value < 0) {
    return `−${formatted}`;
  }
  return formatted;
}

function statementLabel(s: { statementId: string; month?: string | null; status?: string }) {
  const id = `${s.statementId.slice(0, 8)}…`;
  if (s.month) {
    return `${s.month} (${id})`;
  }
  return id;
}

function AnalysisErrorBanner({
  error,
}: {
  error: { message: string; nextStep?: string; code?: string };
}) {
  return (
    <div className="error-banner">
      <strong>{error.message}</strong>
      {error.code && <p className="error-code">{error.code}</p>}
      {error.nextStep && (
        <p className="error-next">
          <span className="error-next-label">Next step:</span> {error.nextStep}
        </p>
      )}
    </div>
  );
}

function isProcessingStatus(status: string) {
  return status === "processing" || status === "uploaded";
}

function IconDashboard() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M3 10.5h8V3H3v7.5Zm0 10.5h8v-8H3v8Zm10 0h8V13h-8v8Zm0-18v7.5h8V3h-8Z"
        fill="currentColor"
      />
    </svg>
  );
}

function IconStatements() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M6 2h9l5 5v15a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Zm8 1.5V8h4.5L14 3.5ZM8 12h8v2H8v-2Zm0 4h8v2H8v-2Z"
        fill="currentColor"
      />
    </svg>
  );
}

function IconInsights() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 2a7 7 0 0 0-4 12.74V18a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2v-3.26A7 7 0 0 0 12 2Zm0 4a3 3 0 1 1 0 6 3 3 0 0 1 0-6Z"
        fill="currentColor"
      />
    </svg>
  );
}

function IconKeys() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M7 14a5 5 0 1 1 4.9-6H21v3h-2v2h-2v2h-3.1A5 5 0 0 1 7 14Zm0-2a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"
        fill="currentColor"
      />
    </svg>
  );
}

function IconMcp() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M4 7h6v2H4V7Zm10 0h6v2h-6V7ZM4 15h6v2H4v-2Zm10 0h6v2h-6v-2ZM9 9v6h2V9H9Zm4 0v6h2V9h-2Z"
        fill="currentColor"
      />
    </svg>
  );
}

function buildMcpConfigJson(mcpUrl: string, apiKey: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        finlens: {
          url: mcpUrl,
          headers: {
            "X-Api-Key": apiKey,
          },
        },
      },
    },
    null,
    2,
  );
}

function IconSearch() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M10.5 18a7.5 7.5 0 1 1 0-15 7.5 7.5 0 0 1 0 15Zm8.2 2.3-3.8-3.8"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function IconUpload() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 16V4m0 0 4 4m-4-4-4 4M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconRefresh() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M4 12a8 8 0 0 1 13.7-5.7M20 12a8 8 0 0 1-13.7 5.7M16 6h4V2M8 18H4v4"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function StatementOverview({ selected }: { selected: StatementDetail }) {
  const maxCategoryAmount = useMemo(() => {
    if (!selected.topCategories?.length) {
      return 0;
    }
    return Math.max(...selected.topCategories.map((c) => c.amount));
  }, [selected.topCategories]);

  return (
    <>
      <p className="overview-meta">
        ID {selected.statementId.slice(0, 8)}…
        {selected.month ? ` · ${selected.month}` : ""}
      </p>

      {selected.error && <AnalysisErrorBanner error={selected.error} />}

      {selected.status === "ready" && (
        <>
          <div className="summary-grid">
            <div className="metric">
              <span>Income</span>
              <strong>{formatMoney(selected.totalIncome, selected.currency)}</strong>
            </div>
            <div className="metric">
              <span>Expenses</span>
              <strong>{formatMoney(selected.totalExpenses, selected.currency)}</strong>
            </div>
            <div className="metric">
              <span>Net balance</span>
              <strong>{formatMoney(selected.netBalance, selected.currency)}</strong>
            </div>
            <div className="metric">
              <span>Currency</span>
              <strong>{selected.currency ?? "—"}</strong>
            </div>
          </div>
          {selected.topCategories && selected.topCategories.length > 0 && (
            <>
              <h4 className="subsection-title">Top categories</h4>
              <div className="category-bars">
                {selected.topCategories.map((c) => (
                  <div className="category-row" key={c.category}>
                    <span>{c.category}</span>
                    <span>{formatMoney(c.amount, selected.currency)}</span>
                    <div className="bar-track">
                      <div
                        className="bar-fill"
                        style={{
                          width:
                            maxCategoryAmount > 0
                              ? `${Math.round((c.amount / maxCategoryAmount) * 100)}%`
                              : "0%",
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
          {selected.spendingInsights && selected.spendingInsights.length > 0 && (
            <>
              <h4 className="subsection-title spaced">Insights</h4>
              <ul className="insights-list">
                {selected.spendingInsights.map((i) => (
                  <li key={i}>{i}</li>
                ))}
              </ul>
            </>
          )}
        </>
      )}

      {selected.status === "pending_upload" && (
        <div className="info-banner">
          Upload never finished for this statement. Drop the file again or choose a new one.
        </div>
      )}

      {isProcessingStatus(selected.status) && (
        <div className="info-banner processing">
          Analysis in progress — this page refreshes automatically every 15 seconds.
        </div>
      )}

      {selected.status === "failed" && !selected.error && (
        <div className="error-banner">
          <strong>Analysis failed.</strong>
          <p className="error-next">
            <span className="error-next-label">Next step:</span> Upload the statement again (PDF
            or CSV).
          </p>
        </div>
      )}
    </>
  );
}

export default function HomePage() {
  const [section, setSection] = useState<Section>("dashboard");
  const [statements, setStatements] = useState<StatementRow[]>([]);
  const [selected, setSelected] = useState<StatementDetail | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [insightSummaries, setInsightSummaries] = useState<StatementDetail[]>([]);
  const [failedInsights, setFailedInsights] = useState<StatementDetail[]>([]);
  const [compareA, setCompareA] = useState<string>("");
  const [compareB, setCompareB] = useState<string>("");
  const [compareResult, setCompareResult] = useState<CompareResult | null>(null);
  const [compareError, setCompareError] = useState<string | null>(null);
  const [categoryStatementId, setCategoryStatementId] = useState<string>("");
  const [categoryBreakdown, setCategoryBreakdown] = useState<CategoryBreakdown | null>(null);
  const [categoryError, setCategoryError] = useState<string | null>(null);
  const [apiKeys, setApiKeys] = useState<ApiKeyRow[]>([]);
  const [mintedSecret, setMintedSecret] = useState<MintApiKeyResult | null>(null);
  const [listNextToken, setListNextToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [authed, setAuthed] = useState(false);
  const [authReady, setAuthReady] = useState(false);
  const [loginBusy, setLoginBusy] = useState(false);
  const [copiedHint, setCopiedHint] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const mcpUrl = useMemo(() => getMcpUrl(), []);
  const apiBaseUrl = useMemo(() => getApiUrl(), []);
  const mcpConfigTemplate = useMemo(
    () => (mcpUrl ? buildMcpConfigJson(mcpUrl, MCP_KEY_PLACEHOLDER) : ""),
    [mcpUrl],
  );

  const load = useCallback(async (opts?: { append?: boolean; token?: string }) => {
    const qs = new URLSearchParams({ limit: String(LIST_PAGE_SIZE) });
    if (opts?.token) {
      qs.set("nextToken", opts.token);
    }
    const data = await api<{ statements: StatementRow[]; nextToken?: string }>(
      `/v1/statements?${qs.toString()}`,
    );
    const rows = data.statements ?? [];
    setStatements((prev) => (opts?.append ? [...prev, ...rows] : rows));
    setListNextToken(data.nextToken ?? null);
  }, []);

  const loadApiKeys = useCallback(async () => {
    const data = await api<{ keys: ApiKeyRow[] }>("/v1/api-keys");
    setApiKeys(data.keys ?? []);
  }, []);

  const refreshAll = useCallback(async () => {
    setError(null);
    try {
      await load();
      if (selectedId) {
        const data = await api<StatementDetail>(`/v1/statements/${selectedId}?detail=summary`);
        setSelected(data);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [load, selectedId]);

  useEffect(() => {
    setAuthed(isAuthenticated());
    setAuthReady(true);
  }, []);

  useEffect(() => {
    if (!authReady || !authed) {
      setInitialLoading(false);
      return;
    }
    setInitialLoading(true);
    load()
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setInitialLoading(false));
  }, [authReady, authed, load]);

  useEffect(() => {
    if (!authReady || !authed || section !== "api-keys") {
      return;
    }
    void loadApiKeys().catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [authReady, authed, section, loadApiKeys]);

  useEffect(() => {
    if (!authed) {
      return;
    }
    const needsPoll =
      statements.some((s) => isProcessingStatus(s.status)) ||
      (selected != null && isProcessingStatus(selected.status));

    if (!needsPoll) {
      return;
    }

    const timer = window.setInterval(() => {
      void refreshAll();
    }, POLL_MS);

    return () => window.clearInterval(timer);
  }, [authed, statements, selected, refreshAll]);

  useEffect(() => {
    if (!authed || section !== "insights") {
      return;
    }

    const ready = statements.filter((s) => s.status === "ready").slice(0, 10);
    const failed = statements.filter((s) => s.status === "failed").slice(0, 10);

    if (ready.length === 0) {
      setInsightSummaries([]);
    }
    if (failed.length === 0) {
      setFailedInsights([]);
    }
    if (ready.length === 0 && failed.length === 0) {
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const [readySummaries, failedSummaries] = await Promise.all([
          Promise.all(
            ready.map((s) =>
              api<StatementDetail>(`/v1/statements/${s.statementId}?detail=summary`),
            ),
          ),
          Promise.all(
            failed.map((s) =>
              api<StatementDetail>(`/v1/statements/${s.statementId}?detail=summary`),
            ),
          ),
        ]);
        if (!cancelled) {
          setInsightSummaries(readySummaries);
          setFailedInsights(failedSummaries);
          setCompareA((prev) => prev || ready[0]?.statementId || "");
          setCompareB((prev) => prev || ready[1]?.statementId || ready[0]?.statementId || "");
          setCategoryStatementId((prev) => prev || ready[0]?.statementId || "");
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [authed, section, statements]);

  const readyStatements = useMemo(
    () => statements.filter((s) => s.status === "ready"),
    [statements],
  );

  const categoryMaxAmount = useMemo(() => {
    if (!categoryBreakdown?.categories.length) {
      return 0;
    }
    return Math.max(...categoryBreakdown.categories.map((c) => c.amount));
  }, [categoryBreakdown]);

  const stats = useMemo(() => {
    const ready = statements.filter((s) => s.status === "ready").length;
    const processing = statements.filter((s) =>
      ["processing", "uploaded", "pending_upload"].includes(s.status),
    ).length;
    const failed = statements.filter((s) => s.status === "failed").length;
    return { total: statements.length, ready, processing, failed };
  }, [statements]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      return statements;
    }
    return statements.filter(
      (s) =>
        s.statementId.toLowerCase().includes(q) ||
        s.status.toLowerCase().includes(q) ||
        (s.month ?? "").toLowerCase().includes(q) ||
        (s.sourceFormat ?? "pdf").includes(q),
    );
  }, [statements, query]);

  const emptyTableMessage =
    statements.length === 0
      ? "No statements yet — upload a PDF or CSV to get started."
      : "No statements match your search.";

  async function onUpload(file: File) {
    const lower = file.name.toLowerCase();
    if (!lower.endsWith(".pdf") && !lower.endsWith(".csv")) {
      setError("Only PDF and CSV bank statements are supported.");
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const result = reader.result as string;
          resolve(result.split(",")[1] ?? "");
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      await api("/v1/statements/upload", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ base64, filename: file.name }),
      });
      await load();
      setSection("statements");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function openStatement(id: string) {
    setBusy(true);
    setError(null);
    setSelectedId(id);
    try {
      const data = await api<StatementDetail>(`/v1/statements/${id}?detail=summary`);
      setSelected(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onCompareStatements() {
    if (!compareA || !compareB) {
      setCompareError("Pick two ready statements to compare.");
      return;
    }
    setBusy(true);
    setCompareError(null);
    setCompareResult(null);
    try {
      const result = await api<CompareResult>("/v1/statements/compare", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ statementIdA: compareA, statementIdB: compareB }),
      });
      setCompareResult(result);
    } catch (e) {
      setCompareError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onLoadCategories(statementId: string) {
    if (!statementId) {
      setCategoryError("Pick a ready statement for the category chart.");
      return;
    }
    setBusy(true);
    setCategoryError(null);
    setCategoryBreakdown(null);
    setCategoryStatementId(statementId);
    try {
      const result = await api<CategoryBreakdown>(
        `/v1/statements/${statementId}/categories`,
      );
      setCategoryBreakdown(result);
    } catch (e) {
      setCategoryError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onDeleteStatement(id: string) {
    const label = `${id.slice(0, 8)}…`;
    if (
      !window.confirm(
        `Delete statement ${label}? This permanently removes the file and analysis.`,
      )
    ) {
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await api(`/v1/statements/${id}`, { method: "DELETE" });
      if (selectedId === id) {
        setSelected(null);
        setSelectedId(null);
      }
      setInsightSummaries((rows) => rows.filter((r) => r.statementId !== id));
      setFailedInsights((rows) => rows.filter((r) => r.statementId !== id));
      if (compareA === id) {
        setCompareA("");
      }
      if (compareB === id) {
        setCompareB("");
      }
      if (compareResult?.a.statementId === id || compareResult?.b.statementId === id) {
        setCompareResult(null);
      }
      if (categoryStatementId === id) {
        setCategoryStatementId("");
        setCategoryBreakdown(null);
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onMintApiKey() {
    setBusy(true);
    setError(null);
    try {
      const minted = await api<MintApiKeyResult>("/v1/api-keys", { method: "POST" });
      setMintedSecret(minted);
      await loadApiKeys();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onRevokeApiKey(keyId: string) {
    const label = keyId.slice(0, 12);
    if (
      !window.confirm(
        `Revoke API key ${label}…? Agents using this key will fail immediately.`,
      )
    ) {
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await api(`/v1/api-keys/${keyId}`, { method: "DELETE" });
      if (mintedSecret?.keyId === keyId) {
        setMintedSecret(null);
      }
      await loadApiKeys();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function copyText(value: string, hint = "Copied") {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedHint(hint);
      window.setTimeout(() => setCopiedHint(null), 2000);
    } catch {
      setError("Could not copy to clipboard — select the text and copy manually.");
    }
  }

  async function onLoadMore() {
    if (!listNextToken || busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await load({ append: true, token: listNextToken });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) {
      void onUpload(file);
    }
  }

  function renderUploadZone() {
    return (
      <div
        className={`upload-zone${dragging ? " dragging" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <div className="upload-icon">
          <IconUpload />
        </div>
        <strong>Click or drag file to upload</strong>
        <p>Bank statement PDFs and CSV exports</p>
        <div className="upload-formats">
          <span className="format-badge">PDF</span>
          <span className="format-badge">CSV</span>
        </div>
        <div className="upload-actions">
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => fileInputRef.current?.click()}
          >
            {busy ? "Uploading…" : "Select file"}
          </button>
        </div>
      </div>
    );
  }

  function renderStatementsTable(compact = false) {
    return (
      <>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Statement</th>
                <th>Format</th>
                <th>Status</th>
                <th>Period</th>
                {!compact && <th>Uploaded</th>}
                <th />
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={compact ? 5 : 6}>
                    <div className="empty-state">{emptyTableMessage}</div>
                  </td>
                </tr>
              )}
              {filtered.map((s) => (
                <tr
                  key={s.statementId}
                  className={[
                    selectedId === s.statementId ? "row-selected" : "",
                    "row-clickable",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  onClick={() => void openStatement(s.statementId)}
                >
                  <td>{s.statementId.slice(0, 8)}…</td>
                  <td>
                    <span className="type-pill">{s.sourceFormat ?? "pdf"}</span>
                  </td>
                  <td>
                    <span className={`status-pill status-${s.status}`}>{s.status}</span>
                  </td>
                  <td>{s.month ?? "—"}</td>
                  {!compact && <td>{new Date(s.createdAt).toLocaleDateString()}</td>}
                  <td className="row-actions">
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      disabled={busy}
                      onClick={(e) => {
                        e.stopPropagation();
                        void openStatement(s.statementId);
                      }}
                    >
                      View
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-danger"
                      disabled={busy}
                      onClick={(e) => {
                        e.stopPropagation();
                        void onDeleteStatement(s.statementId);
                      }}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {listNextToken && (
          <div className="load-more-row">
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              disabled={busy}
              onClick={() => void onLoadMore()}
            >
              {busy ? "Loading…" : "Load more"}
            </button>
          </div>
        )}
      </>
    );
  }

  const sectionTitle =
    section === "dashboard"
      ? "Dashboard"
      : section === "statements"
        ? "Statements"
        : section === "insights"
          ? "Insights"
          : section === "api-keys"
            ? "API keys"
            : "MCP setup";

  const sectionSubtitle =
    section === "dashboard"
      ? "Overview of your uploaded statements and spending insights."
      : section === "statements"
        ? "Browse uploads, open summaries, and track processing status."
        : section === "insights"
          ? "Compare statements and category charts from the same Workspace tools agents use."
          : section === "api-keys"
            ? "Mint keys for MCP and agents. The secret is shown once; only a hash is stored."
            : "Copy Cursor MCP config with the API URL, then paste a minted key — never baked into the web build.";

  if (!authReady) {
    return (
      <main className="auth-screen">
        <div className="auth-orb auth-orb-a" aria-hidden />
        <div className="auth-orb auth-orb-b" aria-hidden />
        <motion.div className="auth-card" {...fadeUp}>
          <div className="brand-mark auth-brand" aria-hidden>
            <span className="brand-mark-inner">F</span>
          </div>
          <p className="auth-eyebrow">Finlens</p>
          <h1>Opening your workspace</h1>
          <p className="auth-lede">Loading secure session…</p>
          <div className="auth-loader" aria-hidden />
        </motion.div>
      </main>
    );
  }

  if (!authed) {
    return (
      <main className="auth-screen">
        <div className="auth-orb auth-orb-a" aria-hidden />
        <div className="auth-orb auth-orb-b" aria-hidden />
        <motion.div
          className="auth-card"
          initial={{ opacity: 0, y: 18, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
        >
          <div className="brand-mark auth-brand" aria-hidden>
            <span className="brand-mark-inner">F</span>
          </div>
          <p className="auth-eyebrow">Statement intelligence</p>
          <h1>Finlens</h1>
          <p className="auth-lede">
            Sign in to your Workspace — upload statements, mint agent keys, and read the same
            Analysis your MCP tools see.
          </p>
          {!isCognitoConfigured() && (
            <div className="error-banner">
              Cognito is not configured. Set NEXT_PUBLIC_COGNITO_USER_POOL_ID,
              NEXT_PUBLIC_COGNITO_CLIENT_ID, and NEXT_PUBLIC_COGNITO_DOMAIN.
            </div>
          )}
          {!apiConfigured() && (
            <div className="error-banner">Set NEXT_PUBLIC_FINLENS_API_URL for API calls.</div>
          )}
          <button
            type="button"
            className="btn btn-auth"
            disabled={loginBusy || !isCognitoConfigured()}
            onClick={() => {
              setLoginBusy(true);
              void beginLogin().catch((e) => {
                setLoginBusy(false);
                setError(e instanceof Error ? e.message : String(e));
              });
            }}
          >
            {loginBusy ? "Redirecting…" : "Continue with Cognito"}
          </button>
          {error && <div className="error-banner">{error}</div>}
          <p className="auth-footnote">PDF &amp; CSV · Hebrew &amp; English · Agent-first</p>
        </motion.div>
      </main>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark" aria-hidden>
            <span className="brand-mark-inner">F</span>
          </div>
          <div>
            <h1>Finlens</h1>
            <p>Workspace control plane</p>
          </div>
        </div>

        <div>
          <div className="nav-section-label">Navigate</div>
          <nav className="nav">
            <button
              type="button"
              className={`nav-item${section === "dashboard" ? " active" : ""}`}
              onClick={() => setSection("dashboard")}
            >
              <IconDashboard />
              Dashboard
            </button>
            <button
              type="button"
              className={`nav-item${section === "statements" ? " active" : ""}`}
              onClick={() => setSection("statements")}
            >
              <IconStatements />
              Statements
            </button>
            <button
              type="button"
              className={`nav-item${section === "insights" ? " active" : ""}`}
              onClick={() => setSection("insights")}
            >
              <IconInsights />
              Insights
            </button>
            <button
              type="button"
              className={`nav-item${section === "api-keys" ? " active" : ""}`}
              onClick={() => setSection("api-keys")}
            >
              <IconKeys />
              API keys
            </button>
            <button
              type="button"
              className={`nav-item${section === "mcp-setup" ? " active" : ""}`}
              onClick={() => setSection("mcp-setup")}
            >
              <IconMcp />
              MCP setup
            </button>
          </nav>
        </div>

        <div className="sidebar-promo">
          <strong>Built for agents</strong>
          <p>Mint a key, paste into Cursor, and keep humans on the same Workspace truth.</p>
        </div>
      </aside>

      <div className="content-area">
        <header className="topbar">
          <div className="search-wrap">
            <IconSearch />
            <input
              className="search-input"
              type="search"
              placeholder="Search statements…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div className="topbar-actions">
            <button
              type="button"
              className={`icon-btn${busy ? " spinning" : ""}`}
              disabled={busy}
              aria-label="Refresh"
              onClick={() => void refreshAll()}
            >
              <IconRefresh />
            </button>
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy}
              onClick={() => fileInputRef.current?.click()}
            >
              Upload
            </button>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => beginLogout()}
            >
              Sign out
            </button>
            <div className="avatar" aria-hidden>
              FL
            </div>
          </div>
        </header>

        <main className="main">
          <AnimatePresence mode="wait">
            <motion.div
              key={section}
              className="page-title-block"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
            >
              <p className="page-eyebrow">Workspace</p>
              <h2>{sectionTitle}</h2>
              <p>{sectionSubtitle}</p>
            </motion.div>
          </AnimatePresence>

          {error && <div className="error-banner">{error}</div>}
          {copiedHint && <div className="info-banner">{copiedHint}</div>}
          {initialLoading && <div className="info-banner processing">Loading statements…</div>}

          {section === "dashboard" && (
            <motion.div variants={stagger} initial="initial" animate="animate">
              <section className="stats-grid">
                <motion.div className="stat-card" variants={fadeUp}>
                  <div className="stat-icon blue">
                    <IconStatements />
                  </div>
                  <div className="stat-body">
                    <div className="stat-label">Total statements</div>
                    <div className="stat-value">{stats.total}</div>
                    <div className="stat-meta">All uploads</div>
                  </div>
                </motion.div>
                <motion.div className="stat-card" variants={fadeUp}>
                  <div className="stat-icon green">
                    <IconDashboard />
                  </div>
                  <div className="stat-body">
                    <div className="stat-label">Ready</div>
                    <div className="stat-value">{stats.ready}</div>
                    <div className="stat-meta">Analysis complete</div>
                  </div>
                </motion.div>
                <motion.div className="stat-card" variants={fadeUp}>
                  <div className="stat-icon orange">
                    <IconUpload />
                  </div>
                  <div className="stat-body">
                    <div className="stat-label">In progress</div>
                    <div className="stat-value">{stats.processing}</div>
                    <div className="stat-meta">Processing pipeline</div>
                  </div>
                </motion.div>
                <motion.div className="stat-card" variants={fadeUp}>
                  <div className="stat-icon purple">
                    <IconInsights />
                  </div>
                  <div className="stat-body">
                    <div className="stat-label">Failed</div>
                    <div className="stat-value">{stats.failed}</div>
                    <div className="stat-meta">Needs re-upload</div>
                  </div>
                </motion.div>
              </section>

              <section className="dashboard-grid">
                <div className="panel">
                  <div className="panel-head">
                    <h3>Upload statement</h3>
                  </div>
                  <div className="panel-body">{renderUploadZone()}</div>

                  <div className="panel-head">
                    <h3>Recent statements</h3>
                    <span className="panel-meta">{filtered.length} items</span>
                  </div>
                  {renderStatementsTable()}
                </div>

                <div className="panel">
                  <div className="panel-head">
                    <h3>Statement overview</h3>
                    <div className="panel-head-actions">
                      {selected && (
                        <>
                          <span className={`status-pill status-${selected.status}`}>
                            {selected.status}
                          </span>
                          <button
                            type="button"
                            className="btn btn-sm btn-danger"
                            disabled={busy}
                            onClick={() => void onDeleteStatement(selected.statementId)}
                          >
                            Delete
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="panel-body">
                    {!selected && (
                      <div className="empty-state">
                        <div className="empty-illustration">
                          <IconInsights />
                        </div>
                        Select a statement to view income, expenses, and category breakdown.
                      </div>
                    )}
                    {selected && <StatementOverview selected={selected} />}
                  </div>
                </div>
              </section>
            </motion.div>
          )}

          {section === "statements" && (
            <section className="statements-layout">
              <div className="panel">
                <div className="panel-head">
                  <h3>Upload statement</h3>
                </div>
                <div className="panel-body">{renderUploadZone()}</div>
              </div>
              <div className="panel">
                <div className="panel-head">
                  <h3>All statements</h3>
                  <span className="panel-meta">{filtered.length} items</span>
                </div>
                {renderStatementsTable()}
              </div>
              <div className="panel">
                <div className="panel-head">
                  <h3>Selected summary</h3>
                  <div className="panel-head-actions">
                    {selected && (
                      <>
                        <span className={`status-pill status-${selected.status}`}>
                          {selected.status}
                        </span>
                        <button
                          type="button"
                          className="btn btn-sm btn-danger"
                          disabled={busy}
                          onClick={() => void onDeleteStatement(selected.statementId)}
                        >
                          Delete
                        </button>
                      </>
                    )}
                  </div>
                </div>
                <div className="panel-body">
                  {!selected && (
                    <div className="empty-state">Click a row to open its summary.</div>
                  )}
                  {selected && <StatementOverview selected={selected} />}
                </div>
              </div>
            </section>
          )}

          {section === "insights" && (
            <section className="insights-layout">
              <div className="panel">
                <div className="panel-head">
                  <h3>Compare statements</h3>
                  <span className="panel-meta">POST /v1/statements/compare</span>
                </div>
                <div className="panel-body">
                  {readyStatements.length < 2 ? (
                    <div className="empty-state">
                      Need at least two ready statements in this Workspace to compare.
                    </div>
                  ) : (
                    <>
                      <div className="compare-pickers">
                        <label className="field">
                          <span>Statement A</span>
                          <select
                            value={compareA}
                            onChange={(e) => {
                              setCompareA(e.target.value);
                              setCompareResult(null);
                            }}
                          >
                            <option value="">Select…</option>
                            {readyStatements.map((s) => (
                              <option key={s.statementId} value={s.statementId}>
                                {statementLabel(s)}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="field">
                          <span>Statement B</span>
                          <select
                            value={compareB}
                            onChange={(e) => {
                              setCompareB(e.target.value);
                              setCompareResult(null);
                            }}
                          >
                            <option value="">Select…</option>
                            {readyStatements.map((s) => (
                              <option key={`b-${s.statementId}`} value={s.statementId}>
                                {statementLabel(s)}
                              </option>
                            ))}
                          </select>
                        </label>
                        <button
                          type="button"
                          className="btn"
                          disabled={busy || !compareA || !compareB}
                          onClick={() => void onCompareStatements()}
                        >
                          {busy ? "Comparing…" : "Compare"}
                        </button>
                      </div>
                      {compareError && (
                        <div className="error-banner">
                          <strong>{compareError}</strong>
                        </div>
                      )}
                      {compareResult && (
                        <div className="compare-results">
                          <div className="compare-sides">
                            <div className="compare-side">
                              <h4>{statementLabel(compareResult.a)}</h4>
                              <div className="summary-grid">
                                <div className="metric">
                                  <span>Income</span>
                                  <strong>
                                    {formatMoney(
                                      compareResult.a.totalIncome,
                                      compareResult.a.currency,
                                    )}
                                  </strong>
                                </div>
                                <div className="metric">
                                  <span>Expenses</span>
                                  <strong>
                                    {formatMoney(
                                      compareResult.a.totalExpenses,
                                      compareResult.a.currency,
                                    )}
                                  </strong>
                                </div>
                                <div className="metric">
                                  <span>Net</span>
                                  <strong>
                                    {formatMoney(
                                      compareResult.a.netBalance,
                                      compareResult.a.currency,
                                    )}
                                  </strong>
                                </div>
                              </div>
                            </div>
                            <div className="compare-side">
                              <h4>{statementLabel(compareResult.b)}</h4>
                              <div className="summary-grid">
                                <div className="metric">
                                  <span>Income</span>
                                  <strong>
                                    {formatMoney(
                                      compareResult.b.totalIncome,
                                      compareResult.b.currency,
                                    )}
                                  </strong>
                                </div>
                                <div className="metric">
                                  <span>Expenses</span>
                                  <strong>
                                    {formatMoney(
                                      compareResult.b.totalExpenses,
                                      compareResult.b.currency,
                                    )}
                                  </strong>
                                </div>
                                <div className="metric">
                                  <span>Net</span>
                                  <strong>
                                    {formatMoney(
                                      compareResult.b.netBalance,
                                      compareResult.b.currency,
                                    )}
                                  </strong>
                                </div>
                              </div>
                            </div>
                          </div>
                          <h4 className="subsection-title spaced">Deltas (B − A)</h4>
                          <div className="summary-grid">
                            <div className="metric">
                              <span>Income</span>
                              <strong
                                className={
                                  compareResult.deltas.totalIncome >= 0
                                    ? "delta-pos"
                                    : "delta-neg"
                                }
                              >
                                {formatDelta(
                                  compareResult.deltas.totalIncome,
                                  compareResult.b.currency,
                                )}
                              </strong>
                            </div>
                            <div className="metric">
                              <span>Expenses</span>
                              <strong
                                className={
                                  compareResult.deltas.totalExpenses >= 0
                                    ? "delta-pos"
                                    : "delta-neg"
                                }
                              >
                                {formatDelta(
                                  compareResult.deltas.totalExpenses,
                                  compareResult.b.currency,
                                )}
                              </strong>
                            </div>
                            <div className="metric">
                              <span>Net</span>
                              <strong
                                className={
                                  compareResult.deltas.netBalance >= 0 ? "delta-pos" : "delta-neg"
                                }
                              >
                                {formatDelta(
                                  compareResult.deltas.netBalance,
                                  compareResult.b.currency,
                                )}
                              </strong>
                            </div>
                          </div>
                          {compareResult.deltas.categories.length > 0 && (
                            <>
                              <h4 className="subsection-title spaced">Category deltas</h4>
                              <div className="table-wrap">
                                <table>
                                  <thead>
                                    <tr>
                                      <th>Category</th>
                                      <th>A</th>
                                      <th>B</th>
                                      <th>Δ</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {compareResult.deltas.categories.map((c) => (
                                      <tr key={c.category}>
                                        <td>{c.category}</td>
                                        <td>
                                          {formatMoney(c.amountA, compareResult.a.currency)}
                                        </td>
                                        <td>
                                          {formatMoney(c.amountB, compareResult.b.currency)}
                                        </td>
                                        <td
                                          className={
                                            c.delta >= 0 ? "delta-pos" : "delta-neg"
                                          }
                                        >
                                          {formatDelta(c.delta, compareResult.b.currency)}
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            </>
                          )}
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>

              <div className="panel">
                <div className="panel-head">
                  <h3>Category breakdown</h3>
                  <span className="panel-meta">GET /v1/statements/{"{id}"}/categories</span>
                </div>
                <div className="panel-body">
                  {readyStatements.length === 0 ? (
                    <div className="empty-state">
                      No ready statements yet. Upload a PDF or CSV and wait for analysis.
                    </div>
                  ) : (
                    <>
                      <div className="compare-pickers">
                        <label className="field">
                          <span>Statement</span>
                          <select
                            value={categoryStatementId}
                            onChange={(e) => {
                              setCategoryStatementId(e.target.value);
                              setCategoryBreakdown(null);
                            }}
                          >
                            <option value="">Select…</option>
                            {readyStatements.map((s) => (
                              <option key={`cat-${s.statementId}`} value={s.statementId}>
                                {statementLabel(s)}
                              </option>
                            ))}
                          </select>
                        </label>
                        <button
                          type="button"
                          className="btn"
                          disabled={busy || !categoryStatementId}
                          onClick={() => void onLoadCategories(categoryStatementId)}
                        >
                          {busy ? "Loading…" : "Load chart"}
                        </button>
                      </div>
                      {categoryError && (
                        <div className="error-banner">
                          <strong>{categoryError}</strong>
                        </div>
                      )}
                      {categoryBreakdown && (
                        <>
                          <p className="overview-meta">
                            {statementLabel(categoryBreakdown)}
                            {categoryBreakdown.currency
                              ? ` · ${categoryBreakdown.currency}`
                              : ""}
                            {" · "}
                            source: {categoryBreakdown.source}
                            {" · "}
                            total{" "}
                            {formatMoney(
                              categoryBreakdown.totalCategorized,
                              categoryBreakdown.currency,
                            )}
                          </p>
                          {categoryBreakdown.categories.length === 0 ? (
                            <div className="empty-state">No categories for this statement.</div>
                          ) : (
                            <div className="category-bars chart">
                              {categoryBreakdown.categories.map((c) => (
                                <div className="category-row" key={c.category}>
                                  <span>
                                    {c.category}
                                    {c.share !== undefined
                                      ? ` (${Math.round(c.share * 100)}%)`
                                      : ""}
                                  </span>
                                  <span>
                                    {formatMoney(c.amount, categoryBreakdown.currency)}
                                  </span>
                                  <div className="bar-track">
                                    <div
                                      className="bar-fill"
                                      style={{
                                        width:
                                          categoryMaxAmount > 0
                                            ? `${Math.round(
                                                (c.amount / categoryMaxAmount) * 100,
                                              )}%`
                                            : "0%",
                                      }}
                                    />
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                        </>
                      )}
                    </>
                  )}
                </div>
              </div>

              {failedInsights.length > 0 && (
                <div className="panel">
                  <div className="panel-head">
                    <h3>Failed analyses</h3>
                    <span className="panel-meta">{failedInsights.length} need attention</span>
                  </div>
                  <div className="panel-body failed-insights-list">
                    {failedInsights.map((row) => (
                      <div className="failed-insight-row" key={row.statementId}>
                        <div className="failed-insight-meta">
                          <strong>{statementLabel(row)}</strong>
                          <span className={`status-pill status-${row.status}`}>{row.status}</span>
                          <button
                            type="button"
                            className="btn btn-sm btn-ghost"
                            onClick={() => {
                              setSection("statements");
                              void openStatement(row.statementId);
                            }}
                          >
                            Open
                          </button>
                        </div>
                        {row.error ? (
                          <AnalysisErrorBanner error={row.error} />
                        ) : (
                          <div className="error-banner">
                            <strong>Analysis failed.</strong>
                            <p className="error-next">
                              <span className="error-next-label">Next step:</span> Upload the
                              statement again (PDF or CSV).
                            </p>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="insights-grid">
                {insightSummaries.length === 0 && failedInsights.length === 0 && (
                  <div className="panel">
                    <div className="panel-body">
                      <div className="empty-state">
                        No analyzed statements yet. Upload a PDF or CSV and wait for analysis to
                        finish.
                      </div>
                    </div>
                  </div>
                )}
                {insightSummaries.map((summary) => (
                  <div className="panel insight-card" key={summary.statementId}>
                    <div className="panel-head">
                      <h3>{summary.month ?? summary.statementId.slice(0, 8)}</h3>
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        onClick={() => {
                          setSection("dashboard");
                          void openStatement(summary.statementId);
                        }}
                      >
                        Open
                      </button>
                    </div>
                    <div className="panel-body">
                      <div className="summary-grid">
                        <div className="metric">
                          <span>Net</span>
                          <strong>{formatMoney(summary.netBalance, summary.currency)}</strong>
                        </div>
                        <div className="metric">
                          <span>Expenses</span>
                          <strong>
                            {formatMoney(summary.totalExpenses, summary.currency)}
                          </strong>
                        </div>
                      </div>
                      {summary.spendingInsights && summary.spendingInsights.length > 0 && (
                        <ul className="insights-list compact">
                          {summary.spendingInsights.slice(0, 2).map((i) => (
                            <li key={i}>{i}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {section === "api-keys" && (
            <section className="api-keys-layout">
              <div className="panel">
                <div className="panel-head">
                  <h3>Mint key</h3>
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={busy}
                    onClick={() => void onMintApiKey()}
                  >
                    {busy ? "Working…" : "Mint API key"}
                  </button>
                </div>
                <div className="panel-body">
                  <p className="api-keys-help">
                    Use the secret as <code>X-Api-Key</code> for MCP and agents. It is scoped to
                    your Workspace and cannot be recovered after you leave this page.
                  </p>
                  {mintedSecret && (
                    <div className="secret-reveal">
                      <strong>Copy this key now</strong>
                      <code className="secret-value">{mintedSecret.apiKey}</code>
                      <div className="secret-actions">
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => void copyText(mintedSecret.apiKey, "API key copied")}
                        >
                          Copy
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm btn-ghost"
                          onClick={() => setSection("mcp-setup")}
                        >
                          MCP setup
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm btn-ghost"
                          onClick={() => setMintedSecret(null)}
                        >
                          Dismiss
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              <div className="panel">
                <div className="panel-head">
                  <h3>Workspace keys</h3>
                  <span className="panel-meta">{apiKeys.length} keys</span>
                </div>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Prefix</th>
                        <th>Status</th>
                        <th>Created</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {apiKeys.length === 0 && (
                        <tr>
                          <td colSpan={4}>
                            <div className="empty-state">
                              No API keys yet — mint one for Cursor MCP or agent clients.
                            </div>
                          </td>
                        </tr>
                      )}
                      {apiKeys.map((key) => (
                        <tr key={key.keyId}>
                          <td>
                            <code>
                              {key.prefix}…
                            </code>
                          </td>
                          <td>
                            <span className={`status-pill status-${key.status === "active" ? "ready" : "failed"}`}>
                              {key.status}
                            </span>
                          </td>
                          <td>{new Date(key.createdAt).toLocaleString()}</td>
                          <td className="row-actions">
                            {key.status === "active" && (
                              <button
                                type="button"
                                className="btn btn-sm btn-danger"
                                disabled={busy}
                                onClick={() => void onRevokeApiKey(key.keyId)}
                              >
                                Revoke
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </section>
          )}

          {section === "mcp-setup" && (
            <section className="mcp-setup-layout">
              <div className="panel">
                <div className="panel-head">
                  <h3>Endpoint</h3>
                </div>
                <div className="panel-body">
                  <p className="api-keys-help">
                    Remote MCP URL from <code>NEXT_PUBLIC_FINLENS_API_URL</code>. The web bundle
                    never includes an API key — mint one under API keys and paste it into Cursor.
                  </p>
                  {!mcpUrl && (
                    <div className="error-banner">
                      Set NEXT_PUBLIC_FINLENS_API_URL before building the static export.
                    </div>
                  )}
                  {mcpUrl && (
                    <div className="mcp-endpoint-row">
                      <code className="secret-value">{mcpUrl}</code>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => void copyText(mcpUrl, "MCP URL copied")}
                      >
                        Copy URL
                      </button>
                    </div>
                  )}
                  {apiBaseUrl && (
                    <p className="mcp-meta">
                      REST base: <code>{apiBaseUrl}</code>
                    </p>
                  )}
                </div>
              </div>

              <div className="panel">
                <div className="panel-head">
                  <h3>Cursor MCP config</h3>
                  <div className="panel-head-actions">
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={!mcpConfigTemplate}
                      onClick={() =>
                        void copyText(mcpConfigTemplate, "Config copied — paste your API key")
                      }
                    >
                      Copy config
                    </button>
                  </div>
                </div>
                <div className="panel-body">
                  <ol className="mcp-steps">
                    <li>
                      Open{" "}
                      <button
                        type="button"
                        className="link-btn"
                        onClick={() => setSection("api-keys")}
                      >
                        API keys
                      </button>{" "}
                      and mint a Workspace key (copy the secret once).
                    </li>
                    <li>
                      Paste the JSON below into Cursor MCP settings, then replace{" "}
                      <code>{MCP_KEY_PLACEHOLDER}</code> with the minted key.
                    </li>
                    <li>Agents then share the same Workspace Statements as this dashboard.</li>
                  </ol>
                  {mcpConfigTemplate && (
                    <pre className="mcp-config-block">{mcpConfigTemplate}</pre>
                  )}
                  {mintedSecret && mcpUrl && (
                    <div className="secret-reveal">
                      <strong>One-time: copy config with this session’s minted key</strong>
                      <p className="api-keys-help">
                        Only available while the mint reveal is open. Closing dismisses the secret
                        from the page; it is never stored in the build.
                      </p>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() =>
                          void copyText(
                            buildMcpConfigJson(mcpUrl, mintedSecret.apiKey),
                            "Config with key copied",
                          )
                        }
                      >
                        Copy config with key
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </section>
          )}
        </main>
      </div>

      <input
        ref={fileInputRef}
        className="hidden-input"
        type="file"
        accept="application/pdf,.pdf,text/csv,.csv"
        disabled={busy}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) {
            void onUpload(file);
          }
          e.target.value = "";
        }}
      />
    </div>
  );
}
