export interface SourceChangeStatus {
  changed: boolean
  reason?: string
}

import type { EvidenceItem } from './evidenceCitation'
import { remapEvidencePassage, shortRevision as originalShortRevision } from './evidenceCitation'
import type { TextLocator } from './citationNavigation'

export interface DraftCitationReference {
  id: string
  sourceDocumentId: string
  sourceTitle: string
  pinnedRevisionId?: string
  pageNumber?: number
  annotationId?: string
  claim?: string | null
  selectedText?: string
  startOffset: number
  endOffset: number
  rawCitation: string
  draftDocumentId?: string
}

export interface DependentConclusion {
  id: string
  claim: string
  sourceDocumentId: string
  sourceTitle: string
  pinnedRevisionId?: string
  pageNumber?: number
  annotationId?: string
  selectedText: string
  draftDocumentId?: string
  draftDocumentTitle?: string
  needsRechecking: boolean
  recheckReason?: string
  sourceCurrentRevisionId?: string
  sourceSupersededByTitle?: string
  evidenceItem?: EvidenceItem
}

export interface RecheckAnalysis {
  status: 'identical' | 'modified' | 'removed'
  remappedText: string | null
  summary: string
  suggestion: string
}

export function shortRevision(value?: string | null): string {
  return originalShortRevision(value ?? undefined)
}


/**
 * Extracts citations and associated claims/passages from draft Markdown content.
 */
export function extractDraftCitations(content: string, draftDocumentId?: string): DraftCitationReference[] {
  const citations: DraftCitationReference[] = []
  if (!content) return citations

  // Match Markdown citation links: [Source: ...](sangam://document/... or /documents/...)
  const linkRegex = /\[(?:Source:\s*)?([^\]]+)\]\((?:sangam:\/\/document\/|\/documents\/)([^?)]+)(?:\?([^)]+))?\)/g
  let match: RegExpExecArray | null

  while ((match = linkRegex.exec(content)) !== null) {
    const rawLabel = (match[1] ?? '').trim()
    const sourceDocumentId = decodeURIComponent((match[2] ?? '').trim())
    const queryString = match[3] ?? ''
    const params = new URLSearchParams(queryString)
    const pinnedRevisionId = params.get('revision') || undefined
    const pageNumber = params.get('page') ? Number(params.get('page')) : undefined
    const annotationId = params.get('annotation') || undefined

    // Inspect the lines before this citation to extract blockquoted text and optional claim
    const textBefore = content.slice(0, match.index)
    const linesBefore = textBefore.split('\n')
    const quoteLines: string[] = []
    let explicitClaim: string | undefined

    for (let i = linesBefore.length - 1; i >= 0; i--) {
      const line = (linesBefore[i] ?? '').trim()
      if (line === '') {
        if (quoteLines.length > 0) break
        continue
      }
      if (line.startsWith('>')) {
        const cleaned = line.replace(/^>\s?/, '').trim()
        if (cleaned.toLowerCase().startsWith('claim:')) {
          explicitClaim = cleaned.slice(6).trim()
        } else if (cleaned) {
          quoteLines.unshift(cleaned)
        }
      } else {
        if (quoteLines.length === 0 && !explicitClaim) {
          explicitClaim = line
        }
        break
      }
    }

    const selectedText = quoteLines.length > 0 ? quoteLines.join('\n') : undefined
    const claim = explicitClaim || (selectedText ? selectedText.slice(0, 120) : rawLabel)

    citations.push({
      id: `citation-${sourceDocumentId}-${pinnedRevisionId || 'head'}-${match.index}`,
      sourceDocumentId,
      sourceTitle: rawLabel,
      pinnedRevisionId,
      pageNumber,
      annotationId,
      draftDocumentId,
      claim,
      selectedText,
      startOffset: match.index,
      endOffset: match.index + match[0].length,
      rawCitation: match[0],
    })
  }

  return citations
}

/**
 * Checks whether a source has changed deterministically relative to a pinned version.
 */
export function checkSourceChanged(
  source: {
    current_revision_id?: string | null
    superseded_by_document_id?: string | null
    superseded_by_title?: string | null
    content_type?: string
  } | null | undefined,
  pinnedRevisionId?: string | null,
): SourceChangeStatus {
  if (!source) return { changed: false }

  // PDF replacement check
  if (source.superseded_by_document_id) {
    const replacement = source.superseded_by_title ? `"${source.superseded_by_title}"` : 'a newer replacement paper'
    return {
      changed: true,
      reason: `Source paper was superseded by ${replacement}`,
    }
  }

  // Revision comparison for text/markdown/html
  if (
    source.current_revision_id &&
    pinnedRevisionId &&
    source.current_revision_id !== pinnedRevisionId
  ) {
    return {
      changed: true,
      reason: `Source document updated from revision ${shortRevision(pinnedRevisionId)} to ${shortRevision(source.current_revision_id)}`,
    }
  }

  return { changed: false }
}

/**
 * Analyzes whether a pinned passage text has changed in the current head revision.
 */
export function analyzePassageRecheck(
  oldPassage: string,
  headContent: string,
  sourceContentType: 'text/markdown' | 'text/html' | 'application/pdf' = 'text/markdown',
  textLocator?: TextLocator,
): RecheckAnalysis {
  const trimmed = oldPassage.trim()
  if (!trimmed || !headContent) {
    return {
      status: 'removed',
      remappedText: null,
      summary: 'The original passage cannot be located in the current head revision.',
      suggestion: 'Detecting a newer source revision is deterministic. Deciding whether the change invalidates a claim requires judgment and remains a suggestion.',
    }
  }

  if (headContent.includes(trimmed)) {
    return {
      status: 'identical',
      remappedText: trimmed,
      summary: 'The passage appears verbatim in the current head revision.',
      suggestion: 'The source wording is identical. Check surrounding context if new findings qualify this conclusion.',
    }
  }

  const remapped = remapEvidencePassage(headContent, {
    sourceContentType,
    selectedText: trimmed,
    textLocator,
  })
  if (remapped) {
    return {
      status: 'identical',
      remappedText: remapped.exact,
      summary: 'The passage appears in the current head revision at a shifted position.',
      suggestion: 'The source wording is identical. Check surrounding context if new findings qualify this conclusion.',
    }
  }

  // Check if significant tokens exist to distinguish modified vs completely removed
  const words = trimmed.split(/\s+/).filter(Boolean)
  if (words.length >= 3) {
    const half = Math.floor(words.length / 2)
    const firstHalf = words.slice(0, half).join(' ')
    const secondHalf = words.slice(half).join(' ')
    if (headContent.includes(firstHalf) || headContent.includes(secondHalf)) {
      return {
        status: 'modified',
        remappedText: null,
        summary: 'The passage was modified in the current head revision.',
        suggestion: 'The text was updated. Compare the old and new phrasing to decide whether your conclusion holds.',
      }
    }
  }

  return {
    status: 'removed',
    remappedText: null,
    summary: 'The original passage was removed or significantly rewritten in the current head revision.',
    suggestion: 'The source passage is no longer present. Recheck your claim against the new revision content.',
  }
}

/**
 * Finds all conclusions and passages depending on a specific source document.
 * This answers: "Which conclusions in this project depend on this paper?"
 */
export function findSourceDependencies({
  sourceDocumentId,
  sourceTitle,
  sourceCurrentRevisionId,
  sourceSupersededByTitle,
  evidenceItems,
  drafts = [],
}: {
  sourceDocumentId: string
  sourceTitle?: string
  sourceCurrentRevisionId?: string | null
  sourceSupersededByTitle?: string | null
  evidenceItems: EvidenceItem[]
  drafts?: Array<{ document_id: string; title: string; content?: string }>
}): DependentConclusion[] {
  const results: DependentConclusion[] = []
  const seenKeys = new Set<string>()

  // 1. Gather from workspace evidence items
  for (const item of evidenceItems) {
    if (item.sourceDocumentId !== sourceDocumentId) continue

    const change = checkSourceChanged(
      {
        current_revision_id: sourceCurrentRevisionId,
        superseded_by_document_id: sourceSupersededByTitle ? 'superseded' : null,
        superseded_by_title: sourceSupersededByTitle,
      },
      item.pinnedRevisionId,
    )

    const targetDraft = item.claimTarget
      ? drafts.find((d) => d.document_id === item.claimTarget?.documentId)
      : undefined

    const claimText =
      item.claim?.trim() ||
      item.note?.trim() ||
      (item.selectedText ? item.selectedText.slice(0, 140) : 'General reference')

    const key = `${item.sourceDocumentId}-${item.claimTarget?.documentId || ''}-${claimText}`
    if (!seenKeys.has(key)) {
      seenKeys.add(key)
      results.push({
        id: item.id,
        claim: claimText,
        sourceDocumentId: item.sourceDocumentId,
        sourceTitle: item.sourceTitle || sourceTitle || 'Source',
        pinnedRevisionId: item.pinnedRevisionId,
        pageNumber: item.pageNumber,
        annotationId: item.annotationId,
        selectedText: item.selectedText,
        draftDocumentId: item.claimTarget?.documentId,
        draftDocumentTitle: targetDraft?.title,
        needsRechecking: change.changed,
        recheckReason: change.reason,
        sourceCurrentRevisionId: sourceCurrentRevisionId || undefined,
        sourceSupersededByTitle: sourceSupersededByTitle || undefined,
        evidenceItem: item,
      })
    }
  }

  // 2. Gather from draft contents citations
  for (const draft of drafts) {
    if (!draft.content) continue
    const citations = extractDraftCitations(draft.content, draft.document_id)
    for (const cite of citations) {
      if (cite.sourceDocumentId !== sourceDocumentId) continue

      const change = checkSourceChanged(
        {
          current_revision_id: sourceCurrentRevisionId,
          superseded_by_document_id: sourceSupersededByTitle ? 'superseded' : null,
          superseded_by_title: sourceSupersededByTitle,
        },
        cite.pinnedRevisionId,
      )

      const claimText = cite.claim || cite.selectedText?.slice(0, 140) || 'Cited claim'
      const key = `${cite.sourceDocumentId}-${draft.document_id}-${claimText}`
      if (!seenKeys.has(key)) {
        seenKeys.add(key)
        results.push({
          id: cite.id,
          claim: claimText,
          sourceDocumentId: cite.sourceDocumentId,
          sourceTitle: cite.sourceTitle || sourceTitle || 'Source',
          pinnedRevisionId: cite.pinnedRevisionId,
          pageNumber: cite.pageNumber,
          annotationId: cite.annotationId,
          selectedText: cite.selectedText || '',
          draftDocumentId: draft.document_id,
          draftDocumentTitle: draft.title,
          needsRechecking: change.changed,
          recheckReason: change.reason,
          sourceCurrentRevisionId: sourceCurrentRevisionId || undefined,
          sourceSupersededByTitle: sourceSupersededByTitle || undefined,
        })
      }
    }
  }

  return results
}
