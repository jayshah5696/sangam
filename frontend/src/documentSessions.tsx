import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ApiError, api, type Document } from './api'
import { IndexedDbDraftStorage, type DraftRecord, type DraftStorage } from './browserState/draftStorage'
import type { EditorSelection, EditorViewState } from './components/MarkdownEditor'

export type { DraftStorage } from './browserState/draftStorage'

export type EditorMode = 'edit' | 'split' | 'preview'
export type SaveState = 'saved' | 'dirty' | 'saving' | 'conflict' | 'failed' | 'offline'
export type DraftPersistenceState = 'idle' | 'pending' | 'persisted' | 'failed'
export type DraftPersistenceOperation = 'read' | 'write' | 'delete'

export type DocumentSession = {
  content?: string
  baseRevisionId?: string
  mode: EditorMode
  saveState: SaveState
  draftPersistenceState: DraftPersistenceState
  draftPersistenceOperation?: DraftPersistenceOperation
  draftPersistenceError?: string
  selection: EditorSelection
  viewState?: EditorViewState
  compareFrom?: string
  compareTo?: string
}

type SessionRuntime = {
  document: Document
  savedContent: string
  saveTimer?: number
  persistTimer?: number
  persistenceGeneration: number
  inFlight: boolean
  queued: boolean
}

type StoreOptions = {
  storage: DraftStorage
  saveDocument: (document: Document, content: string) => Promise<Document>
  onSaved?: (document: Document) => void
  isOnline?: () => boolean
  saveDelay?: number
  persistDelay?: number
}

const initialSelection: EditorSelection = { line: 1, column: 1, selectedCharacters: 0 }

export function deriveSaveState(
  content: string | undefined,
  savedContent: string,
  previous: SaveState,
  online: boolean,
): SaveState {
  if (content === savedContent) return 'saved'
  if (previous === 'conflict') return 'conflict'
  return online ? 'dirty' : 'offline'
}

export class DocumentSessionStore {
  private readonly sessions = new Map<string, DocumentSession>()
  private readonly runtimes = new Map<string, SessionRuntime>()
  private readonly listeners = new Map<string, Set<() => void>>()
  private readonly editorFocusers = new Map<string, () => void>()
  private online = true

  constructor(private readonly options: StoreOptions) {
    this.online = options.isOnline?.() ?? true
  }

  registerEditor = (documentId: string, focus: () => void) => {
    this.editorFocusers.set(documentId, focus)
    return () => {
      if (this.editorFocusers.get(documentId) === focus) this.editorFocusers.delete(documentId)
    }
  }

  focusEditor = (documentId: string) => {
    this.editorFocusers.get(documentId)?.()
  }

  getSession = (documentId: string): DocumentSession => {
    const existing = this.sessions.get(documentId)
    if (existing) return existing
    const session: DocumentSession = {
      mode: 'edit',
      saveState: 'saved',
      draftPersistenceState: 'idle',
      selection: initialSelection,
    }
    this.sessions.set(documentId, session)
    return session
  }

  subscribe = (documentId: string, listener: () => void) => {
    const listeners = this.listeners.get(documentId) ?? new Set<() => void>()
    listeners.add(listener)
    this.listeners.set(documentId, listeners)
    return () => listeners.delete(listener)
  }

  async initializeDocument(document: Document) {
    const existingRuntime = this.runtimes.get(document.document_id)
    const session = this.getSession(document.document_id)
    if (existingRuntime) {
      if (
        existingRuntime.document.current_revision_id !== document.current_revision_id &&
        (session.content === undefined || session.content === existingRuntime.savedContent)
      ) {
        existingRuntime.document = document
        existingRuntime.savedContent = document.content
        this.setSession(document.document_id, {
          ...session,
          content: document.content,
          baseRevisionId: document.current_revision_id,
          saveState: 'saved',
        })
      }
      return
    }

    this.runtimes.set(document.document_id, {
      document,
      savedContent: document.content,
      inFlight: false,
      queued: false,
      persistenceGeneration: 0,
    })
    if (session.content === undefined) {
      this.setSession(document.document_id, {
        ...session,
        content: document.content,
        baseRevisionId: document.current_revision_id,
      })
    }

    await this.loadDraft(document.document_id)
  }

  private async loadDraft(documentId: string) {
    const runtime = this.runtimes.get(documentId)
    if (!runtime) return
    const generation = ++runtime.persistenceGeneration
    const session = this.getSession(documentId)
    this.setSession(documentId, {
      ...session,
      draftPersistenceState: 'pending',
      draftPersistenceOperation: 'read',
      draftPersistenceError: undefined,
    })
    let draft: DraftRecord | undefined
    try {
      draft = await this.options.storage.get(documentId)
    } catch (error) {
      this.failDraftPersistence(documentId, generation, 'read', error)
      return
    }
    if (runtime.persistenceGeneration !== generation) return
    const current = this.getSession(documentId)
    if (!draft || (current.content !== undefined && current.content !== runtime.document.content)) {
      this.setSession(documentId, {
        ...current,
        draftPersistenceState: 'idle',
        draftPersistenceOperation: undefined,
        draftPersistenceError: undefined,
      })
      return
    }
    const saveState = draft.content === runtime.document.content ? 'saved' : this.online ? 'dirty' : 'offline'
    this.setSession(documentId, {
      ...current,
      content: draft.content,
      baseRevisionId: draft.baseRevisionId ?? runtime.document.current_revision_id,
      saveState,
      draftPersistenceState: saveState === 'saved' ? 'pending' : 'persisted',
      draftPersistenceOperation: saveState === 'saved' ? 'delete' : undefined,
      draftPersistenceError: undefined,
    })
    if (saveState === 'saved') this.deleteDraft(documentId)
    else this.scheduleSave(documentId)
  }

  updateSession(documentId: string, patch: Partial<DocumentSession>) {
    const current = this.getSession(documentId)
    let next = { ...current, ...patch }
    const runtime = this.runtimes.get(documentId)
    if (patch.content !== undefined && runtime && patch.saveState === undefined) {
      next = {
        ...next,
        saveState: deriveSaveState(patch.content, runtime.savedContent, current.saveState, this.online),
      }
    }
    this.setSession(documentId, next)
    if (patch.content !== undefined && runtime) {
      this.scheduleDraftPersistence(documentId)
      if (next.saveState !== 'conflict') this.scheduleSave(documentId)
    }
  }

  acceptServerDocument(document: Document, replaceContent = false) {
    const documentId = document.document_id
    const runtime = this.runtimes.get(documentId)
    const current = this.getSession(documentId)
    const previousSavedContent = runtime?.savedContent
    if (runtime) {
      runtime.document = document
      runtime.savedContent = document.content
    } else {
      this.runtimes.set(documentId, {
        document,
        savedContent: document.content,
        inFlight: false,
        queued: false,
        persistenceGeneration: 0,
      })
    }
    const shouldReplace =
      replaceContent || current.content === undefined || current.content === previousSavedContent
    const content = shouldReplace ? document.content : current.content
    this.setSession(documentId, {
      ...current,
      content,
      baseRevisionId: document.current_revision_id,
      saveState: deriveSaveState(content, document.content, current.saveState, this.online),
    })
    if (content === document.content) this.deleteDraft(documentId)
    else {
      this.scheduleDraftPersistence(documentId)
      this.scheduleSave(documentId)
    }
  }

  setOnline(online: boolean) {
    this.online = online
    for (const [documentId, runtime] of this.runtimes) {
      const current = this.getSession(documentId)
      if (current.content === runtime.savedContent || current.saveState === 'conflict') continue
      this.setSession(documentId, { ...current, saveState: online ? 'dirty' : 'offline' })
      if (online) this.scheduleSave(documentId, 0)
    }
  }

  retrySave = (documentId: string) => {
    const runtime = this.runtimes.get(documentId)
    const current = this.getSession(documentId)
    if (!runtime || current.content === runtime.savedContent || current.saveState === 'conflict') return
    this.setSession(documentId, { ...current, saveState: this.online ? 'dirty' : 'offline' })
    if (this.online) this.scheduleSave(documentId, 0)
  }

  retryDraftPersistence = (documentId: string) => {
    const runtime = this.runtimes.get(documentId)
    const current = this.getSession(documentId)
    if (!runtime || current.draftPersistenceState === 'pending') return
    if (current.content !== undefined && current.content !== runtime.savedContent) {
      this.scheduleDraftPersistence(documentId, 0)
    } else if (current.draftPersistenceOperation === 'read') {
      void this.loadDraft(documentId)
    } else {
      this.deleteDraft(documentId)
    }
  }

  dispose() {
    for (const runtime of this.runtimes.values()) {
      if (runtime.saveTimer !== undefined) window.clearTimeout(runtime.saveTimer)
      if (runtime.persistTimer !== undefined) window.clearTimeout(runtime.persistTimer)
    }
  }

  private setSession(documentId: string, session: DocumentSession) {
    this.sessions.set(documentId, session)
    this.listeners.get(documentId)?.forEach((listener) => listener())
  }

  private scheduleSave(documentId: string, delay = this.options.saveDelay ?? 800) {
    const runtime = this.runtimes.get(documentId)
    if (!runtime || !this.online) return
    if (runtime.inFlight) {
      runtime.queued = true
      return
    }
    if (runtime.saveTimer !== undefined) window.clearTimeout(runtime.saveTimer)
    runtime.saveTimer = window.setTimeout(() => {
      runtime.saveTimer = undefined
      void this.save(documentId)
    }, delay)
  }

  private async save(documentId: string) {
    const runtime = this.runtimes.get(documentId)
    const session = this.getSession(documentId)
    if (
      !runtime ||
      runtime.inFlight ||
      !this.online ||
      session.content === undefined ||
      session.content === runtime.savedContent ||
      session.saveState === 'conflict'
    )
      return
    const submittedContent = session.content
    const base = session.baseRevisionId
      ? { ...runtime.document, current_revision_id: session.baseRevisionId }
      : runtime.document
    runtime.inFlight = true
    runtime.queued = false
    this.setSession(documentId, { ...session, saveState: 'saving' })
    try {
      const savedDocument = await this.options.saveDocument(base, submittedContent)
      runtime.document = savedDocument
      runtime.savedContent = submittedContent
      this.options.onSaved?.(savedDocument)
      const current = this.getSession(documentId)
      const isCurrent = current.content === submittedContent
      this.setSession(documentId, {
        ...current,
        baseRevisionId: savedDocument.current_revision_id,
        saveState: deriveSaveState(current.content, runtime.savedContent, current.saveState, this.online),
      })
      if (isCurrent) this.deleteDraft(documentId)
      else this.scheduleDraftPersistence(documentId)
    } catch (error) {
      const current = this.getSession(documentId)
      this.setSession(documentId, {
        ...current,
        saveState:
          error instanceof ApiError && error.status === 409 ? 'conflict' : this.online ? 'failed' : 'offline',
      })
    } finally {
      runtime.inFlight = false
      const current = this.getSession(documentId)
      if (
        (runtime.queued || current.content !== runtime.savedContent) &&
        current.saveState !== 'conflict' &&
        current.saveState !== 'failed' &&
        this.online
      ) {
        this.scheduleSave(documentId)
      }
    }
  }

  private scheduleDraftPersistence(documentId: string, delay = this.options.persistDelay ?? 150) {
    const runtime = this.runtimes.get(documentId)
    if (!runtime) return
    if (runtime.persistTimer !== undefined) window.clearTimeout(runtime.persistTimer)
    const generation = ++runtime.persistenceGeneration
    const current = this.getSession(documentId)
    this.setSession(documentId, {
      ...current,
      draftPersistenceState: 'pending',
      draftPersistenceOperation: 'write',
      draftPersistenceError: undefined,
    })
    runtime.persistTimer = window.setTimeout(() => {
      runtime.persistTimer = undefined
      const session = this.getSession(documentId)
      if (session.content === undefined || session.content === runtime.savedContent) {
        this.deleteDraft(documentId)
        return
      }
      const persistedContent = session.content
      void this.options.storage
        .set({
          documentId,
          content: persistedContent,
          baseRevisionId: session.baseRevisionId,
          updatedAt: Date.now(),
        })
        .then(() => {
          if (runtime.persistenceGeneration !== generation) return
          const latest = this.getSession(documentId)
          if (latest.content !== persistedContent || latest.content === runtime.savedContent) return
          this.setSession(documentId, {
            ...latest,
            draftPersistenceState: 'persisted',
            draftPersistenceOperation: undefined,
            draftPersistenceError: undefined,
          })
        })
        .catch((error: unknown) => this.failDraftPersistence(documentId, generation, 'write', error))
    }, delay)
  }

  private deleteDraft(documentId: string) {
    const runtime = this.runtimes.get(documentId)
    if (!runtime) return
    if (runtime.persistTimer !== undefined) window.clearTimeout(runtime.persistTimer)
    runtime.persistTimer = undefined
    const generation = ++runtime.persistenceGeneration
    const current = this.getSession(documentId)
    this.setSession(documentId, {
      ...current,
      draftPersistenceState: 'pending',
      draftPersistenceOperation: 'delete',
      draftPersistenceError: undefined,
    })
    void this.options.storage
      .delete(documentId)
      .then(() => {
        if (runtime.persistenceGeneration !== generation) return
        const latest = this.getSession(documentId)
        this.setSession(documentId, {
          ...latest,
          draftPersistenceState: 'idle',
          draftPersistenceOperation: undefined,
          draftPersistenceError: undefined,
        })
      })
      .catch((error: unknown) => this.failDraftPersistence(documentId, generation, 'delete', error))
  }

  private failDraftPersistence(
    documentId: string,
    generation: number,
    operation: DraftPersistenceOperation,
    error: unknown,
  ) {
    const runtime = this.runtimes.get(documentId)
    if (!runtime || runtime.persistenceGeneration !== generation) return
    const current = this.getSession(documentId)
    this.setSession(documentId, {
      ...current,
      draftPersistenceState: 'failed',
      draftPersistenceOperation: operation,
      draftPersistenceError: error instanceof Error ? error.message : 'Browser draft storage failed.',
    })
  }
}

const DocumentSessionsContext = createContext<DocumentSessionStore | null>(null)

export function DocumentSessionsProvider({
  children,
  storage,
}: {
  children: ReactNode
  storage?: DraftStorage
}) {
  const queryClient = useQueryClient()
  const [store] = useState(
    () =>
      new DocumentSessionStore({
        storage: storage ?? new IndexedDbDraftStorage(),
        saveDocument: api.updateDocument,
        isOnline: () => navigator.onLine,
        onSaved: (document) => {
          queryClient.setQueryData(['document', document.document_id], document)
          void queryClient.invalidateQueries({ queryKey: ['documents'] })
          void queryClient.invalidateQueries({ queryKey: ['history', document.document_id] })
          void queryClient.invalidateQueries({ queryKey: ['folders'] })
        },
      }),
  )

  useEffect(() => {
    const online = () => store.setOnline(true)
    const offline = () => store.setOnline(false)
    window.addEventListener('online', online)
    window.addEventListener('offline', offline)
    return () => {
      window.removeEventListener('online', online)
      window.removeEventListener('offline', offline)
      store.dispose()
    }
  }, [store])

  return <DocumentSessionsContext.Provider value={store}>{children}</DocumentSessionsContext.Provider>
}

export function useDocumentSessions() {
  const store = useContext(DocumentSessionsContext)
  if (!store) throw new Error('useDocumentSessions must be used inside DocumentSessionsProvider')
  return store
}

const subscribeToNothing = () => () => undefined
const getNoSession = () => null

export function useDocumentSession(documentId: string): DocumentSession
export function useDocumentSession(documentId: null): null
export function useDocumentSession(documentId: string | null): DocumentSession | null
export function useDocumentSession(documentId: string | null) {
  const store = useDocumentSessions()
  return useSyncExternalStore(
    documentId ? (listener) => store.subscribe(documentId, listener) : subscribeToNothing,
    documentId ? () => store.getSession(documentId) : getNoSession,
    documentId ? () => store.getSession(documentId) : getNoSession,
  )
}
