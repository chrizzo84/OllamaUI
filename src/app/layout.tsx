import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';
import { AppQueryProvider } from '@/components/query-provider';
import Link from 'next/link';
import { Toaster } from '@/components/toaster';

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
        <AppQueryProvider>
          <div className="mx-auto flex min-h-screen w-full max-w-7xl flex-col">
            <header className="sticky top-0 z-40 backdrop-blur supports-[backdrop-filter]:bg-white/5 border-b border-white/10 bg-white/5">
              <div className="flex h-14 items-center gap-6 px-6">
                <Link href="/" className="font-bold tracking-tight text-white/90 hover:text-white">
                  Ollama UI
                </Link>
                <nav className="flex items-center gap-4 text-sm text-white/60">
                  <Link href="/models" className="hover:text-white transition-colors">
                    Modelle
                  </Link>
                </nav>
                <div className="ml-auto text-[10px] uppercase tracking-wider text-white/30 hidden md:block">
                  Desktop Prototype
                </div>
              </div>
            </header>
            <main className="flex-1">{children}</main>
            <Toaster />
          </div>
        </AppQueryProvider>
      </body>
    </html>
  );
}
