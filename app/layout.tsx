import type { Metadata, Viewport } from "next";
import { Sora, Manrope } from "next/font/google";
import "./globals.css";

const display = Sora({
  subsets: ["latin"],
  variable: "--font-display",
  display: "swap",
});

const body = Manrope({
  subsets: ["latin"],
  variable: "--font-body",
  display: "swap",
});

export const metadata: Metadata = {
  title: "KenBot — a friendly AI companion",
  description:
    "Chat with KenBot, a warm and patient AI companion that helps you think things through.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#04050d",
  // On phones the layout resizes when the keyboard opens, so the input
  // stays visible without any JavaScript tricks.
  interactiveWidget: "resizes-content",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable}`}>
      <body>
        <div className="space" aria-hidden="true">
          <i className="planet" />
          <i className="stars" />
        </div>
        {children}
      </body>
    </html>
  );
}
