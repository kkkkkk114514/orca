import { expect, it } from 'vitest'
import { dshConfiguredModels, zcodeConfiguredModels } from './workflow-node-models'

it('lists DSH provider models and defaults without mixing providers or disabled plugins', () => {
  const models = dshConfiguredModels([
    {
      id: 'default',
      name: '@deepseek-ai/dsh-agent-default-model',
      disabled: false,
      config: { provider: 'plan', model: 'new-model' }
    },
    {
      id: 'pi',
      name: '@deepseek-ai/dsh-llm-pi-ai',
      disabled: false,
      config: {
        providers: {
          plan: {
            apiKey: 'must-not-leak',
            models: [{ id: 'new-model' }, { id: 'fast', name: 'Fast' }]
          },
          other: { models: [{ id: 'new-model' }], modelOverrides: { custom: { name: 'Custom' } } },
          disabled: { disabled: true, models: [{ id: 'hidden' }] }
        }
      }
    },
    {
      id: 'off',
      name: 'disabled-plugin',
      disabled: true,
      config: { providers: { off: { models: [{ id: 'hidden' }] } } }
    }
  ])
  expect(models).toEqual([
    { id: 'new-model', label: 'new-model', provider: 'plan' },
    { id: 'fast', label: 'Fast', provider: 'plan' },
    { id: 'new-model', label: 'new-model', provider: 'other' },
    { id: 'custom', label: 'Custom', provider: 'other' }
  ])
})

it('merges ZCode template and personal model declarations with provider and disabled-model overrides', () => {
  const builtin = {
    config: {
      providerConfigRules: {
        templateRules: [
          { templateId: 'template', config: { builtinModelIds: ['base', 'removed'] } }
        ],
        providerRules: [{ providerId: 'disabled', config: { builtinModelIds: ['hidden'] } }]
      },
      modelConfigRules: {
        templateModelRules: [
          { templateId: 'template', modelId: 'removed', config: { enabled: true } }
        ]
      }
    }
  }
  const personal = {
    config: {
      defaultModelSelection: { providerId: 'plan', modelId: 'configured-only' },
      providerConfigRules: {
        providerRules: [
          { providerId: 'disabled', enabled: false },
          { providerId: 'plan', templateId: 'template', config: { personalModelIds: ['custom'] } },
          { providerId: 'other', config: { personalModelIds: ['base'] } }
        ]
      },
      modelConfigRules: {
        providerModelRules: [
          { providerId: 'plan', modelId: 'removed', config: { enabled: false } }
        ],
        manualProviderModelRules: [
          { providerId: 'plan', modelId: 'custom', config: { properties: { name: 'Custom' } } }
        ]
      }
    }
  }
  expect(zcodeConfiguredModels(personal, builtin)).toEqual([
    { id: 'configured-only', label: 'configured-only', provider: 'plan' },
    { id: 'base', label: 'base', provider: 'plan' },
    { id: 'custom', label: 'Custom', provider: 'plan' },
    { id: 'base', label: 'base', provider: 'other' }
  ])
  expect(
    zcodeConfiguredModels(
      { config: { defaultModelSelection: { providerId: 'legacy', modelId: 'saved' } } },
      {}
    )
  ).toEqual([{ id: 'saved', label: 'saved', provider: 'legacy' }])
})
