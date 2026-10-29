import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { translate } from '@/i18n/i18n'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import {
  workflowStoragePreviewSchema,
  type WorkflowStorageRequest
} from '../../../../shared/workflow-run-storage'
import type { z } from 'zod'

export function WorkflowStorageDialog({
  binding
}: {
  binding: { id: string; target: RuntimeClientTarget }
}) {
  const [open, setOpen] = useState(false)
  const [category, setCategory] = useState<WorkflowStorageRequest['category']>('logs')
  const [preview, setPreview] = useState<z.infer<typeof workflowStoragePreviewSchema> | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const request = async (confirmation?: string) => {
    if (busy) {
      return
    }
    setBusy(true)
    setError('')
    try {
      const result = workflowStoragePreviewSchema.parse(
        await callRuntimeRpc(binding.target, 'workflow.storage', {
          id: binding.id,
          category,
          ...(confirmation ? { confirmation } : {})
        })
      )
      setPreview(result)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
      setPreview(null)
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <div className="px-4 pb-2">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setOpen(true)
            setPreview(null)
            setError('')
          }}
        >
          {translate('workflows.manageRecords', 'Manage run records')}
        </Button>
      </div>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!busy) {
            setOpen(value)
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{translate('workflows.manageRecords', 'Manage run records')}</DialogTitle>
            <DialogDescription>
              {translate(
                'workflows.cleanupHint',
                'Preview and permanently clear this run’s public logs or managed attachments. Reports, recovery metadata, project files and CLI conversations are retained. Automatic cleanup is off.'
              )}
            </DialogDescription>
          </DialogHeader>
          <Select
            value={category}
            disabled={busy}
            onValueChange={(value) => {
              if (value === 'logs' || value === 'artifacts' || value === 'all') {
                setCategory(value)
                setPreview(null)
                setError('')
              }
            }}
          >
            <SelectTrigger aria-label={translate('workflows.cleanupCategory', 'Record category')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="logs">
                {translate('workflows.cleanupLogs', 'Public logs and activity')}
              </SelectItem>
              <SelectItem value="artifacts">
                {translate('workflows.cleanupArtifacts', 'Managed test attachments')}
              </SelectItem>
              <SelectItem value="all">
                {translate('workflows.cleanupBoth', 'Logs and attachments')}
              </SelectItem>
            </SelectContent>
          </Select>
          {preview && (
            <p role="status" className="text-xs text-muted-foreground">
              {preview.deleted === undefined
                ? translate('workflows.cleanupPreview', '{{files}} files · {{bytes}} bytes', {
                    files: preview.files,
                    bytes: preview.bytes
                  })
                : translate(
                    'workflows.cleanupResult',
                    '{{deleted}} files deleted; {{errors}} errors.',
                    {
                      deleted: preview.deleted,
                      errors: preview.errorCount ?? preview.errors?.length ?? 0
                    }
                  )}
            </p>
          )}
          {preview?.errors?.map((message) => (
            <p key={message} className="text-xs text-destructive">
              {message}
            </p>
          ))}
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
          <DialogFooter className="flex-wrap sm:flex-wrap">
            <Button variant="ghost" disabled={busy} onClick={() => setOpen(false)}>
              {translate('common.cancel', 'Cancel')}
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                void request()
              }}
            >
              {translate('workflows.previewCleanup', 'Preview cleanup')}
            </Button>
            <Button
              variant="destructive"
              disabled={
                busy || !preview?.canClear || preview.files === 0 || preview.deleted !== undefined
              }
              onClick={() => {
                if (preview) {
                  void request(preview.confirmation)
                }
              }}
            >
              {translate('workflows.clearSelected', 'Permanently clear')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
