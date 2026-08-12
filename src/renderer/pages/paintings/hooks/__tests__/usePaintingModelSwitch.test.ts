import { prefetch } from '@data/hooks/useDataApi'
import type { FileEntry } from '@shared/data/types/file'
import {
  type ImageGenerationSupport,
  type ImageModeDef,
  MODALITY,
  type Model,
  MODEL_CAPABILITY
} from '@shared/data/types/model'
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { PaintingData } from '../../model/types/paintingData'
import type { ModelOption } from '../../model/types/paintingModel'
import { usePaintingModelSwitch } from '../usePaintingModelSwitch'

vi.mock('@renderer/hooks/useModel', () => ({
  useModels: () => ({ models: [] })
}))

const generateSupport = (supports: ImageModeDef['supports']): ImageGenerationSupport => ({
  modes: { generate: { supports }, edit: { supports } }
})

const makeModel = (providerId: string, apiModelId: string, acceptsImages: boolean): Model =>
  ({
    id: `${providerId}:${apiModelId}`,
    providerId,
    apiModelId,
    name: apiModelId,
    capabilities: [MODEL_CAPABILITY.IMAGE_GENERATION],
    inputModalities: acceptsImages ? [MODALITY.TEXT, MODALITY.IMAGE] : [MODALITY.TEXT],
    isEnabled: true,
    isHidden: false
  }) as Model

const makeOption = (model: Model): ModelOption => ({
  label: model.name,
  value: model.apiModelId ?? model.id,
  raw: model
})

const inputFile = { id: 'fe-1', name: 'fe-1.png', ext: 'png', size: 100 } as unknown as FileEntry

const painting: PaintingData = {
  id: 'p1',
  providerId: 'alpha',
  model: 'flux-1',
  mode: 'edit',
  prompt: 'a cat',
  files: [],
  inputFiles: [inputFile],
  params: { size: '1664x928', styleType: 'anime' }
}

/** Support blocks keyed by `${providerId}/${modelId}`; anything else is unknown. */
function mockSupport(byProviderModel: Record<string, ImageGenerationSupport>): void {
  vi.mocked(prefetch).mockImplementation(async (_path: unknown, options?: unknown) => {
    const params = (options as { params?: { providerId?: string; modelId?: string } } | undefined)?.params
    return (byProviderModel[`${params?.providerId}/${params?.modelId}`] ?? null) as never
  })
}

const sizeAndStyle = generateSupport({
  size: { type: 'enum', options: ['1024x1024', '1664x928'], default: '1024x1024', render: 'chips' },
  styleType: { type: 'enum', options: ['anime', 'realistic'], default: 'anime', render: 'chips' }
})

function renderSwitch(catalog: ModelOption[]) {
  const onPaintingChange = vi.fn()
  const ensureProviderCatalog = vi.fn(async () => catalog)
  const { result } = renderHook(() => usePaintingModelSwitch({ painting, onPaintingChange, ensureProviderCatalog }))
  return { switchModel: result.current, onPaintingChange, ensureProviderCatalog }
}

describe('usePaintingModelSwitch cross-provider switch', () => {
  beforeEach(() => {
    vi.mocked(prefetch).mockReset()
  })

  it('keeps params, edit mode and input images when re-sourcing the same model from another provider', async () => {
    mockSupport({ 'alpha/flux-1': sizeAndStyle, 'beta/flux-1': sizeAndStyle })
    const { switchModel, onPaintingChange } = renderSwitch([makeOption(makeModel('beta', 'flux-1', true))])

    await act(async () => {
      await switchModel({ providerId: 'beta', modelId: 'flux-1' })
    })

    const patch = onPaintingChange.mock.calls[0][0] as Partial<PaintingData>
    expect(patch.providerId).toBe('beta')
    expect(patch.model).toBe('flux-1')
    expect(patch.params).toMatchObject({ size: '1664x928', styleType: 'anime' })
    expect(patch.mode).toBeUndefined()
    expect(patch).not.toHaveProperty('inputFiles')
  })

  it('drops values the target provider rejects instead of carrying an illegal request over', async () => {
    mockSupport({
      'alpha/flux-1': sizeAndStyle,
      // Same model id, narrower block on the target provider: no styleType at
      // all and the carried size is not offered.
      'beta/flux-1': generateSupport({
        size: { type: 'enum', options: ['1024x1024'], default: '1024x1024', render: 'chips' }
      })
    })
    const { switchModel, onPaintingChange } = renderSwitch([makeOption(makeModel('beta', 'flux-1', true))])

    await act(async () => {
      await switchModel({ providerId: 'beta', modelId: 'flux-1' })
    })

    const patch = onPaintingChange.mock.calls[0][0] as Partial<PaintingData>
    // `styleType` must be present-and-undefined: the merge into painting.params
    // is a spread, so an absent key would leave the stale value in place.
    expect(patch.params).toStrictEqual({ size: '1024x1024', styleType: undefined })
  })

  it('clears input images and falls back to generate mode for a generate-only target model', async () => {
    mockSupport({ 'alpha/flux-1': sizeAndStyle, 'beta/sd-3': sizeAndStyle })
    const { switchModel, onPaintingChange } = renderSwitch([makeOption(makeModel('beta', 'sd-3', false))])

    await act(async () => {
      await switchModel({ providerId: 'beta', modelId: 'sd-3' })
    })

    const patch = onPaintingChange.mock.calls[0][0] as Partial<PaintingData>
    expect(patch.mode).toBe('generate')
    expect(patch.inputFiles).toEqual([])
    expect(patch.model).toBe('sd-3')
    // Losing edit mode must not also cost the still-valid size the user picked.
    expect(patch.params).toMatchObject({ size: '1664x928' })
  })

  it('resets to a clean draft when the target model is absent from the provider catalog', async () => {
    mockSupport({ 'alpha/flux-1': sizeAndStyle })
    const { switchModel, onPaintingChange } = renderSwitch([makeOption(makeModel('beta', 'other-model', true))])

    await act(async () => {
      await switchModel({ providerId: 'beta', modelId: 'unknown-model' })
    })

    const patch = onPaintingChange.mock.calls[0][0] as Partial<PaintingData>
    expect(patch.params).toEqual({})
    expect(patch.mode).toBe('generate')
    expect(patch.inputFiles).toEqual([])
    expect(patch.id).toBe('p1')
    expect(patch.prompt).toBe('a cat')
  })

  it('leaves the painting untouched when the target catalog fails to load', async () => {
    const onPaintingChange = vi.fn()
    const ensureProviderCatalog = vi.fn(async () => {
      throw new Error('db down')
    })
    const { result } = renderHook(() => usePaintingModelSwitch({ painting, onPaintingChange, ensureProviderCatalog }))

    await act(async () => {
      await result.current({ providerId: 'beta', modelId: 'flux-1' })
    })

    expect(onPaintingChange).not.toHaveBeenCalled()
  })
})
