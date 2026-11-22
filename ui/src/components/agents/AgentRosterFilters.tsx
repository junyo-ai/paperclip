import { useCallback, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Filter } from "lucide-react";
import type { Agent } from "@paperclipai/shared";
import { aiConnectionsApi } from "@/api/ai-connections";
import { agentRosterFilterFields, buildAgentRosterIndex, emptyAgentRosterFilters, matchesAgentRosterFilters, type AgentRosterFilterField, type AgentRosterFilters as FilterState, type AgentRosterOption } from "@/lib/agent-roster-filters";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { NativeSelect } from "@/components/ui/select";
import { useTranslation } from "@/i18n";

const emptyAgents: Agent[] = [];
/** Page-owned state keeps filters when switching views and isolates them by company. */
export function useAgentRosterFilters(companyId: string | null, agents: Agent[] = emptyAgents) {
  const [selection, setSelection] = useState({ companyId, filters: emptyAgentRosterFilters });
  const filters = selection.companyId === companyId ? selection.filters : emptyAgentRosterFilters;
  const accounts = useQuery({ queryKey: ["ai-connections", companyId], queryFn: () => aiConnectionsApi.list(companyId!), enabled: !!companyId });
  const index = useMemo(() => buildAgentRosterIndex(agents, accounts.data), [agents, accounts.data]);
  const activeCount = agentRosterFilterFields.filter(field => filters[field]).length;
  const matches = useCallback((agent: Agent) => matchesAgentRosterFilters(index.byAgentId.get(agent.id), filters), [index, filters]);
  return {
    filters, options: index.options, activeCount,
    onChange: (next: FilterState) => setSelection({ companyId, filters: next }),
    matches,
    connectionError: accounts.error,
    retryConnections: () => void accounts.refetch(),
  };
}

export function AgentRosterFilters({ filters, options, onChange, activeCount, count, connectionError, retryConnections, compact = false }: {
  filters: FilterState;
  options: Record<AgentRosterFilterField, AgentRosterOption[]>;
  onChange: (filters: FilterState) => void;
  activeCount: number;
  count: number;
  compact?: boolean;
  connectionError?: unknown;
  retryConnections: () => void;
}) {
  const { t } = useTranslation();
  const labels: Record<AgentRosterFilterField, string> = { model: t("common.model", { defaultValue: "Model" }), status: t("common.status", { defaultValue: "Status" }), harness: t("common.harness", { defaultValue: "Harness" }), connection: t("common.connection", { defaultValue: "Connection" }) };
  const allLabels: Record<AgentRosterFilterField, string> = { model: t("roster.filters.all.model", { defaultValue: "All models" }), status: t("roster.filters.all.status", { defaultValue: "All statuses" }), harness: t("roster.filters.all.harness", { defaultValue: "All harnesses" }), connection: t("roster.filters.all.connection", { defaultValue: "All connections" }) };
  return <div data-canonical-toolbar="agent-filters" role="toolbar" aria-label={t("roster.filters.toolbar.aria", { defaultValue: "Agent filters" })} className={cn("flex flex-wrap items-center gap-3", !compact && "justify-between")}>
    <Popover>
      <PopoverTrigger asChild>
        <Button variant={compact ? "outline" : "ghost"} size="icon" aria-label={t("roster.filters.button.aria", { defaultValue: "Filter agents" })} title={activeCount ? t("roster.filters.activeTitle", { n: activeCount, defaultValue: "Filters: {{n}}" }) : t("roster.filters.button.aria", { defaultValue: "Filter agents" })}
          className={cn("relative shrink-0", compact && "design-toolbar-icon", activeCount > 0 && "text-blue-600 dark:text-blue-400")}>
          <Filter className="size-3.5" aria-hidden />
          {activeCount > 0 && <span aria-hidden className="absolute -right-1 -top-1 flex size-3.5 items-center justify-center rounded-full bg-blue-600 text-(length:--text-nano) font-bold text-white">{activeCount}</span>}
        </Button>
      </PopoverTrigger>
      <PopoverContent aria-label={t("roster.filters.panel.aria", { defaultValue: "Agent filter choices" })} align="start" className="max-h-96 w-72 space-y-3 overflow-y-auto p-3">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">{t("roster.filters.title", { defaultValue: "Filters" })}</span>
          {activeCount > 0 && <Button variant="ghost" size="sm" onClick={() => onChange(emptyAgentRosterFilters)}>{t("roster.filters.clear", { defaultValue: "Clear filters" })}</Button>}
        </div>
        {agentRosterFilterFields.map(field => <label key={field} className="block space-y-1 text-xs font-medium text-muted-foreground">
          <span>{labels[field]}</span>
          <NativeSelect aria-label={labels[field]} value={filters[field]} onChange={event => onChange({ ...filters, [field]: event.target.value })}
            className="h-11 text-base md:text-sm">
            <option value="">{allLabels[field]}</option>
            {filters[field] && !options[field].some(option => option.value === filters[field]) && <option value={filters[field]}>{t("roster.filters.previouslySelected", { label: labels[field].toLowerCase(), defaultValue: "Previously selected {{label}}" })}</option>}
            {options[field].map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
          </NativeSelect>
        </label>)}
      </PopoverContent>
    </Popover>
    {!compact && <span className="text-xs text-muted-foreground">{count === 1 ? t("roster.count.one", { n: count, defaultValue: "{{n}} agent" }) : t("roster.count.other", { n: count, defaultValue: "{{n}} agents" })}</span>}
    {!!connectionError && <p role="alert" className="basis-full text-xs text-destructive">{t("roster.filters.connectionError", { defaultValue: "Connection names couldn’t be loaded." })} <Button variant="link" size="sm" onClick={retryConnections}>{t("common.retry", { defaultValue: "Retry" })}</Button></p>}
  </div>;
}
