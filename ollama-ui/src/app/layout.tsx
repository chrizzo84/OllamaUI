import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';
import { AppQueryProvider } from '@/components/query-provider';
import Link from 'next/link';
import Image from 'next/image';
import { SiteNav } from '@/components/site-nav';
import { HostIndicator } from '@/components/header-brand';
import { Toaster } from '@/components/toaster';
import { SiteFooter } from '@/components/site-footer';

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
  icons: {
    icon: '/ollama-ui.ico',
    shortcut: '/ollama-ui.ico',
    apple: '/ollama-ui.ico',
  },
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

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning data-theme="default">
      <head>
        {/* Early inline theme setter to prevent FOUC (reads localStorage BEFORE React hydration) */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(() => {try {var t = localStorage.getItem('ollama_ui_theme'); if (t) { document.documentElement.dataset.theme = t; }} catch(e) { /* ignore */ }} )();`,
          }}
        />
        <noscript>
          <style>{`:root{color-scheme: dark;}`}</style>
        </noscript>
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased min-h-screen bg-gradient-to-br from-[#0d0f17] via-[#141b2d] to-[#1d1329] text-foreground selection:bg-indigo-500/40 selection:text-white`}
      >
        <AppQueryProvider>
          <div className="mx-auto flex min-h-screen w-full max-w-7xl flex-col">
            <header className="sticky top-0 z-40 backdrop-blur supports-[backdrop-filter]:bg-white/5 border-b border-white/10 bg-white/5">
              <div className="flex h-14 items-center gap-6 px-6">
                <Link
                  href="/"
                  className="flex items-center gap-2 font-semibold tracking-tight text-white/90 hover:text-white"
                >
                  <Image
                    src="/ollama-ui.ico"
                    alt="Logo"
                    width={24}
                    height={24}
                    className="h-6 w-6"
                    priority
                  />
                  <span>Ollama UI</span>
                </Link>
                <SiteNav />
                <div className="ml-auto flex items-center gap-4">
                  <HostIndicator />
                </div>
              </div>
            </header>
            <main className="flex-1">{children}</main>
            <SiteFooter />
            <Toaster />
          </div>
        </AppQueryProvider>
      </body>
    </html>
  );
}
