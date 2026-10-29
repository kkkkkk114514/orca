import type { WorkflowNodeOptions } from '../../../shared/workflow-node-launch'
import { object, type DshPlugin } from './workflow-node-inventory'

type Model = WorkflowNodeOptions['models'][number]
const text = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined
const rows = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.map(object) : []

function add(models: Model[], id: unknown, provider?: string, label?: unknown) {
  const model = text(id)
  if (model && !models.some((entry) => entry.id === model && entry.provider === provider)) {
    models.push({ id: model, label: text(label) ?? model, ...(provider ? { provider } : {}) })
  }
}

export function dshConfiguredModels(plugins: DshPlugin[]): Model[] {
  const models: Model[] = []
  for (const plugin of plugins.filter((entry) => !entry.disabled)) {
    if (plugin.name === '@deepseek-ai/dsh-agent-default-model') {
      add(models, plugin.config.model, text(plugin.config.provider))
    }
    for (const [provider, value] of Object.entries(object(plugin.config.providers))) {
      const config = object(value)
      if (config.enabled === false || config.disabled === true) {
        continue
      }
      for (const model of rows(config.models)) {
        add(models, model.id, provider, model.name)
      }
      for (const [id, value] of Object.entries(object(config.modelOverrides))) {
        add(models, id, provider, object(value).name)
      }
    }
  }
  return models
}

export function zcodeConfiguredModels(personal: unknown, builtin: unknown): Model[] {
  const models: Model[] = []
  const config = object(object(personal).config)
  const base = object(object(builtin).config)
  const baseProviders = object(base.providerConfigRules)
  const personalProviders = object(config.providerConfigRules)
  const defaultModel = object(config.defaultModelSelection)
  const defaultProvider = text(defaultModel.providerId)
  const configuredProviders = new Set([
    ...rows(personalProviders.providerRules).map((row) => text(row.providerId)),
    defaultProvider
  ])
  const providers = new Map<string, Record<string, unknown>>()
  for (const row of [
    ...rows(baseProviders.providerRules).filter((row) =>
      configuredProviders.has(text(row.providerId))
    ),
    ...rows(personalProviders.providerRules)
  ]) {
    const id = text(row.providerId)
    if (id) {
      const previous = providers.get(id)
      providers.set(id, {
        ...previous,
        ...row,
        config: { ...object(previous?.config), ...object(row.config) }
      })
    }
  }
  if (defaultProvider && !providers.has(defaultProvider)) {
    providers.set(defaultProvider, { providerId: defaultProvider })
  }
  const baseModels = object(base.modelConfigRules)
  const personalModels = object(config.modelConfigRules)
  for (const [provider, row] of providers) {
    if (row.enabled === false) {
      continue
    }
    const template = rows(baseProviders.templateRules).find(
      (item) => item.templateId === row.templateId
    )
    const declaration = { ...object(template?.config), ...object(row.config) }
    const rules = [
      ...rows(baseModels.templateModelRules).filter(
        (item) => row.templateId && item.templateId === row.templateId
      ),
      ...rows(baseModels.builtinProviderModelRules).filter((item) => item.providerId === provider),
      ...rows(personalModels.providerModelRules).filter((item) => item.providerId === provider),
      ...rows(personalModels.manualProviderModelRules).filter(
        (item) => item.providerId === provider
      )
    ]
    const candidates = [
      ...(provider === defaultProvider ? [defaultModel.modelId] : []),
      ...(Array.isArray(declaration.builtinModelIds) ? declaration.builtinModelIds : []),
      ...(Array.isArray(declaration.personalModelIds) ? declaration.personalModelIds : []),
      ...rules.map((rule) => rule.modelId)
    ]
    for (const id of candidates) {
      const applied = rules
        .filter((rule) => rule.modelId === id)
        .reduce<Record<string, unknown>>(
          (state, rule) => ({ ...state, ...object(rule.config) }),
          {}
        )
      if (applied.enabled !== false) {
        add(models, id, provider, object(applied.properties).name)
      }
    }
  }
  return models
}
