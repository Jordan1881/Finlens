"use client";

import { useCallback, useEffect, useState } from "react";

const API_URL = process.env.NEXT_PUBLIC_FINLENS_API_URL ?? "";
const API_KEY = process.env.NEXT_PUBLIC_FINLENS_API_KEY ?? "";

type StatementRow = {
  statementId: string;
  status: string;
  createdAt: string;
  month?: string;
};

type StatementDetail = StatementRow & {
  financialSummary?: string;
  insights?: string[];
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      "X-Api-Key": API_KEY,
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    throw new Error(await res.text());
  }
  return res.json() as Promise<T>;
}

export default function HomePage() {
  const [statements, setStatements] = useState<StatementRow[]>([]);
  const [selected, setSelected] = useState<StatementDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const data = await api<{ statements: StatementRow[] }>("/v1/statements");
    setStatements(data.statements ?? []);
  }, []);

  useEffect(() => {
    load().catch((e) => setError(String(e)));
  }, [load]);

  async function onUpload(file: File) {
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
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function openStatement(id: string) {
    setBusy(true);
    setError(null);
    try {
      const data = await api<StatementDetail>(`/v1/statements/${id}?detail=summary`);
      setSelected(data);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <h1>Finlens</h1>
      <p className="sub">Upload bank statement PDFs · Hebrew & English · AI summary</p>

      <div className="card">
        <h2>Upload PDF</h2>
        <input
          type="file"
          accept="application/pdf,.pdf"
          disabled={busy}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) {
              void onUpload(file);
            }
          }}
        />
      </div>

      {error && (
        <div className="card">
          <strong>Error</strong>
          <pre>{error}</pre>
        </div>
      )}

      <div className="card">
        <h2>Recent statements</h2>
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Status</th>
              <th>Month</th>
              <th>Created</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {statements.map((s) => (
              <tr key={s.statementId}>
                <td>{s.statementId.slice(0, 8)}…</td>
                <td className={`status-${s.status}`}>{s.status}</td>
                <td>{s.month ?? "—"}</td>
                <td>{new Date(s.createdAt).toLocaleString()}</td>
                <td>
                  <button type="button" disabled={busy} onClick={() => void openStatement(s.statementId)}>
                    View
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {selected && (
        <div className="card">
          <h2>Summary · {selected.statementId.slice(0, 8)}…</h2>
          {selected.financialSummary && <pre>{selected.financialSummary}</pre>}
          {selected.insights && selected.insights.length > 0 && (
            <ul>
              {selected.insights.map((i) => (
                <li key={i}>{i}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </main>
  );
}
