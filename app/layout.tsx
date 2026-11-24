import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Tooling Tracker",
  description: "Feature, metric, and testing coverage for Enterprise Operations tools.",
  robots: { index: false, follow: false }
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
