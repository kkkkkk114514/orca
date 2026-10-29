import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { useDetectedAgents, type AgentDetectionTarget } from '@/hooks/useDetectedAgents'
import { useAgentDetectionTargetForWorktree } from '@/hooks/useAgentDetectionTarget'
import { readHostAgentLaunchSettings } from '../settings/agent-launch-settings-transport'
import type { AgentLaunchSettings } from '../../../../shared/agent-launch-settings'
import { isTuiAgentEnabled } from '../../../../shared/tui-agent-selection'
import { getAgentCatalog } from '@/lib/agent-catalog'
import { translate } from '@/i18n/i18n'
import type { WorkflowExecutionTarget } from './WorkflowRunPanel'

type HostSettings = Pick<AgentLaunchSettings, 'disabledTuiAgents' | 'agentCmdOverrides'>

export function useWorkflowAgentInventory(target: WorkflowExecutionTarget | null) {
  const resolved = useAgentDetectionTargetForWorktree(target?.worktreeId ?? null)
  const environmentId = target?.target.kind === 'environment' ? target.target.environmentId : null
  const detectionTarget = useMemo((): AgentDetectionTarget | undefined => {
    if (!target) {
      return undefined
    }
    if (environmentId) {
      return { kind: 'runtime', environmentId, worktreeId: target.worktreeId }
    }
    return resolved?.kind === 'local' ? { ...resolved, worktreeId: target.worktreeId } : resolved
  }, [target, resolved, environmentId])
  const detection = useDetectedAgents(detectionTarget)
  const observed = useRef(new Set<string>())
  const detectionKey = JSON.stringify(detectionTarget)
  useEffect(() => {
    if (detectionKey) {
      observed.current.add(detectionKey)
    }
  }, [detectionKey])
  const localDetectionFailed =
    detectionTarget?.kind === 'local' &&
    detection.detectedIds === null &&
    !detection.isLoading &&
    !detection.isRefreshing &&
    Boolean(detectionKey && observed.current.has(detectionKey))
  const localDisabled = useAppStore((state) => state.settings?.disabledTuiAgents)
  const localCommands = useAppStore((state) => state.settings?.agentCmdOverrides)
  const localReady = useAppStore((state) => state.settings !== null)
  const pairingRevision = useAppStore((state) => {
    const environment = state.runtimeEnvironments.find((entry) => entry.id === environmentId)
    return environment ? (environment.pairingRevision ?? environment.createdAt) : undefined
  })
  const ownerKey = JSON.stringify([environmentId, pairingRevision])
  const [remote, setRemote] = useState<{
    key: string
    settings: HostSettings | null
    error: string
  } | null>(null)
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    if (!environmentId) {
      return
    }
    const controller = new AbortController()
    setRemote(null)
    void readHostAgentLaunchSettings({ environmentId, pairingRevision }, controller.signal).then(
      (settings) => {
        if (!controller.signal.aborted) {
          setRemote({
            key: ownerKey,
            settings,
            error: settings
              ? ''
              : translate(
                  'workflows.agentHostUpdate',
                  'Update the execution host to read its agent settings.'
                )
          })
        }
      },
      () => {
        if (!controller.signal.aborted) {
          setRemote({
            key: ownerKey,
            settings: null,
            error: translate(
              'workflows.agentSettingsFailed',
              'Cannot read agent settings from the execution host. Refresh to retry.'
            )
          })
        }
      }
    )
    return () => controller.abort()
  }, [environmentId, pairingRevision, ownerKey, revision])
  const remoteRead = remote?.key === ownerKey ? remote : null
  const settings: HostSettings | null = environmentId
    ? (remoteRead?.settings ?? null)
    : localReady
      ? { disabledTuiAgents: localDisabled ?? [], agentCmdOverrides: localCommands ?? {} }
      : null
  const error =
    environmentId && remoteRead?.error
      ? remoteRead.error
      : detection.needsServerUpdate
        ? translate(
            'workflows.agentHostUpdate',
            'Update the execution host to read its agent settings.'
          )
        : detection.detectionFailed || localDetectionFailed
          ? translate(
              'workflows.agentDetectionFailed',
              'Agent detection failed on the execution host. Refresh to retry.'
            )
          : ''
  const ready = Boolean(target && settings && detection.detectedIds !== null && !error)
  const detected = new Set(detection.detectedIds ?? [])
  const catalog = getAgentCatalog()
  const available = ready
    ? catalog.filter(
        (agent) =>
          detected.has(agent.id) && isTuiAgentEnabled(agent.id, settings?.disabledTuiAgents)
      )
    : []
  const refreshDetected = detection.refresh
  const refresh = useCallback(() => {
    setRevision((current) => current + 1)
    void refreshDetected().catch(() => {})
  }, [refreshDetected])
  return {
    available,
    detected,
    settings,
    ready,
    error,
    busy: Boolean(target && !error && (!ready || detection.isLoading || detection.isRefreshing)),
    refresh
  }
}
