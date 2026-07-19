import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';
import { AppQueryProvider } from '@/components/query-provider';
import { AppSidebar } from '@/components/app-sidebar';
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
        className={`${geistSans.variable} ${geistMono.variable} antialiased min-h-screen text-foreground`}
      >
        <AppQueryProvider>
          <div className="flex min-h-screen w-full">
            <AppSidebar />
            <div className="flex-1 min-w-0 flex flex-col">
              <main className="flex-1 min-h-0">{children}</main>
              <SiteFooter />
            </div>
          </div>
          <Toaster />
        </AppQueryProvider>
      </body>
    </html>
  );
}
