import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Switch KPI — PCC ATEM Analytics",
  description: "Live source usage, transition analytics, awards and reports for ATEM ME1 and ME2.",
  icons: {
    icon: "/pcc-cogs.png",
    shortcut: "/pcc-cogs.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
