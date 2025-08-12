'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { clsx } from 'clsx';

interface NavItem {
  href: string;
  label: string;
  match?: (pathname: string) => boolean;
}

const items: NavItem[] = [
  { href: '/', label: 'Dashboard', match: (p) => p === '/' },
  { href: '/chat', label: 'Chat', match: (p) => p.startsWith('/chat') },
  { href: '/models', label: 'Models', match: (p) => p.startsWith('/models') },
];

export function SiteNav() {
  const pathname = usePathname();
  return (
    <nav className="flex items-center gap-4 text-sm">
      {items.map((item) => {
        const active = item.match ? item.match(pathname) : pathname === item.href;
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={clsx(
              'transition-colors relative',
              active ? 'text-white font-semibold' : 'text-white/60 hover:text-white',
            )}
          >
            {item.label}
            {active && (
              <span className="absolute -bottom-1 left-0 right-0 h-px bg-gradient-to-r from-indigo-500 via-purple-500 to-pink-500" />
            )}
          </Link>
        );
      })}
    </nav>
  );
}
