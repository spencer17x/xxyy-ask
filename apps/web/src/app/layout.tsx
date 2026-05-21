import "./globals.css";

export const metadata = {
  title: "Ask XXYY",
  description: "AI support assistant grounded in XXYY documentation."
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

