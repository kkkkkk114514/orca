import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { translate } from '@/i18n/i18n'

export function WorkflowNodeExtensionList({
  label,
  rows,
  selected,
  onChange
}: {
  label: string
  rows: { id: string; label: string }[]
  selected: string[]
  onChange(selected: string[]): void
}) {
  const all = [
    ...rows,
    ...selected.filter((id) => !rows.some((row) => row.id === id)).map((id) => ({ id, label: id }))
  ]
  return (
    <div className="space-y-2">
      <p className="text-xs font-medium">{label}</p>
      <div className="scrollbar-sleek max-h-40 space-y-2 overflow-y-auto rounded-md border p-2">
        {all.length ? (
          all.map((row) => (
            <Label key={row.id} className="flex items-start">
              <Checkbox
                aria-label={`${label}: ${row.label}`}
                checked={selected.includes(row.id)}
                onCheckedChange={(checked) =>
                  onChange(
                    checked === true
                      ? [...selected, row.id]
                      : selected.filter((id) => id !== row.id)
                  )
                }
              />
              <span className="min-w-0 break-all">
                {row.label}
                {!rows.some((item) => item.id === row.id) && (
                  <span className="block text-2xs text-destructive">
                    {translate(
                      'workflows.selectedExtensionMissing',
                      'Selected item is unavailable. Refresh or remove it before running.'
                    )}
                  </span>
                )}
              </span>
            </Label>
          ))
        ) : (
          <p className="text-2xs text-muted-foreground">
            {translate(
              'workflows.noNodeExtensions',
              'No installed items found on this execution host.'
            )}
          </p>
        )}
      </div>
    </div>
  )
}
