import type { Project, RuntimeStatus } from "../../shared/types";
import { Archive, ArrowLeft, ArrowRight, Folder, MoreHorizontal, Plus, Settings } from "lucide-react";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";

interface ProjectSidebarProps {
  projects: Project[];
  activeProjectId: string | null;
  runtimes: Record<string, RuntimeStatus>;
  collapsed: boolean;
  onSelect(projectId: string): void;
  onManage(projectId: string): void;
  onAdd(): void;
  onSettings(): void;
  onCollapsedChange(collapsed: boolean): void;
}

interface ProjectEntryProps {
  project: Project;
  active: boolean;
  status: RuntimeStatus["status"];
  collapsed: boolean;
  onOpen(): void;
  onManage(): void;
}

function ProjectEntry({ project, active, status, collapsed, onOpen, onManage }: ProjectEntryProps) {
  const statusClass = status === "running"
    ? "bg-emerald-400 shadow-[0_0_0_3px_color-mix(in_oklch,var(--color-emerald-400),transparent_85%)]"
    : status === "failed"
      ? "bg-destructive shadow-[0_0_0_3px_color-mix(in_oklch,var(--destructive),transparent_82%)]"
      : "bg-muted-foreground/60";

  return (
    <div className={cn("grid h-9 min-w-0 items-center rounded-lg", collapsed ? "grid-cols-1" : "grid-cols-[minmax(0,1fr)_28px]", active && "bg-sidebar-accent text-sidebar-accent-foreground", project.archived && "opacity-60")}>
      <Button aria-label={collapsed ? `Open ${project.name}` : undefined} className={cn("h-9 min-w-0 gap-2.5 font-normal", collapsed ? "px-0" : "justify-start px-2.5")} onClick={onOpen} title={collapsed ? project.name : undefined} type="button" variant="ghost">
        <span className="relative shrink-0" aria-hidden="true">
          <Folder className={cn("size-4", active && "fill-current")} />
          <span className={cn("absolute -right-1 -bottom-1 size-1.5 rounded-full", statusClass)} />
        </span>
        {!collapsed && <span className="truncate text-xs">{project.name}</span>}
      </Button>
      {!collapsed && <Button
        aria-label={`Manage ${project.name}`}
        className="text-muted-foreground"
        onClick={onManage}
        size="icon-sm"
        title={`Manage ${project.name}`}
        type="button"
        variant="ghost"
      >
        <MoreHorizontal />
      </Button>}
    </div>
  );
}

export function ProjectSidebar({
  projects,
  activeProjectId,
  runtimes,
  collapsed,
  onSelect,
  onManage,
  onAdd,
  onSettings,
  onCollapsedChange,
}: ProjectSidebarProps) {
  const activeProjects = projects.filter((project) => !project.archived);
  const archivedProjects = projects.filter((project) => project.archived);

  return (
    <aside className="flex min-w-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
      <div className={cn("flex h-11 shrink-0 items-center border-b border-sidebar-border p-2", collapsed ? "justify-center" : "justify-between")}>
        {!collapsed && <span className="px-1 text-xs font-semibold">Projects</span>}
        <Button aria-label={collapsed ? "Expand project sidebar" : "Collapse project sidebar"} onClick={() => onCollapsedChange(!collapsed)} size="icon-sm" title={collapsed ? "Expand project sidebar" : "Collapse project sidebar"} type="button" variant="ghost">
          {collapsed ? <ArrowRight /> : <ArrowLeft />}
        </Button>
      </div>
      <nav className={cn("min-h-0 flex-1 overflow-y-auto", collapsed ? "p-1.5" : "p-2.5")} aria-label="Projects">
        <div className="grid gap-0.5">
          {activeProjects.map((project) => (
            <ProjectEntry
              active={activeProjectId === project.id}
              collapsed={collapsed}
              key={project.id}
              onManage={() => onManage(project.id)}
              onOpen={() => onSelect(project.id)}
              project={project}
              status={runtimes[project.id]?.status ?? "stopped"}
            />
          ))}
        </div>
        {activeProjects.length === 0 && !collapsed && <p className="px-2.5 py-5 text-xs text-muted-foreground">No active projects</p>}

        {archivedProjects.length > 0 && !collapsed && (
          <div className="mt-4 border-t border-sidebar-border pt-3">
            <div className="flex items-center gap-1.5 px-2.5 pb-2 text-[10px] font-semibold tracking-wider text-muted-foreground uppercase"><Archive className="size-3" /> Archived</div>
            <div className="grid gap-0.5">
              {archivedProjects.map((project) => (
                <ProjectEntry
                  active={false}
                  collapsed={false}
                  key={project.id}
                  onManage={() => onManage(project.id)}
                  onOpen={() => onManage(project.id)}
                  project={project}
                  status="stopped"
                />
              ))}
            </div>
          </div>
        )}
      </nav>

      <div className={cn("grid gap-1 border-t border-sidebar-border", collapsed ? "p-1.5" : "p-2.5")}>
        <Button aria-label={collapsed ? "Add Project" : undefined} className={cn("text-primary", !collapsed && "justify-start")} onClick={onAdd} title={collapsed ? "Add Project" : undefined} type="button" variant="ghost">
          <Plus /> {!collapsed && "Add Project"}
        </Button>
        <Button aria-label={collapsed ? "Settings" : undefined} className={cn("text-muted-foreground", !collapsed && "justify-start")} onClick={onSettings} title={collapsed ? "Settings" : undefined} type="button" variant="ghost">
          <Settings /> {!collapsed && "Settings"}
        </Button>
      </div>
    </aside>
  );
}
