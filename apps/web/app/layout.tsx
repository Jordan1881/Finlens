import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Finlens",
  description: "Bank statement PDF analysis",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
