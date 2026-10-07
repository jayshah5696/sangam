// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest'
import { EXPLANATION_TEMPLATES, interactiveExplanationsStore } from './interactiveExplanations'

class MemoryStorage {
  data = new Map<string, string>()
  getItem(key: string) {
    return this.data.get(key) ?? null
  }
  setItem(key: string, value: string) {
    this.data.set(key, String(value))
  }
  removeItem(key: string) {
    this.data.delete(key)
  }
  clear() {
    this.data.clear()
  }
}

describe('interactiveExplanationsStore', () => {
  beforeEach(async () => {
    Object.defineProperty(window, 'localStorage', { value: new MemoryStorage(), configurable: true })
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: { request: async (_name: string, callback: () => void) => callback() },
    })
    await interactiveExplanationsStore.clear()
  })

  it('provides pre-defined templates for calculators, timelines, and comparisons', () => {
    expect(EXPLANATION_TEMPLATES.calculator.defaultTitle).toContain('Calculator')
    expect(EXPLANATION_TEMPLATES.comparison.sampleHtml).toContain('table')
    expect(EXPLANATION_TEMPLATES.timeline.sampleHtml).toContain('timeline')
  })

  it('adds, retrieves, and updates interactive explanations for a document', async () => {
    const item = await interactiveExplanationsStore.addExplanation({
      documentId: 'doc-alpha',
      title: 'Memory Trade-off Calculator',
      kind: 'calculator',
      htmlContent: '<p>Interactive calc</p>',
      assumptions: [
        {
          sourceDocumentId: 'doc-src-1',
          sourceTitle: 'Benchmark Results',
          revisionId: 'rev-bench',
          passage: 'Quantization achieves 3.5GB footprint.',
        },
      ],
    })

    expect(item.id).toBeDefined()
    expect(item.assumptions).toHaveLength(1)

    const list = interactiveExplanationsStore.getByDocument('doc-alpha')
    expect(list).toHaveLength(1)
    expect(list[0]?.title).toBe('Memory Trade-off Calculator')

    await interactiveExplanationsStore.updateExplanation(item.id, {
      title: 'Updated Calculator',
    })

    const updatedList = interactiveExplanationsStore.getByDocument('doc-alpha')
    expect(updatedList[0]?.title).toBe('Updated Calculator')

    await interactiveExplanationsStore.removeExplanation(item.id)
    expect(interactiveExplanationsStore.getByDocument('doc-alpha')).toHaveLength(0)
  })
})
