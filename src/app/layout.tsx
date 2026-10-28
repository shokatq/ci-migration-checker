import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "CI Migration Checker",
  description:
    "Check how ready your GitHub Actions workflows are to move to GitLab CI, and get a starter .gitlab-ci.yml.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen font-sans">{children}</body>
    </html>
  );
}
