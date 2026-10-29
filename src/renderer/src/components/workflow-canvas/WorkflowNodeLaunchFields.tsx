import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SecuritySurface } from '@/components/ui/security-surface'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { translate } from '@/i18n/i18n'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { getAgentSessionOptionLaunchCatalog } from '../../../../shared/agent-session-option-launch'
import {
  hasWorkflowNodeLaunch,
  workflowLaunchSupport,
  workflowNodeOptionsSchema,
  type WorkflowNodeLaunch,
  type WorkflowNodeOptions
} from '../../../../shared/workflow-node-launch'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { WorkflowExecutionTarget } from './WorkflowRunPanel'
import { WorkflowNodeSecurityFields } from './WorkflowNodeSecurityFields'
import { WorkflowNodeExtensionList } from './WorkflowNodeExtensionList'

const emptyOptions: WorkflowNodeOptions = {
  models: [],
  profiles: [],
  plugins: [],
  mcpServers: [],
  skills: [],
  warnings: []
}
const inheritedLaunch: WorkflowNodeLaunch = {}

export function WorkflowNodeLaunchFields({
  agent,
  value = inheritedLaunch,
  target,
  onChange
}: {
  agent: TuiAgent
  value?: WorkflowNodeLaunch
  target: WorkflowExecutionTarget | null
  onChange(value: WorkflowNodeLaunch | undefined): void
}) {
  const [options, setOptions] = useState(emptyOptions)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const support = workflowLaunchSupport(agent)
  const profile = value.profile
  useEffect(() => {
    setOptions(emptyOptions)
    setError('')
    setBusy(false)
    if (!target) {
      return
    }
    const controller = new AbortController()
    setBusy(true)
    const timer = setTimeout(() => {
      void callRuntimeRpc<unknown>(
        target.target,
        'workflow.nodeOptions',
        { agent, worktree: `id:${target.worktreeId}`, profile },
        { signal: controller.signal }
      )
        .then((result) => {
          if (!controller.signal.aborted) {
            setOptions(workflowNodeOptionsSchema.parse(result))
          }
        })
        .catch(() => {
          if (!controller.signal.aborted) {
            setError(
              translate(
                'workflows.nodeOptionsError',
                'Cannot load CLI options. Check the execution host version, installation and profile.'
              )
            )
          }
        })
        .finally(() => {
          if (!controller.signal.aborted) {
            setBusy(false)
          }
        })
    }, 500)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [agent, profile, target, revision])

  const inherit = translate('workflows.inherit', 'Inherit CLI settings')
  const update = (key: keyof WorkflowNodeLaunch, selection: string | string[] | undefined) => {
    const next = { ...value, [key]: selection || undefined }
    onChange(hasWorkflowNodeLaunch(next) ? next : undefined)
  }
  const catalog = getAgentSessionOptionLaunchCatalog(agent)
  const model = catalog?.models.find((item) => item.id === value.model)
  const effort =
    model?.options.find((item) => item.id === 'effort') ??
    catalog?.unknownModelOptions?.find((item) => item.id === 'effort')
  const efforts =
    agent === 'dsh' || agent === 'zcode'
      ? ['low', 'medium', 'high']
      : effort?.kind.type === 'select'
        ? effort.kind.choices.map((choice) => choice.value)
        : []
  const selectionList = (
    key: 'plugins' | 'mcpServers' | 'skills',
    label: string,
    rows: { id: string; label: string }[]
  ) => (
    <WorkflowNodeExtensionList
      label={label}
      rows={rows}
      selected={value[key] ?? []}
      onChange={(selected) => update(key, selected)}
    />
  )
  return (
    <div className="space-y-4 border-t pt-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">
          {translate('workflows.nodeLaunch', 'Node launch settings')}
        </h3>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="xs"
            disabled={!target || busy}
            onClick={() => setRevision((previous) => previous + 1)}
          >
            {busy
              ? translate('workflows.loadingOptions', 'Loading…')
              : translate('workflows.refreshOptions', 'Refresh')}
          </Button>
          <Button variant="ghost" size="xs" onClick={() => onChange(undefined)}>
            {translate('workflows.resetNodeLaunch', 'Reset')}
          </Button>
        </div>
      </div>
      <p className="text-2xs text-muted-foreground">
        {translate(
          'workflows.nodeLaunchHint',
          'Overrides apply only to this node. Empty fields inherit the CLI configuration on the execution host.'
        )}
      </p>
      {support.extensions && (
        <div className="space-y-2">
          <Label htmlFor="workflow-node-profile">
            {agent === 'dsh'
              ? translate('workflows.cliProfile', 'CLI profile')
              : translate('workflows.providerConfigPath', 'Provider configuration file')}
          </Label>
          {agent === 'dsh' ? (
            <Select
              value={profile ?? '__inherit'}
              onValueChange={(next) => update('profile', next === '__inherit' ? undefined : next)}
            >
              <SelectTrigger id="workflow-node-profile" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__inherit">{inherit}</SelectItem>
                {[
                  ...new Set([
                    ...options.profiles.map((item) => item.id),
                    ...(profile ? [profile] : [])
                  ])
                ].map((id) => (
                  <SelectItem key={id} value={id}>
                    {id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <Input
              id="workflow-node-profile"
              value={profile ?? ''}
              placeholder={inherit}
              maxLength={512}
              onChange={(event) => update('profile', event.target.value)}
            />
          )}
        </div>
      )}
      <div className="space-y-2">
        <Label htmlFor="workflow-node-model">{translate('workflows.model', 'Model')}</Label>
        <Input
          id="workflow-node-model"
          value={value.model ?? ''}
          disabled={!support.model}
          list="workflow-node-models"
          placeholder={inherit}
          maxLength={512}
          onChange={(event) => update('model', event.target.value)}
        />
        <datalist id="workflow-node-models">
          {options.models.map((item) => (
            <option key={JSON.stringify([item.provider, item.id])} value={item.id}>
              {item.provider ? `${item.label} · ${item.provider}` : item.label}
            </option>
          ))}
        </datalist>
        {options.models.length > 0 && support.model && (
          <Select
            value="__inherit"
            onValueChange={(id) => {
              const selected = options.models.find(
                (item) => JSON.stringify([item.provider, item.id]) === id
              )
              if (selected) {
                onChange({
                  ...value,
                  model: selected.id,
                  provider: selected.provider,
                  effort: undefined
                })
              }
            }}
          >
            <SelectTrigger
              aria-label={translate('workflows.availableModels', 'CLI models')}
              className="w-full"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__inherit">
                {translate('workflows.availableModels', 'CLI models')}
              </SelectItem>
              {options.models.map((item) => (
                <SelectItem
                  key={JSON.stringify([item.provider, item.id])}
                  value={JSON.stringify([item.provider, item.id])}
                >
                  {item.provider ? `${item.label} · ${item.provider}` : item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <p className="text-2xs text-muted-foreground">
          {translate(
            'workflows.modelInventoryHint',
            'Models come from CLI configuration or discovery. You can also enter a model ID; the provider checks availability at runtime.'
          )}
        </p>
      </div>
      {support.extensions && (
        <div className="space-y-2">
          <Label htmlFor="workflow-node-provider">
            {translate('workflows.provider', 'Provider ID')}
          </Label>
          <Input
            id="workflow-node-provider"
            value={value.provider ?? ''}
            placeholder={options.models[0]?.provider ?? inherit}
            maxLength={512}
            onChange={(event) => update('provider', event.target.value)}
          />
        </div>
      )}
      <div className="space-y-2">
        <Label htmlFor="workflow-node-effort">
          {translate('workflows.reasoningEffort', 'Reasoning effort')}
        </Label>
        <Select
          disabled={!support.model || !efforts.length || (!support.extensions && !value.model)}
          value={value.effort ?? '__inherit'}
          onValueChange={(next) => update('effort', next === '__inherit' ? undefined : next)}
        >
          <SelectTrigger id="workflow-node-effort" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__inherit">{inherit}</SelectItem>
            {[...new Set([...efforts, ...(value.effort ? [value.effort] : [])])].map((id) => (
              <SelectItem key={id} value={id}>
                {id}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <WorkflowNodeSecurityFields
        agent={agent}
        value={value}
        capabilities={target && !busy ? options.securityCapabilities : undefined}
        onChange={onChange}
      />
      {agent !== 'dsh' && agent !== 'codex' && (
        <SecuritySurface>
          <div className="space-y-2">
            <Label htmlFor="workflow-node-permission">
              {translate('workflows.permissions', 'Permissions')}
            </Label>
            <Select
              disabled={!support.permissions.length}
              value={value.permission ?? '__inherit'}
              onValueChange={(next) =>
                update('permission', next === '__inherit' ? undefined : next)
              }
            >
              <SelectTrigger id="workflow-node-permission" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SecuritySurface>
                <SelectContent>
                  <SelectItem value="__inherit">{inherit}</SelectItem>
                  {support.permissions.map((id) => (
                    <SelectItem key={id} value={id}>
                      {id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </SecuritySurface>
            </Select>
            <p className="text-2xs text-muted-foreground">
              {support.permissions.length
                ? translate(
                    'workflows.nativePermissionHint',
                    'This is the CLI native mode. It is not an independent filesystem or network sandbox policy.'
                  )
                : translate(
                    'workflows.nativeSettingsUnsupported',
                    'Native permissions and extensions currently support DSH and ZCode headless nodes.'
                  )}
            </p>
          </div>
        </SecuritySurface>
      )}
      {support.extensions && (
        <>
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-medium">
              {translate('workflows.cliExtensions', 'CLI extensions')}
            </p>
          </div>
          <p className="text-2xs text-muted-foreground">
            {target
              ? translate(
                  'workflows.extensionHint',
                  'Selected plugins and MCP servers are additionally enabled. Existing CLI extensions stay inherited. Selected Skills are passed as explicit task instructions.'
                )
              : translate(
                  'workflows.chooseOptionsWorkspace',
                  'Select an execution workspace to load installed CLI plugins, Skills and MCP servers.'
                )}
          </p>
          {selectionList('plugins', translate('workflows.plugins', 'Plugins'), options.plugins)}
          {selectionList('mcpServers', 'MCP', options.mcpServers)}
          {selectionList('skills', 'Skills', options.skills)}
        </>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {options.warnings.length > 0 && (
        <p className="text-2xs text-muted-foreground">
          {translate(
            'workflows.nodeInventoryWarning',
            'Some CLI options could not be discovered. Check the installation, workspace runtime and profile, then refresh. Selected settings are validated again before launch.'
          )}
        </p>
      )}
    </div>
  )
}
