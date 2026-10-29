import { useId, useState } from 'react'
import { Check, ChevronsUpDown, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { getAgentLabel } from '@/lib/agent-catalog'
import { AgentTypeIcon } from '@/lib/agent-type-icon'
import { translate } from '@/i18n/i18n'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { WorkflowExecutionTarget } from './WorkflowRunPanel'
import { useWorkflowAgentInventory } from './use-workflow-agent-inventory'
import { isTuiAgentEnabled } from '../../../../shared/tui-agent-selection'

export function WorkflowAgentPicker({
  value,
  target,
  onChange
}: {
  value: TuiAgent
  target: WorkflowExecutionTarget | null
  onChange(agent: TuiAgent): void
}) {
  const [open, setOpen] = useState(false)
  const id = useId()
  const inventory = useWorkflowAgentInventory(target)
  const unavailable = inventory.ready && !inventory.available.some((agent) => agent.id === value)
  const reason = !isTuiAgentEnabled(value, inventory.settings?.disabledTuiAgents)
    ? translate('workflows.agentDisabled', 'Disabled on this host')
    : translate('workflows.agentUndetected', 'Not detected on this host')
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{translate('workflows.agent', 'Agent')}</Label>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            id={id}
            variant="outline"
            role="combobox"
            aria-expanded={open}
            className="w-full justify-between"
            disabled={!target}
          >
            <span className="flex min-w-0 items-center gap-2">
              <AgentTypeIcon agentType={value} size={16} />
              <span className="truncate">{getAgentLabel(value)}</span>
            </span>
            <ChevronsUpDown />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-80 max-w-[calc(100vw-2rem)]" align="start">
          <div className="mb-2 flex items-center gap-2">
            <span
              className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
              title={target?.label}
            >
              {target?.label}
            </span>
            <Button
              variant="ghost"
              size="icon-xs"
              disabled={inventory.busy}
              aria-label={translate('workflows.refreshAgents', 'Refresh agents')}
              onClick={inventory.refresh}
            >
              <RefreshCw />
            </Button>
          </div>
          <Command>
            <CommandInput placeholder={translate('workflows.searchAgents', 'Search agents…')} />
            <CommandList>
              {inventory.busy ? (
                <p role="status" className="p-3 text-xs text-muted-foreground">
                  {translate('workflows.agentsLoading', 'Reading agents from the execution host…')}
                </p>
              ) : (
                <>
                  <CommandEmpty>
                    {inventory.error ||
                      translate(
                        'workflows.noReadyAgents',
                        'No detected and enabled agents. Check Settings → Agents, then refresh.'
                      )}
                  </CommandEmpty>
                  {inventory.available.map((agent) => (
                    <CommandItem
                      key={agent.id}
                      value={`${agent.label} ${agent.cmd}`}
                      keywords={[inventory.settings?.agentCmdOverrides[agent.id] ?? '']}
                      onSelect={() => {
                        if (agent.id !== value) {
                          onChange(agent.id)
                        }
                        setOpen(false)
                      }}
                    >
                      <AgentTypeIcon agentType={agent.id} size={16} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{agent.label}</span>
                        <span className="block truncate font-mono text-2xs text-muted-foreground">
                          {inventory.settings?.agentCmdOverrides[agent.id] || agent.cmd}
                        </span>
                      </span>
                      {agent.id === value && <Check className="size-4" />}
                    </CommandItem>
                  ))}
                  {unavailable && (
                    <CommandItem disabled value={`${getAgentLabel(value)} ${reason}`}>
                      <span className="min-w-0 flex-1 truncate">{getAgentLabel(value)}</span>
                      <span className="text-2xs">{reason}</span>
                    </CommandItem>
                  )}
                </>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {!target ? (
        <p className="text-2xs text-muted-foreground">
          {translate(
            'workflows.selectWorkspace',
            'Select a workspace in the sidebar to run this workflow.'
          )}
        </p>
      ) : (
        <p className="text-2xs text-muted-foreground">
          {translate(
            'workflows.agentInventoryHint',
            'Lists detected and enabled agents on this workspace’s host. Uses their saved CLI configuration; sign-in is checked by the CLI.'
          )}
        </p>
      )}
      {unavailable && (
        <p role="status" className="text-xs text-muted-foreground">
          {translate(
            'workflows.agentUnavailable',
            'Saved agent is unavailable: {{reason}}. Select an available agent or update its host settings.',
            { reason }
          )}
        </p>
      )}
      {inventory.error && (
        <p role="alert" className="text-xs text-destructive">
          {inventory.error}
        </p>
      )}
    </div>
  )
}
