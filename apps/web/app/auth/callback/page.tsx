"use client";

import { useEffect, useState } from "react";
import { BrandMark } from "../../../components/BrandMark";
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
        <BrandMark variant="auth" />
        <h1>Finlens</h1>
        <p>{message}</p>
      </div>
    </main>
  );
}
