"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, apiConfigured } from "../lib/api";
import {
  beginLogin,
  beginLogout,
  isAuthenticated,
  isCognitoConfigured,
} from "../lib/auth";

const POLL_MS = 15_000;

type Section = "dashboard" | "statements" | "insights";

type StatementRow = {
  statementId: string;
  status: string;
  createdAt: string;
  month?: string | null;
  sourceFormat?: "pdf" | "csv";
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
  error?: { message: string; nextStep?: string; code?: string };
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

      {selected.error && (
        <div className="error-banner">
          <strong>{selected.error.message}</strong>
          {selected.error.nextStep && <p className="error-next">{selected.error.nextStep}</p>}
        </div>
      )}

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
        <div className="error-banner">Analysis failed. Upload the statement again.</div>
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
  const [busy, setBusy] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [authed, setAuthed] = useState(false);
  const [authReady, setAuthReady] = useState(false);
  const [loginBusy, setLoginBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const data = await api<{ statements: StatementRow[] }>("/v1/statements");
    setStatements(data.statements ?? []);
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
    if (ready.length === 0) {
      setInsightSummaries([]);
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const summaries = await Promise.all(
          ready.map((s) =>
            api<StatementDetail>(`/v1/statements/${s.statementId}?detail=summary`),
          ),
        );
        if (!cancelled) {
          setInsightSummaries(summaries);
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
      await load();
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
    );
  }

  const sectionTitle =
    section === "dashboard"
      ? "Dashboard"
      : section === "statements"
        ? "Statements"
        : "Insights";

  const sectionSubtitle =
    section === "dashboard"
      ? "Overview of your uploaded statements and spending insights."
      : section === "statements"
        ? "Browse uploads, open summaries, and track processing status."
        : "Highlights from analyzed statements.";

  if (!authReady) {
    return (
      <main className="auth-screen">
        <div className="auth-card">
          <div className="brand-mark auth-brand">F</div>
          <h1>Finlens</h1>
          <p>Loading…</p>
        </div>
      </main>
    );
  }

  if (!authed) {
    return (
      <main className="auth-screen">
        <div className="auth-card">
          <div className="brand-mark auth-brand">F</div>
          <h1>Finlens</h1>
          <p>Sign in with Cognito to open your personal Workspace.</p>
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
            className="btn"
            disabled={loginBusy || !isCognitoConfigured()}
            onClick={() => {
              setLoginBusy(true);
              void beginLogin().catch((e) => {
                setLoginBusy(false);
                setError(e instanceof Error ? e.message : String(e));
              });
            }}
          >
            {loginBusy ? "Redirecting…" : "Sign in"}
          </button>
          {error && <div className="error-banner">{error}</div>}
        </div>
      </main>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">F</div>
          <div>
            <h1>Finlens</h1>
            <p>Finance dashboard</p>
          </div>
        </div>

        <div>
          <div className="nav-section-label">Main</div>
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
          </nav>
        </div>

        <div className="sidebar-promo">
          <strong>PDF & CSV supported</strong>
          <p>Upload bank exports in Hebrew or English for AI-powered summaries.</p>
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
          <div className="page-title-block">
            <h2>{sectionTitle}</h2>
            <p>{sectionSubtitle}</p>
          </div>

          {error && <div className="error-banner">{error}</div>}
          {initialLoading && <div className="info-banner processing">Loading statements…</div>}

          {section === "dashboard" && (
            <>
              <section className="stats-grid">
                <div className="stat-card">
                  <div className="stat-icon blue">
                    <IconStatements />
                  </div>
                  <div className="stat-body">
                    <div className="stat-label">Total statements</div>
                    <div className="stat-value">{stats.total}</div>
                    <div className="stat-meta">All uploads</div>
                  </div>
                </div>
                <div className="stat-card">
                  <div className="stat-icon green">
                    <IconDashboard />
                  </div>
                  <div className="stat-body">
                    <div className="stat-label">Ready</div>
                    <div className="stat-value">{stats.ready}</div>
                    <div className="stat-meta">Analysis complete</div>
                  </div>
                </div>
                <div className="stat-card">
                  <div className="stat-icon orange">
                    <IconUpload />
                  </div>
                  <div className="stat-body">
                    <div className="stat-label">In progress</div>
                    <div className="stat-value">{stats.processing}</div>
                    <div className="stat-meta">Processing pipeline</div>
                  </div>
                </div>
                <div className="stat-card">
                  <div className="stat-icon purple">
                    <IconInsights />
                  </div>
                  <div className="stat-body">
                    <div className="stat-label">Failed</div>
                    <div className="stat-value">{stats.failed}</div>
                    <div className="stat-meta">Needs re-upload</div>
                  </div>
                </div>
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
            </>
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
            <section className="insights-grid">
              {insightSummaries.length === 0 && (
                <div className="panel">
                  <div className="panel-body">
                    <div className="empty-state">
                      No analyzed statements yet. Upload a PDF or CSV and wait for analysis to finish.
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
                        <strong>{formatMoney(summary.totalExpenses, summary.currency)}</strong>
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
