import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { SecuritySurface } from '@/components/ui/security-surface'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { translate } from '@/i18n/i18n'
import {
  inheritedDshSecurity,
  type WorkflowNodeSecurity,
  type WorkflowSecurityCapabilities
} from '../../../../shared/workflow-node-security'
import {
  hasWorkflowNodeLaunch,
  type WorkflowNodeLaunch
} from '../../../../shared/workflow-node-launch'
import type { TuiAgent } from '../../../../shared/tui-agent'

function SecurityLines({
  id,
  label,
  values,
  placeholder,
  onChange
}: {
  id: string
  label: string
  values: string[]
  placeholder: string
  onChange(values: string[]): void
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Textarea
        key={JSON.stringify(values)}
        id={id}
        defaultValue={values.join('\n')}
        placeholder={placeholder}
        onBlur={(event) =>
          onChange([
            ...new Set(
              event.currentTarget.value
                .split('\n')
                .map((line) => line.trim())
                .filter(Boolean)
            )
          ])
        }
      />
    </div>
  )
}

export function WorkflowNodeSecurityFields({
  agent,
  value,
  capabilities,
  onChange
}: {
  agent: TuiAgent
  value: WorkflowNodeLaunch
  capabilities?: WorkflowSecurityCapabilities
  onChange(value: WorkflowNodeLaunch | undefined): void
}) {
  const security =
    value.security ?? (agent === 'dsh' ? inheritedDshSecurity(value.permission) : undefined) ?? {}
  const inherit = translate('workflows.inherit', 'Inherit CLI settings')
  const labels: Record<string, string> = {
    'read-only': translate('workflows.securityReadOnly', 'Read only'),
    'workspace-write': translate('workflows.securityWorkspaceWrite', 'Write in workspace'),
    'full-access': translate('workflows.securityFullAccess', 'Full filesystem access'),
    'on-request': translate('workflows.securityOnRequest', 'Ask when needed'),
    never: translate('workflows.securityNever', 'Never ask; deny actions requiring approval'),
    allow: translate('workflows.securityNetworkAllow', 'Allow'),
    restricted: translate('workflows.securityNetworkRestricted', 'Allow listed hosts only'),
    deny: translate('workflows.securityNetworkDeny', 'Deny')
  }
  const update = (next: WorkflowNodeSecurity) => {
    const active = Object.values(next).some((item) =>
      Array.isArray(item) ? item.length > 0 : Boolean(item)
    )
    const launch = { ...value, permission: undefined, security: active ? next : undefined }
    onChange(hasWorkflowNodeLaunch(launch) ? launch : undefined)
  }
  const policySelect = (
    key: 'access' | 'approval' | 'network',
    title: string,
    choices: readonly string[],
    disabled = false
  ) => (
    <div className="space-y-2">
      <Label htmlFor={`workflow-security-${key}`}>{title}</Label>
      <Select
        value={security[key] ?? '__inherit'}
        disabled={disabled || !choices.length}
        onValueChange={(choice) => {
          const next = { ...security, [key]: choice === '__inherit' ? undefined : choice }
          if (key === 'access' && choice !== 'workspace-write') {
            next.writableDirectories = undefined
            next.network = undefined
            next.allowedHosts = undefined
          }
          if (key === 'network' && choice !== 'restricted') {
            next.allowedHosts = undefined
          }
          update(next)
        }}
      >
        <SelectTrigger id={`workflow-security-${key}`} className="w-full min-w-0">
          <SelectValue className="min-w-0 flex-1">
            <span className="block min-w-0 truncate">{labels[security[key] ?? ''] ?? inherit}</span>
          </SelectValue>
        </SelectTrigger>
        <SecuritySurface>
          <SelectContent>
            <SelectItem value="__inherit">{inherit}</SelectItem>
            {choices.map((choice) => (
              <SelectItem key={choice} value={choice}>
                {labels[choice] ?? choice}
              </SelectItem>
            ))}
          </SelectContent>
        </SecuritySurface>
      </Select>
    </div>
  )
  return (
    <SecuritySurface>
      <div className="min-w-0 space-y-3" data-workflow-node-security>
        <h4 className="text-sm font-medium">
          {translate('workflows.nodeSecurity', 'Node permissions')}
        </h4>
        {(value.security || (value.permission && agent === 'dsh')) && (
          <Button variant="ghost" size="xs" onClick={() => update({})}>
            {translate('workflows.securityReset', 'Inherit CLI permissions')}
          </Button>
        )}
        {policySelect(
          'access',
          translate('workflows.securityAccess', 'Filesystem access'),
          capabilities?.access ?? []
        )}
        <p className="text-2xs text-muted-foreground">
          {translate(
            'workflows.securityAccessHint',
            'Controls writable paths for CLI tools. Read access, protected paths and temporary directories follow the CLI sandbox.'
          )}
        </p>
        {capabilities?.writableDirectories && security.access === 'workspace-write' && (
          <SecurityLines
            id="workflow-security-directories"
            label={translate('workflows.securityDirectories', 'Additional writable directories')}
            values={security.writableDirectories ?? []}
            placeholder={translate(
              'workflows.securityDirectoriesHint',
              'One absolute path per line, on the execution host'
            )}
            onChange={(writableDirectories) => update({ ...security, writableDirectories })}
          />
        )}
        {policySelect(
          'approval',
          translate('workflows.securityApproval', 'Approval policy'),
          capabilities?.approval ?? []
        )}
        {security.approval === 'on-request' && (
          <p className="text-2xs text-muted-foreground">
            {translate(
              'workflows.securityApprovalHint',
              'Uses the CLI approval channel. The canvas cannot answer headless approval requests yet; an unavailable approval channel rejects the action.'
            )}
          </p>
        )}
        {policySelect(
          'network',
          translate('workflows.securityNetwork', 'Command network access'),
          capabilities?.network ?? [],
          security.access !== 'workspace-write'
        )}
        <p className="text-2xs text-muted-foreground">
          {translate(
            'workflows.securityNetworkHint',
            'Explicit network policies require workspace-write access and affect sandboxed commands, not model connections, MCP servers or plugins.'
          )}
        </p>
        {security.network === 'restricted' && (
          <SecurityLines
            id="workflow-security-hosts"
            label={translate('workflows.securityHosts', 'Allowed hostnames')}
            values={security.allowedHosts ?? []}
            placeholder={translate(
              'workflows.securityHostsHint',
              'One hostname per line, for example registry.npmjs.org or *.example.com'
            )}
            onChange={(allowedHosts) => update({ ...security, allowedHosts })}
          />
        )}
        {(!capabilities ||
          !capabilities.access.length ||
          !capabilities.network.length ||
          !capabilities.writableDirectories) && (
          <p className="text-2xs text-muted-foreground">
            {translate(
              'workflows.securityUnavailable',
              'Disabled controls are not supported by this CLI or have not been confirmed by the execution host. Inherited settings remain in effect.'
            )}
          </p>
        )}
      </div>
    </SecuritySurface>
  )
}
