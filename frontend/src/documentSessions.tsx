import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ApiError, api, type Document } from './api'
import { IndexedDbDraftStorage, type DraftRecord, type DraftStorage } from './browserState/draftStorage'
import { adoptDocumentInCache } from './documentCache'
import type { EditorSelection, EditorViewState } from './components/MarkdownEditor'
import type { AnnotationDraft } from './components/pdfResearchTypes'
import { evidenceCitationForType, type EvidenceReference } from './evidenceCitation'

export type { DraftStorage } from './browserState/draftStorage'

export type EditorMode = 'edit' | 'split' | 'preview'
export type SaveState = 'saved' | 'dirty' | 'saving' | 'conflict' | 'failed' | 'offline'
export type DraftPersistenceState = 'idle' | 'pending' | 'persisted' | 'failed'
export type DraftPersistenceOperation = 'read' | 'write' | 'delete'

export type PdfViewState = {
  pageNumber: number
  scale: number
  zoomMode: 'fit-width' | 'custom'
  scrollTop: number
}

export type DocumentSession = {
  content?: string
  baseRevisionId?: string
  mode: EditorMode
  focusOnOpen?: boolean
  saveState: SaveState
  draftPersistenceState: DraftPersistenceState
  draftPersistenceOperation?: DraftPersistenceOperation
  draftPersistenceError?: string
  selection: EditorSelection
  viewState?: EditorViewState
  compareFrom?: string
  compareTo?: string
  pdfState?: PdfViewState
  pdfAnnotationQuery?: string
  pdfSelectedAnnotationId?: string | null
  pdfDraft?: AnnotationDraft | null
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
  /** Write `content` (and optionally a new title) on top of `document.current_revision_id`. */
  saveDocument: (document: Document, content: string, title?: string) => Promise<Document>
  /** Called with every server head the store adopts, so caches can follow it. */
  onServerDocument?: (document: Document) => void
  isOnline?: () => boolean
  saveDelay?: number
  persistDelay?: number
  getDefaultMode?: () => EditorMode
  onWritingIntent?: () => void
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

/**
 * The one browser-side writer of document content and titles.
 *
 * Each open document has a base revision that only this store advances. Saves
 * and renames are serialized per document, so no write is ever sent on top of a
 * revision another in-flight write is about to replace.
 */
export class DocumentSessionStore {
  private readonly sessions = new Map<string, DocumentSession>()
  private readonly runtimes = new Map<string, SessionRuntime>()
  private readonly listeners = new Map<string, Set<() => void>>()
  private readonly editorHandles = new Map<
    string,
    {
      focus: () => void
      scrollToLine?: (line: number) => void
      insertText?: (text: string, expectedContent?: string) => boolean
    }
  >()
  private readonly pendingInsertions = new Map<
    string,
    { text: string; resolve: (inserted: boolean) => void }
  >()
  private readonly initializing = new Map<string, Promise<void>>()
  private online = true

  constructor(private readonly options: StoreOptions) {
    this.online = options.isOnline?.() ?? true
  }

  setDefaultMode = (getDefaultMode: () => EditorMode) => {
    this.options.getDefaultMode = getDefaultMode
  }

  registerEditor = (
    documentId: string,
    focus: () => void,
    scrollToLine?: (line: number) => void,
    insertText?: (text: string, expectedContent?: string) => boolean,
  ) => {
    this.editorHandles.set(documentId, { focus, scrollToLine, insertText })
    const pending = this.pendingInsertions.get(documentId)
    if (pending) {
      this.pendingInsertions.delete(documentId)
      pending.resolve(this.insertText(documentId, pending.text))
    }
    return () => {
      if (this.editorHandles.get(documentId)?.focus === focus) this.editorHandles.delete(documentId)
    }
  }

  focusEditor = (documentId: string) => {
    this.editorHandles.get(documentId)?.focus()
  }

  openForWriting = (document: Document) => {
    this.options.onWritingIntent?.()
    this.updateSession(document.document_id, {
      mode: 'edit',
      focusOnOpen: true,
      viewState:
        document.content_type === 'text/markdown'
          ? { anchor: document.content.length, head: document.content.length, scrollTop: 0 }
          : undefined,
    })
  }

  scrollToLine = (documentId: string, line: number) => {
    const handle = this.editorHandles.get(documentId)
    handle?.scrollToLine?.(line)
    handle?.focus()
  }

  insertText = (documentId: string, text: string): boolean => {
    const handle = this.editorHandles.get(documentId)
    if (this.runtimes.has(documentId) && handle?.insertText?.(text, this.getSession(documentId).content)) {
      handle.focus()
      return true
    }
    return false
  }

  insertIntoDocument = async (documentId: string, text: string): Promise<boolean> =>
    this.insertIntoLoadedDocument(await api.getDocument(documentId), text)

  insertEvidence = async (documentId: string, reference: EvidenceReference): Promise<boolean> => {
    const document = await api.getDocument(documentId)
    return this.insertIntoLoadedDocument(document, evidenceCitationForType(reference, document.content_type))
  }

  private async insertIntoLoadedDocument(document: Document, text: string): Promise<boolean> {
    const documentId = document.document_id
    if (document.content_type === 'application/pdf') throw new Error('Choose a writable destination draft.')
    await this.initializeDocument(document)
    const session = this.getSession(documentId)
    if (session.draftPersistenceState === 'failed')
      throw new Error('Recover the destination draft before inserting evidence.')
    if (session.saveState === 'conflict')
      throw new Error('Resolve the destination conflict before inserting evidence.')
    this.updateSession(documentId, { mode: 'edit', focusOnOpen: true })
    this.options.onWritingIntent?.()
    if (this.insertText(documentId, text)) return true
    return new Promise((resolve) => {
      this.pendingInsertions.get(documentId)?.resolve(false)
      this.pendingInsertions.set(documentId, { text, resolve })
    })
  }

  flushSnapshot = async (documentId: string, snapshot: string): Promise<Document> => {
    const runtime = this.runtimes.get(documentId)
    if (!runtime) throw new Error('Source is not loaded.')
    await this.whenIdle(runtime, documentId)
    if (runtime.savedContent === snapshot) return runtime.document
    if (this.getSession(documentId).content !== snapshot)
      throw new Error('The source changed after selection. Select the passage again.')
    await this.save(documentId)
    if (runtime.savedContent !== snapshot)
      throw new Error('Save the source successfully before keeping evidence.')
    return runtime.document
  }

  /**
   * Rename a document, saving its current editor content in the same revision.
   * Waits for an in-flight autosave so the rename builds on that save's revision.
   */
  rename = async (documentId: string, title: string): Promise<Document> => {
    if (!this.runtimes.has(documentId)) await this.initializeDocument(await api.getDocument(documentId))
    const runtime = this.runtimes.get(documentId)
    if (!runtime) throw new Error('The document could not be loaded.')
    await this.whenIdle(runtime, documentId)
    if (runtime.saveTimer !== undefined) window.clearTimeout(runtime.saveTimer)
    runtime.saveTimer = undefined
    const renamed = await this.save(documentId, title)
    if (!renamed) throw new Error('Another save started before the rename. Try again.')
    return renamed
  }

  private whenIdle(runtime: SessionRuntime, documentId: string): Promise<void> {
    if (!runtime.inFlight) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const stop = this.subscribe(documentId, () => {
        if (!runtime.inFlight) {
          stop()
          resolve()
        }
      })
    })
  }

  getSession = (documentId: string): DocumentSession => {
    const existing = this.sessions.get(documentId)
    if (existing) return existing
    const session: DocumentSession = {
      mode: this.options.getDefaultMode?.() ?? 'edit',
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

  initializeDocument(document: Document): Promise<void> {
    const pending = this.initializing.get(document.document_id)
    if (pending) return pending
    const task = this.initialize(document).finally(() => this.initializing.delete(document.document_id))
    this.initializing.set(document.document_id, task)
    return task
  }

  private async initialize(document: Document) {
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
      this.failDraftPersistence(
        documentId,
        generation,
        'read',
        error instanceof Error ? error : String(error),
      )
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

  /** Adopt a head written outside this store, such as an applied proposal or a restore. */
  acceptServerDocument(document: Document, replaceContent = false) {
    this.options.onServerDocument?.(document)
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
    for (const pending of this.pendingInsertions.values()) pending.resolve(false)
    this.pendingInsertions.clear()
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

  /**
   * Send the session's content as the next revision. An autosave (no `title`)
   * skips when there is nothing to save; a rename always writes and rethrows failure.
   */
  private async save(documentId: string, title?: string): Promise<Document | undefined> {
    const runtime = this.runtimes.get(documentId)
    const session = this.getSession(documentId)
    const renaming = title !== undefined
    if (!runtime || runtime.inFlight) return
    if (
      !renaming &&
      (!this.online ||
        session.content === undefined ||
        session.content === runtime.savedContent ||
        session.saveState === 'conflict')
    )
      return
    const submittedContent = session.content ?? runtime.savedContent
    const base = session.baseRevisionId
      ? { ...runtime.document, current_revision_id: session.baseRevisionId }
      : runtime.document
    runtime.inFlight = true
    runtime.queued = false
    this.setSession(documentId, { ...session, saveState: 'saving' })
    try {
      const savedDocument = await this.options.saveDocument(base, submittedContent, title)
      runtime.document = savedDocument
      runtime.savedContent = submittedContent
      this.options.onServerDocument?.(savedDocument)
      const current = this.getSession(documentId)
      const isCurrent = current.content === submittedContent
      this.setSession(documentId, {
        ...current,
        baseRevisionId: savedDocument.current_revision_id,
        saveState: deriveSaveState(current.content, runtime.savedContent, current.saveState, this.online),
      })
      if (isCurrent) this.deleteDraft(documentId)
      else this.scheduleDraftPersistence(documentId)
      return savedDocument
    } catch (error) {
      const current = this.getSession(documentId)
      const conflicted = error instanceof ApiError && error.kind === 'conflict'
      // A failed rename leaves unsaved content to autosave; only a conflict stops it.
      const failedState = renaming && current.content === runtime.savedContent ? 'saved' : 'failed'
      this.setSession(documentId, {
        ...current,
        saveState: conflicted ? 'conflict' : this.online ? failedState : 'offline',
      })
      if (renaming) throw error
    } finally {
      runtime.inFlight = false
      this.listeners.get(documentId)?.forEach((listener) => listener())
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
        .catch((error) =>
          this.failDraftPersistence(
            documentId,
            generation,
            'write',
            error instanceof Error ? error : String(error),
          ),
        )
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
      .catch((error) =>
        this.failDraftPersistence(
          documentId,
          generation,
          'delete',
          error instanceof Error ? error : String(error),
        ),
      )
  }

  private failDraftPersistence(
    documentId: string,
    generation: number,
    operation: DraftPersistenceOperation,
    error: Error | string | null | undefined,
  ) {
    const runtime = this.runtimes.get(documentId)
    if (!runtime || runtime.persistenceGeneration !== generation) return
    const current = this.getSession(documentId)
    const errorMessage = error instanceof Error ? error.message : error || 'Browser draft storage failed.'
    this.setSession(documentId, {
      ...current,
      draftPersistenceState: 'failed',
      draftPersistenceOperation: operation,
      draftPersistenceError: errorMessage,
    })
  }
}

const DocumentSessionsContext = createContext<DocumentSessionStore | null>(null)

export function DocumentSessionsProvider({
  children,
  storage,
  defaultMode,
  onWritingIntent,
}: {
  children: ReactNode
  storage?: DraftStorage
  defaultMode?: () => EditorMode
  onWritingIntent?: () => void
}) {
  const queryClient = useQueryClient()
  const [store] = useState(
    () =>
      new DocumentSessionStore({
        storage: storage ?? new IndexedDbDraftStorage(),
        onWritingIntent,
        saveDocument: api.updateDocument,
        isOnline: () => navigator.onLine,
        onServerDocument: (document) => adoptDocumentInCache(queryClient, document),
      }),
  )

  useEffect(() => {
    if (defaultMode) store.setDefaultMode(defaultMode)
  }, [defaultMode, store])
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
