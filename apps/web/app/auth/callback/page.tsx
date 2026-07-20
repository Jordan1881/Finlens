"use client";

import { useEffect, useState } from "react";
import { completeLoginFromCallback } from "../../../lib/auth";

export default function AuthCallbackPage() {
  const [message, setMessage] = useState("Completing sign-in…");

  useEffect(() => {
    const url = new URL(window.location.href);
    void completeLoginFromCallback(url)
      .then(() => {
        window.location.replace("/");
      })
      .catch((error) => {
        setMessage(error instanceof Error ? error.message : String(error));
      });
  }, []);

  return (
    <main className="auth-screen">
      <div className="auth-card">
        <div className="brand-mark auth-brand">F</div>
        <h1>Finlens</h1>
        <p>{message}</p>
      </div>
    </main>
  );
}
