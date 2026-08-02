import type { ReactNode } from "react";

/** Shared primitives for the recorder setup panels. */

export interface SegmentedOption<T extends string | number> {
  value: T;
  label: ReactNode;
  title?: string;
}

export function SegmentedControl<T extends string | number>({
  value,
  options,
  onChange,
  disabled = false,
}: {
  value: T;
  options: readonly SegmentedOption<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <div className="inline-flex gap-0.5 p-0.5 rounded-lg bg-muted border border-border">
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={String(option.value)}
            type="button"
            title={option.title}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
              active
                ? "bg-card text-foreground shadow-sm border border-border"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export function ToggleChip({
  active,
  onToggle,
  activeIcon: ActiveIcon,
  inactiveIcon: InactiveIcon,
  label,
  disabled = false,
}: {
  active: boolean;
  onToggle: () => void;
  activeIcon: React.ElementType;
  inactiveIcon: React.ElementType;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled}
      title={label}
      className={`group relative flex items-center gap-2 px-3.5 py-2 rounded-lg text-sm font-medium border transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
        active
          ? "bg-secondary text-foreground border-foreground/15 shadow-sm"
          : "bg-transparent text-muted-foreground border-border hover:bg-accent hover:text-foreground"
      }`}
    >
      {active ? <ActiveIcon size={15} /> : <InactiveIcon size={15} />}
      {label}
    </button>
  );
}

export function SettingsPanel({
  icon: Icon,
  title,
  hint,
  children,
}: {
  icon: React.ElementType;
  title: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-border bg-card px-4 py-3.5">
      <header className="flex items-center gap-2 mb-3">
        <Icon size={14} className="text-muted-foreground" />
        <h3 className="text-[11px] font-semibold tracking-[0.08em] uppercase text-muted-foreground">
          {title}
        </h3>
        {hint && (
          <span className="ml-auto text-[11px] text-muted-foreground">{hint}</span>
        )}
      </header>
      {children}
    </section>
  );
}
