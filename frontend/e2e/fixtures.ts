import { randomUUID } from 'node:crypto'

import { expect, test as base } from '@playwright/test'

type SeededWorkspace = {
  documentId: string
  documentTitle: string
}

export const test = base.extend<{ seededWorkspace: SeededWorkspace }>({
  seededWorkspace: async ({ request }, provide) => {
    const suffix = randomUUID().slice(0, 8)
    const documentTitle = `Crisp workspace ${suffix}`
    const document = await request.post('/api/v1/documents', {
      headers: { 'Idempotency-Key': randomUUID() },
      data: {
        title: documentTitle,
        content:
          '# Product review\n\nSangam keeps document state, citations, and proposed changes visible.\n\n## Next decision\n\nReview the pending work before publishing.',
        content_type: 'text/markdown',
      },
    })
    expect(document.ok(), await document.text()).toBeTruthy()
    // SAFETY: POST /api/v1/documents returns document entity containing document_id
    const payload = (await document.json()) as { document_id: string }

    await provide({ documentId: payload.document_id, documentTitle })
  },
})

export { expect } from '@playwright/test'
