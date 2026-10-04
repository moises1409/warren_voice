import { cn } from '@/lib/shadcn/utils';

const TONES = {
  neutral: 'bg-muted text-muted-foreground',
  info: 'bg-info/12 text-info',
  success: 'bg-success/12 text-success',
  warning: 'bg-warning/15 text-warning',
  danger: 'bg-danger/12 text-danger',
};

interface BadgeProps {
  tone?: keyof typeof TONES;
  className?: string;
  children: React.ReactNode;
}

export function Badge({ tone = 'neutral', className, children }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        TONES[tone],
        className
      )}
    >
      {children}
    </span>
  );
}
