import type { DocumentSummary, Project, ProjectDocument } from './api'
import type { WorkbenchTab } from './workbench'

export type HomeDocumentSections<T> = { pinned: T[]; recent: T[] }

export function selectHomeDocuments<T extends Pick<DocumentSummary, 'document_id'>>(
  documents: T[],
  tabs: WorkbenchTab[],
): HomeDocumentSections<T> {
  const byId = new Map(documents.map((document) => [document.document_id, document]))
  const seen = new Set<string>()
  const pinned: T[] = []
  const recent: T[] = []
  for (const tab of tabs) {
    const document = byId.get(tab.documentId)
    if (!document || seen.has(document.document_id)) continue
    seen.add(document.document_id)
    if (tab.pinned) pinned.push(document)
    else recent.push(document)
  }
  return { pinned, recent }
}

export type CategorizedProjectDocuments = {
  sources: ProjectDocument[]
  notes: ProjectDocument[]
  outputs: ProjectDocument[]
  drafts: ProjectDocument[]
}

export function categorizeProjectDocuments(documents: ProjectDocument[]): CategorizedProjectDocuments {
  const categories: CategorizedProjectDocuments = {
    sources: [],
    notes: [],
    outputs: [],
    drafts: [],
  }
  for (const doc of documents) {
    const role = (doc.role || '').toLowerCase().trim()
    if (role === 'source' || role === 'sources') {
      categories.sources.push(doc)
    } else if (role === 'note' || role === 'notes') {
      categories.notes.push(doc)
    } else if (role === 'output' || role === 'outputs') {
      categories.outputs.push(doc)
    } else {
      categories.drafts.push(doc)
    }
  }
  return categories
}

export type ProjectResumeAction = {
  documentId?: string
  title: string
  actionLabel: string
  hint: string
  snippet?: string | null
}

export function getProjectResumeAction(project: Project): ProjectResumeAction | null {
  if (project.primary_document) {
    return {
      documentId: project.primary_document.document_id,
      title: project.primary_document.title,
      actionLabel: 'Resume primary draft',
      hint: project.resume_hint || project.primary_document.resume_hint || 'Continue editing this draft',
      snippet: project.primary_document.snippet,
    }
  }
  const draft =
    project.documents.find((d) => (d.role || '').toLowerCase().startsWith('draft')) || project.documents[0]
  if (draft) {
    return {
      documentId: draft.document_id,
      title: draft.title,
      actionLabel: 'Resume working draft',
      hint: project.resume_hint || draft.resume_hint || 'Continue editing this draft',
      snippet: draft.snippet,
    }
  }
  if (project.resume_hint) {
    return {
      title: project.name,
      actionLabel: 'Next project step',
      hint: project.resume_hint,
    }
  }
  return null
}
