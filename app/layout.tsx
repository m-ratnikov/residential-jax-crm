import type { Metadata } from "next";

import { AppHeader } from "@/components/AppHeader";
import "./globals.css";

export const metadata: Metadata = {
  title: "Duval Acquisitions CRM",
  description:
    "Map based residential property acquisition CRM for Jacksonville and Duval County, Florida, driven by the continuous Duval County Oracle pipeline.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <AppHeader />
        <main className="mx-auto w-full max-w-[1800px] px-4 pb-10 pt-4">{children}</main>
      </body>
    </html>
  );
}
