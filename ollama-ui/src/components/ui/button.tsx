import * as React from 'react';
import { cn } from '@/lib/utils';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'outline' | 'danger';
  size?: 'sm' | 'md' | 'lg' | 'icon';
  loading?: boolean;
}

const variantClasses: Record<NonNullable<ButtonProps['variant']>, string> = {
  primary:
    // Harmonize with page background gradient (#0d0f17 -> #141b2d -> #1d1329) but brighter for contrast
    'bg-gradient-to-br from-[#2a3244] via-[#3b4258] to-[#4c2b5e] text-white shadow-sm hover:shadow-md hover:brightness-110 hover:-translate-y-[1px] border border-white/5 hover:border-white/15',
  secondary:
    'bg-white/5 text-white/80 hover:text-white hover:bg-white/10 dark:bg-white/10 dark:hover:bg-white/15 hover:-translate-y-[1px] border border-white/10',
  // Make ghost clearly visible on hover with subtle background + outline highlight.
  ghost:
    'bg-transparent text-white/80 hover:text-white hover:bg-white/10 hover:ring-1 hover:ring-white/25 dark:hover:bg-white/10 hover:-translate-y-[1px]',
  // Outline: stronger border + background tint on hover.
  outline:
    'border border-white/15 text-white/80 hover:text-white hover:border-white/40 hover:bg-white/10 dark:hover:bg-white/10 hover:-translate-y-[1px]',
  danger:
    'relative text-white shadow-md hover:shadow-lg hover:-translate-y-[1px] bg-gradient-to-br from-rose-500 via-red-500 to-orange-500 hover:brightness-110',
};

const sizeClasses: Record<NonNullable<ButtonProps['size']>, string> = {
  sm: 'h-8 px-3 text-xs rounded-md',
  md: 'h-10 px-4 text-sm rounded-md',
  lg: 'h-12 px-6 text-base rounded-lg',
  icon: 'h-10 w-10 rounded-md',
};

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'primary', size = 'md', disabled, loading, children, ...props }, ref) => {
    return (
      <button
        ref={ref}
        data-variant={variant}
        data-size={size}
        disabled={disabled || loading}
        className={cn(
          'relative inline-flex items-center justify-center font-medium transition-all duration-150 outline-none focus-visible:ring-2 ring-offset-2 ring-offset-background ring-indigo-500 disabled:opacity-60 disabled:cursor-not-allowed select-none will-change-transform',
          variantClasses[variant],
          sizeClasses[size],
          className,
        )}
        {...props}
      >
        {loading && (
          <span className="absolute left-2 inline-flex h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
        )}
        <span className={cn(loading && 'opacity-0')}>{children}</span>
      </button>
    );
  },
);
Button.displayName = 'Button';
