import * as React from 'react';
import { cn } from '@/lib/utils';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'outline' | 'danger';
  size?: 'sm' | 'md' | 'lg' | 'icon';
  loading?: boolean;
}

const variantClasses: Record<NonNullable<ButtonProps['variant']>, string> = {
  primary:
    'bg-gradient-to-br from-indigo-500 via-purple-500 to-pink-500 text-white shadow-md hover:shadow-lg hover:opacity-95',
  secondary:
    'bg-foreground/10 text-foreground hover:bg-foreground/20 dark:bg-foreground/20 dark:hover:bg-foreground/30',
  ghost: 'bg-transparent hover:bg-foreground/10 dark:hover:bg-foreground/20',
  outline: 'border border-foreground/20 hover:bg-foreground/10 dark:hover:bg-foreground/20',
  danger:
    'bg-gradient-to-br from-rose-500 via-red-500 to-orange-500 text-white shadow-md hover:shadow-lg hover:brightness-110',
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
          'relative inline-flex items-center justify-center font-medium transition-colors outline-none focus-visible:ring-2 ring-offset-2 ring-offset-background ring-indigo-500 disabled:opacity-60 disabled:cursor-not-allowed select-none',
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
