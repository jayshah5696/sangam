import { useNavigate } from '@tanstack/react-router'
import type { ProjectDetail, ProjectDocumentItem } from './api'
import { useDocumentSessions } from './documentSessions'
import { useTheme } from './theme'
import { useWorkbench } from './workbench'
import { findGroup, parseWorkbenchLayoutState } from './workbenchLayout'

export const HOME_PROJECT_KEY = 'sangam.home-project'

export function projectDraft(project: ProjectDetail) {
  return (
    project.documents.find((d) => d.document_id === project.active_document_id) ??
    project.documents.find((d) => d.role === 'draft' && d.document_id !== project.brief_document_id)
  )
}

export function useProjectResume() {
  const workbench = useWorkbench()
  const sessions = useDocumentSessions()
  const navigate = useNavigate()
  const { updatePreferences } = useTheme()

  const openDocument = (document: ProjectDocumentItem, annotationId?: string, projectId?: string) => {
    if (document.content_type === 'application/pdf') {
      sessions.updateSession(document.document_id, {
        pdfState: { pageNumber: document.pinned_page ?? 1, scale: 1, zoomMode: 'fit-width', scrollTop: 0 },
        pdfSelectedAnnotationId: annotationId ?? null,
      })
      if (annotationId) updatePreferences({ rightVisible: true, rightTab: 'research' })
    }
    workbench.ensureDocumentOpen(document.document_id, document.document_title)
    return navigate({
      to: '/documents/$documentId',
      params: { documentId: document.document_id },
      search: {
        project: projectId,
        page: document.content_type === 'application/pdf' ? (document.pinned_page ?? 1) : undefined,
        annotation: annotationId,
      },
    })
  }

  const openConversation = (threadId: string) => {
    localStorage.setItem('sangam.chat-thread.workspace', threadId)
    return navigate({ to: '/chat' })
  }

  const resume = async (project: ProjectDetail) => {
    localStorage.setItem(HOME_PROJECT_KEY, project.project_id)
    for (const doc of project.documents) {
      if (doc.content_type === 'application/pdf') {
        sessions.updateSession(doc.document_id, {
          pdfState: { pageNumber: doc.pinned_page ?? 1, scale: 1, zoomMode: 'fit-width', scrollTop: 0 },
          pdfSelectedAnnotationId: null,
        })
      }
    }
    if (project.active_thread_id) {
      localStorage.setItem('sangam.chat-thread.workspace', project.active_thread_id)
      updatePreferences({ rightVisible: true, rightTab: 'chat' })
    } else {
      localStorage.removeItem('sangam.chat-thread.workspace')
    }
    const layout = project.workbench_state_json
      ? parseWorkbenchLayoutState(JSON.parse(project.workbench_state_json))
      : null
    const selected = layout ? findGroup(layout.root, layout.activeGroupId)?.activeTabId : null
    const target = project.documents.find((d) => d.document_id === selected) ?? projectDraft(project)
    if (layout && target) {
      workbench.restoreLayout(layout)
      await navigate({
        to: '/documents/$documentId',
        params: { documentId: target.document_id },
        search: { project: project.project_id },
      })
    } else if (target) {
      await openDocument(target, undefined, project.project_id)
    } else if (project.active_thread_id) {
      await openConversation(project.active_thread_id)
    } else {
      await navigate({ to: '/projects', search: { project: project.project_id } })
    }
  }
  return { resume, openDocument, openConversation }
}
