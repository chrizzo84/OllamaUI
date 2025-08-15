'use client';
import { useEffect } from 'react';
import { useThemeStore, ThemeName } from '@/store/theme';
import { cn } from '@/lib/utils';

const THEMES: { value: ThemeName; label: string }[] = [
  { value: 'default', label: 'Default' },
  { value: 'dark-green', label: 'Dark Green' },
  { value: 'neon', label: 'Neon Purple' },
  { value: 'neon-orange', label: 'Neon Orange' },
];

export function ThemeSwitcher() {
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);
  const hydrate = useThemeStore((s) => s.hydrate);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="opacity-60">Theme</span>
      <div className="flex rounded-md overflow-hidden border border-white/10">
        {THEMES.map((t) => {
          const active = t.value === theme;
          return (
            <button
              key={t.value}
              onClick={() => setTheme(t.value)}
              className={cn(
                'px-2 py-1 transition-all relative font-medium',
                'bg-white/5 hover:bg-white/10 text-white/70 hover:text-white',
                active && 'bg-indigo-500/40 text-white shadow-inner',
              )}
              data-theme-option={t.value}
              type="button"
            >
              {t.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
