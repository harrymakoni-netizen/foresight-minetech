import type { Metadata } from "next";
import "./globals.css";
import "./foresight.css";

export const metadata: Metadata = {
  title: "Foresight MineTech Edition",
  description: "Foresight software preview — explainable simulator results, workforce accountability and incident management.",
  other: {
    "codex-preview": "development",
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
