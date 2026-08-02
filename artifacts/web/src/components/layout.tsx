import { Link, useLocation } from "wouter";
import {
  Video,
  LayoutGrid,
  Sun,
  Moon,
  MonitorPlay,
  Star,
  Archive,
  Settings2,
  ChevronDown,
  Search,
  Bell,
  Layers,
} from "lucide-react";
import { useTheme } from "./theme-provider";

// Nav item
function NavItem({
  href,
  icon: Icon,
  label,
  active = false,
  disabled = false,
  onClick,
}: {
  href?: string;
  icon: React.ElementType;
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}) {
  const cls = [
    "group relative flex items-center gap-2.5 pl-3.5 pr-3 py-2 rounded-md text-[13px] transition-colors w-full text-left",
    disabled
      ? "text-muted-foreground/40 cursor-not-allowed"
      : active
        ? "text-foreground font-medium bg-accent"
        : "text-sidebar-foreground font-medium hover:bg-accent/60 hover:text-foreground",
  ].join(" ");

  const inner = (
    <>
      {active && !disabled && (
        <span className="absolute left-0 top-1/2 -translate-y-1/2 h-4 w-0.5 rounded-full bg-primary" />
      )}
      <Icon size={15} className={active && !disabled ? "text-foreground" : ""} />
      {label}
    </>
  );

  if (disabled) {
    return <div className={cls}>{inner}</div>;
  }

  if (href) {
    return (
      <Link href={href} className={cls} onClick={onClick}>
        {inner}
      </Link>
    );
  }

  return (
    <button className={cls} onClick={onClick}>
      {inner}
    </button>
  );
}

// Layout
export function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { theme, setTheme } = useTheme();

  const isLibrary = location.startsWith("/library") || location.startsWith("/watch");
  const isAllVideos = location.startsWith("/all");
  const isRecorder = location === "/";

  return (
    <div className="bg-aurora flex h-screen text-foreground overflow-hidden">
      {/* Sidebar */}
      <aside className="w-[224px] shrink-0 bg-sidebar border-r border-sidebar-border flex flex-col">
        {/* Logo */}
        <div className="px-5 pt-6 pb-5 flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-md bg-primary flex items-center justify-center text-primary-foreground">
            <MonitorPlay size={15} strokeWidth={2.25} />
          </div>
          <span className="font-semibold text-[15px] tracking-tight">Demo Builder</span>
        </div>

        {/* Workspace selector */}
        <div className="px-3 mb-4">
          <button className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg border border-border hover:bg-accent transition-colors text-left">
            <div className="w-6 h-6 rounded-md bg-secondary text-secondary-foreground flex items-center justify-center font-semibold text-[10px] shrink-0">
              SC
            </div>
            <span className="flex-1 text-[12.5px] font-medium truncate">
              My Workspace
            </span>
            <ChevronDown size={13} className="text-muted-foreground shrink-0" />
          </button>
        </div>

        {/* Nav */}
        <nav className="flex-1 overflow-y-auto scroll-slim px-3 space-y-1">
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/80 px-3 py-1 mt-1">
            Libraries
          </p>

          <NavItem
            href="/library"
            icon={LayoutGrid}
            label="My Library"
            active={isLibrary}
          />
          <NavItem href="/all" icon={Layers} label="All Videos" active={isAllVideos} />

          <div className="my-3 h-px bg-border" />

          <NavItem href="/" icon={Video} label="Recorder" active={isRecorder} />

          <div className="my-3 h-px bg-border" />

          <NavItem icon={Star} label="Starred" disabled />
          <NavItem icon={Archive} label="Archives" disabled />
        </nav>

        {/* Bottom */}
        <div className="px-3 py-3 border-t border-sidebar-border/60 space-y-1">
          <NavItem icon={Settings2} label="Settings" disabled />
          <NavItem
            icon={theme === "dark" ? Sun : Moon}
            label={theme === "dark" ? "Light Mode" : "Dark Mode"}
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          />
        </div>
      </aside>

      {/* Main */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Top bar */}
        <header className="h-14 border-b border-border bg-background flex items-center justify-between px-5 shrink-0 gap-3">
          <button className="group flex items-center gap-2 h-9 w-full max-w-xs rounded-lg border border-border bg-card px-3 text-muted-foreground hover:border-foreground/20 transition-colors">
            <Search size={14} />
            <span className="text-[13px]">Search recordings...</span>
            <kbd className="ml-auto text-[10px] font-mono px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
              ⌘K
            </kbd>
          </button>
          <div className="flex items-center gap-1.5">
            <button className="relative w-9 h-9 flex items-center justify-center rounded-lg hover:bg-accent transition-colors text-muted-foreground hover:text-foreground">
              <Bell size={16} />
              <span className="absolute top-2.5 right-2.5 w-1.5 h-1.5 rounded-full bg-[hsl(var(--record))]" />
            </button>
            <div className="w-8 h-8 rounded-full bg-secondary text-secondary-foreground flex items-center justify-center text-[11px] font-semibold select-none">
              ME
            </div>
          </div>
        </header>

        {/* Page content */}
        <main className="flex-1 overflow-y-auto scroll-slim">
          <div className="h-full flex flex-col">{children}</div>
        </main>
      </div>
    </div>
  );
}
