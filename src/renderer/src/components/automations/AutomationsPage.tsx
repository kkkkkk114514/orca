import { Suspense, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { translate } from '@/i18n/i18n'
import { lazyWithRetry } from '@/lib/lazy-with-retry'
import { useAppStore } from '@/store'
import { AutomationsPageSurface } from './AutomationsPageSurface'
import { useAutomationsPageController } from './use-automations-page-controller'
import { setAutomationWorkspaceView, useAutomationWorkspaceView } from './automation-workspace-view'

const WorkflowCanvasPage = lazyWithRetry(
  () => import('../workflow-canvas/WorkflowCanvasWorkspacePage')
)

function ScheduledAutomationsPage(): React.JSX.Element {
  const controller = useAutomationsPageController()
  return <AutomationsPageSurface controller={controller} />
}

export default function AutomationsPage(): React.JSX.Element {
  useTranslation()
  const view = useAutomationWorkspaceView()
  const pendingRun = useAppStore((state) => state.pendingAutomationRunNavigation)
  useEffect(() => {
    if (pendingRun) {
      setAutomationWorkspaceView('schedules')
    }
  }, [pendingRun])
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <div className="shrink-0 border-b px-4 py-2">
        <Tabs
          value={view}
          onValueChange={(value) => {
            if (value === 'schedules' || value === 'workflows') {
              setAutomationWorkspaceView(value)
            }
          }}
        >
          <TabsList>
            <TabsTrigger value="schedules">
              {translate('workflows.schedules', 'Schedules')}
            </TabsTrigger>
            <TabsTrigger value="workflows">{translate('workflows.nav', 'Workflows')}</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      <div className="min-h-0 flex-1">
        {view === 'workflows' && !pendingRun ? (
          <Suspense
            fallback={
              <div className="p-4 text-sm text-muted-foreground">
                {translate('workflows.loading', 'Loading canvas…')}
              </div>
            }
          >
            <WorkflowCanvasPage />
          </Suspense>
        ) : (
          <ScheduledAutomationsPage />
        )}
      </div>
    </div>
  )
}
