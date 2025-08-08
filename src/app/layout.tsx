import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';
import { AppQueryProvider } from '@/components/query-provider';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  title: {
    default: 'Ollama UI',
    template: '%s | Ollama UI',
  },
  description: 'A fancy & cool desktop-first interface.',
  metadataBase: new URL('https://example.com'),
  openGraph: {
    title: 'Ollama UI',
    description: 'A fancy & cool desktop-first interface.',
    type: 'website',
    url: 'https://example.com',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Ollama UI',
    description: 'A fancy & cool desktop-first interface.',
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased min-h-screen bg-gradient-to-br from-[#0d0f17] via-[#141b2d] to-[#1d1329] text-foreground selection:bg-indigo-500/40 selection:text-white`}
      >
        <AppQueryProvider>{children}</AppQueryProvider>
      </body>
    </html>
  );
}
