import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Foresight",
  description:
    "Foresight mine safety — declared check-ins, overdue alerts, scenario planning and accountable incident records.",
  other: {
    "codex-preview": "development",
  },
  icons: {
    icon: [
      { url: "/brand/foresight-mark-32.png", sizes: "32x32", type: "image/png" },
      { url: "/brand/foresight-mark-192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: "/brand/apple-touch-icon.png",
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
