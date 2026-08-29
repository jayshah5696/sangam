import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { z } from 'zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import type { TypographyOption } from '@openai/chatkit'
import { ChatKit, useChatKit } from '@openai/chatkit-react'
import { ChevronDown, ExternalLink, FileText, FolderInput, History, Plus, Square, X } from 'lucide-react'
import {
  api,
  documentSchema,
  issuedPublicationSchema,
  organizationOperationSchema,
  type ChatEffect,
  type ChatProposal,
  type Document,
  type IssuedPublication,
  type JsonPayload,
  type OrganizationOperation,
  type Publication,
} from '../api'
import {
  announceCitationNavigation,
  citationHref,
  citationTargetFromData,
  type CitationDataPayload,
  type CitationTarget,
} from '../citationNavigation'
import { uiFonts, useTheme } from '../theme'
import { OneTimeSecret } from './OneTimeSecret'
import { StateMessage } from './ui/StateMessage'
import { RevisionMergeView } from './RevisionMergeView'
import {
  ChatCreateConfirmation,
  parseCreateConfirmation,
  type CreateConfirmationRequest,
} from './ChatCreateConfirmation'
import { useChatKitScript } from './useChatKitScript'

const SELECTION_LIMIT = 20_000
// One workspace-scoped chat thread persists across document tabs; the active
// document is passed as live context rather than switching threads per tab.
const THREAD_STORAGE_KEY = 'sangam.chat-thread.workspace'

export type PublishConfirmationRequest = {
  documentId: string
  documentTitle: string
  slug: string
  accessPolicy: Publication['access_policy']
}

export function ChatPanel({
  document,
  selectedText,
  onDocumentUpdated,
  onClearContext,
  pdfPageNumber,
  annotationId,
  compact = false,
}: {
  document?: Document | null
  selectedText?: string
  onDocumentUpdated?: (document: Document, replaceContent?: boolean) => void
  onClearContext?: () => void
  pdfPageNumber?: number | null
  annotationId?: string | null
  compact?: boolean
}) {
  const activeDocument = document ?? null
  const activeSelectedText = selectedText ?? ''
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { preferences } = useTheme()
  const threadStorageKey = THREAD_STORAGE_KEY
  const [threadId, setThreadId] = useState<string | null>(() => localStorage.getItem(threadStorageKey))
  const [chatEpoch, setChatEpoch] = useState(0)
  const [pendingPublication, setPendingPublication] = useState<PublishConfirmationRequest | null>(null)
  const [publishError, setPublishError] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [published, setPublished] = useState<IssuedPublication | null>(null)
  const [pendingCreate, setPendingCreate] = useState<CreateConfirmationRequest | null>(null)
  const [pendingOrganization, setPendingOrganization] = useState<OrganizationOperation[] | null>(null)
  const [pendingEffect, setPendingEffect] = useState<ChatEffect | null>(null)
  const [createError, setCreateError] = useState(false)
  const [creating, setCreating] = useState(false)
  const [createdDocument, setCreatedDocument] = useState<Document | null>(null)
  const [openedCitation, setOpenedCitation] = useState<CitationTarget | null>(null)
  const [resumingEffectId, setResumingEffectId] = useState<string | null>(null)
  const [resumeErrorIds, setResumeErrorIds] = useState<Set<string>>(() => new Set())
  const publishResolver = useRef<((result: Record<string, JsonPayload>) => void) | null>(null)
  const createResolver = useRef<((result: Record<string, JsonPayload>) => void) | null>(null)
  const organizationResolver = useRef<((result: Record<string, JsonPayload>) => void) | null>(null)
  const [settledEffectIds, setSettledEffectIds] = useState<Set<string>>(() => new Set())
  const configQuery = useQuery({ queryKey: ['chat-config'], queryFn: api.chatConfig })
  const script = useChatKitScript(configQuery.isSuccess)
  const proposalsQuery = useQuery({
    queryKey: ['chat-proposals', activeDocument?.document_id ?? null, threadId],
    queryFn: () => api.listChatProposals(activeDocument?.document_id, threadId ?? undefined),
    enabled: configQuery.isSuccess,
  })
  const effectsQuery = useQuery({
    queryKey: ['chat-effects', threadId],
    queryFn: () =>
      api.listChatEffects(threadId ?? undefined, [
        'pending_approval',
        'approved',
        'executing',
        'completed',
        'failed',
      ]),
    enabled: configQuery.isSuccess && Boolean(threadId),
  })
  const removeEffectFromPendingCache = useCallback(
    (effectId: string) => {
      queryClient.setQueryData<ChatEffect[]>(['chat-effects', threadId], (effects) =>
        effects?.filter((effect) => effect.effect_id !== effectId),
      )
    },
    [queryClient, threadId],
  )
  const refreshProposals = useCallback(
    () =>
      queryClient.invalidateQueries({
        queryKey: ['chat-proposals', activeDocument?.document_id ?? null, threadId],
      }),
    [activeDocument?.document_id, queryClient, threadId],
  )
  const showPendingEffect = useCallback((effect: ChatEffect) => {
    if (effect.status !== 'pending_approval') return false
    if (effect.capability_id === 'publish_document') {
      const request = parsePublishConfirmation(effect.preview)
      if (!request) return false
      setPendingPublication(request)
      setPendingCreate(null)
      setPublishError(false)
      setPublished(null)
      setPendingOrganization(null)
    } else if (effect.capability_id === 'create_document') {
      const request = parseCreateConfirmation(effect.preview)
      if (!request) return false
      setPendingCreate(request)
      setPendingPublication(null)
      setCreateError(false)
      setCreatedDocument(null)
      setPendingOrganization(null)
    } else {
      const parsed = z.array(organizationOperationSchema).safeParse(effect.preview.operations)
      if (!parsed.success) return false
      setPendingOrganization(parsed.data)
      setPendingPublication(null)
      setPendingCreate(null)
    }
    setPendingEffect(effect)
    return true
  }, [])
  const requestEffectReview = useCallback(
    async (params: { effect_id?: string; argument_digest?: string }) => {
      const effectId = params.effect_id ?? ''
      const digest = params.argument_digest ?? ''
      if (!effectId || !digest) return { approved: false, error: 'Invalid effect review request' }
      const effect = await api.getChatEffect(effectId)
      if (effect.argument_digest !== digest) {
        return { approved: false, error: 'Effect review request no longer matches' }
      }
      if (effect.status === 'completed') return { ...effect.result, approved: true }
      if (!showPendingEffect(effect)) return { approved: false, error: `Effect is ${effect.status}` }
      return new Promise<Record<string, JsonPayload>>((resolve) => {
        if (effect.capability_id === 'publish_document') publishResolver.current = resolve
        else if (effect.capability_id === 'create_document') createResolver.current = resolve
        else organizationResolver.current = resolve
      })
    },
    [showPendingEffect],
  )
  useEffect(
    () => () => {
      publishResolver.current = null
      createResolver.current = null
      organizationResolver.current = null
    },
    [],
  )
  // ChatKit initializes a heavy web-component session from its options. To keep a
  // single instance alive across document-tab switches, the options must stay
  // referentially stable; the live document/selection/refresh are read through a
  // ref instead of being baked into the options on every render.
  const liveRef = useRef({
    documentId: activeDocument?.document_id ?? null,
    revisionId: activeDocument?.current_revision_id ?? null,
    pdfPageNumber: pdfPageNumber ?? null,
    annotationId: annotationId ?? null,
    selectedText: activeSelectedText,
    refreshProposals,
    navigate,
    requestEffectReview,
  })
  useEffect(() => {
    liveRef.current = {
      documentId: activeDocument?.document_id ?? null,
      revisionId: activeDocument?.current_revision_id ?? null,
      pdfPageNumber: pdfPageNumber ?? null,
      annotationId: annotationId ?? null,
      selectedText: activeSelectedText,
      refreshProposals,
      navigate,
      requestEffectReview,
    }
  })
  useEffect(() => {
    const pending = effectsQuery.data?.find(
      (effect) => effect.status === 'pending_approval' && !settledEffectIds.has(effect.effect_id),
    )
    if (pendingEffect || !pending) return
    let active = true
    queueMicrotask(() => {
      if (active && !settledEffectIds.has(pending.effect_id)) showPendingEffect(pending)
    })
    return () => {
      active = false
    }
  }, [effectsQuery.data, pendingEffect, settledEffectIds, showPendingEffect])
  const handleThreadChange = useCallback(
    ({ threadId: nextThreadId }: { threadId: string | null }) => {
      setThreadId(nextThreadId)
      if (nextThreadId) localStorage.setItem(threadStorageKey, nextThreadId)
      else localStorage.removeItem(threadStorageKey)
    },
    [threadStorageKey],
  )
  const handleResponseEnd = useCallback(() => void liveRef.current.refreshProposals(), [])
  const handleCitationDeeplink = useCallback(
    ({ name, data }: { name: string; data?: CitationDataPayload }) => {
      if (name !== 'document') return
      const target = citationTargetFromData(data)
      if (!target) return
      setOpenedCitation(target)
      void liveRef.current.navigate({ href: citationHref(target) }).then(() => {
        announceCitationNavigation(target)
      })
    },
    [],
  )
  // A full remount is the only reliable way to recover a wedged ChatKit frame;
  // clearing the stored thread also protects against server-side resets that
  // would otherwise leave the frame blank with no visible error.
  const resetChatSurface = useCallback(() => {
    localStorage.removeItem(threadStorageKey)
    setThreadId(null)
    setChatEpoch((epoch) => epoch + 1)
  }, [threadStorageKey])
  const models = useMemo(
    () =>
      (configQuery.data?.available_models ?? []).map((model) => ({
        id: model.id,
        label: model.name,
        description: `${model.connection_name} · ${model.protocol === 'openai_responses' ? 'Responses' : 'Chat Completions'} · ${model.compatibility}`,
        default: model.id === configQuery.data?.default_model,
      })),
    [configQuery.data],
  )
  const chatTypography = useMemo(
    () => ({
      fontFamily: uiFonts.find((font) => font.id === preferences.uiFont)?.stack,
      baseSize: 14 as const,
    }),
    [preferences.uiFont],
  )
  const chatDensity = useMemo<'compact' | 'normal' | 'spacious'>(
    () =>
      preferences.uiDensity === 'compact'
        ? 'compact'
        : preferences.uiDensity === 'comfortable'
          ? 'spacious'
          : 'normal',
    [preferences.uiDensity],
  )
  const cancelPublication = async () => {
    if (!pendingEffect || publishing) return
    setPublishing(true)
    try {
      const decision = await api.decideChatEffect(pendingEffect, 'deny')
      setSettledEffectIds((effectIds) => new Set(effectIds).add(pendingEffect.effect_id))
      publishResolver.current?.(decision.client_result)
      publishResolver.current = null
      removeEffectFromPendingCache(pendingEffect.effect_id)
      setPendingPublication(null)
      setPendingEffect(null)
      setPublishError(false)
      await queryClient.invalidateQueries({ queryKey: ['chat-effects', threadId] })
    } catch {
      setPublishError(true)
    } finally {
      setPublishing(false)
    }
  }
  const approvePublication = async () => {
    if (!pendingPublication || !pendingEffect || publishing) return
    setPublishing(true)
    setPublishError(false)
    try {
      const decision = await api.decideChatEffect(pendingEffect, 'approve')
      setSettledEffectIds((effectIds) => new Set(effectIds).add(pendingEffect.effect_id))
      const result = issuedPublicationSchema.parse(decision.client_result)
      await queryClient.invalidateQueries({ queryKey: ['publication', pendingPublication.documentId] })
      publishResolver.current?.(decision.client_result)
      publishResolver.current = null
      removeEffectFromPendingCache(pendingEffect.effect_id)
      setPublished(result)
      setPendingPublication(null)
      setPendingEffect(null)
      await queryClient.invalidateQueries({ queryKey: ['chat-effects', threadId] })
    } catch {
      setPublishError(true)
    } finally {
      setPublishing(false)
    }
  }
  const cancelCreate = async () => {
    if (!pendingEffect || creating) return
    setCreating(true)
    try {
      const decision = await api.decideChatEffect(pendingEffect, 'deny')
      setSettledEffectIds((effectIds) => new Set(effectIds).add(pendingEffect.effect_id))
      createResolver.current?.(decision.client_result)
      createResolver.current = null
      removeEffectFromPendingCache(pendingEffect.effect_id)
      setPendingCreate(null)
      setPendingEffect(null)
      setCreateError(false)
      await queryClient.invalidateQueries({ queryKey: ['chat-effects', threadId] })
    } catch {
      setCreateError(true)
    } finally {
      setCreating(false)
    }
  }
  const approveCreate = async () => {
    if (!pendingCreate || !pendingEffect || creating) return
    setCreating(true)
    setCreateError(false)
    try {
      const decision = await api.decideChatEffect(pendingEffect, 'approve')
      setSettledEffectIds((effectIds) => new Set(effectIds).add(pendingEffect.effect_id))
      const result = documentSchema.parse(decision.client_result)
      createResolver.current?.(decision.client_result)
      createResolver.current = null
      removeEffectFromPendingCache(pendingEffect.effect_id)
      setPendingCreate(null)
      setPendingEffect(null)
      setCreatedDocument(result)
      await queryClient.invalidateQueries({ queryKey: ['documents'] })
      await queryClient.invalidateQueries({ queryKey: ['chat-effects', threadId] })
    } catch {
      setCreateError(true)
    } finally {
      setCreating(false)
    }
  }
  const decideOrganization = async (verdict: 'approve' | 'deny') => {
    if (!pendingEffect || !pendingOrganization || creating) return
    setCreating(true)
    setCreateError(false)
    try {
      const decision = await api.decideChatEffect(pendingEffect, verdict)
      setSettledEffectIds((effectIds) => new Set(effectIds).add(pendingEffect.effect_id))
      organizationResolver.current?.(decision.client_result)
      organizationResolver.current = null
      removeEffectFromPendingCache(pendingEffect.effect_id)
      setPendingOrganization(null)
      setPendingEffect(null)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['documents'] }),
        queryClient.invalidateQueries({ queryKey: ['folders'] }),
        queryClient.invalidateQueries({ queryKey: ['chat-effects', threadId] }),
      ])
    } catch {
      setCreateError(true)
    } finally {
      setCreating(false)
    }
  }
  const resumeEffect = async (effect: ChatEffect) => {
    if (resumingEffectId) return
    setResumingEffectId(effect.effect_id)
    setResumeErrorIds((effectIds) => {
      const next = new Set(effectIds)
      next.delete(effect.effect_id)
      return next
    })
    try {
      const decision = await api.decideChatEffect(effect, 'approve')
      if (effect.capability_id === 'create_document') {
        setCreatedDocument(documentSchema.parse(decision.client_result))
        await queryClient.invalidateQueries({ queryKey: ['documents'] })
      } else if (effect.capability_id === 'publish_document') {
        const result = issuedPublicationSchema.parse(decision.client_result)
        setPublished(result)
        await queryClient.invalidateQueries({ queryKey: ['publication', effect.preview.document_id] })
      } else {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['documents'] }),
          queryClient.invalidateQueries({ queryKey: ['folders'] }),
        ])
      }
      removeEffectFromPendingCache(effect.effect_id)
    } catch {
      setResumeErrorIds((effectIds) => new Set(effectIds).add(effect.effect_id))
    } finally {
      await queryClient.invalidateQueries({ queryKey: ['chat-effects', threadId] })
      setResumingEffectId(null)
    }
  }

  const lastDocumentIdRef = useRef(activeDocument?.document_id ?? null)
  const [contextSwitchEvent, setContextSwitchEvent] = useState<{
    documentTitle: string
    revisionId: string
  } | null>(null)

  useEffect(() => {
    const nextDocumentId = activeDocument?.document_id ?? null
    if (lastDocumentIdRef.current !== nextDocumentId) {
      lastDocumentIdRef.current = nextDocumentId
      setContextSwitchEvent(
        activeDocument
          ? { documentTitle: activeDocument.title, revisionId: activeDocument.current_revision_id }
          : null,
      )
    }
  }, [activeDocument])

  return (
    <div className={`chat-panel ${compact ? 'chat-panel-compact' : ''}`}>
      {!compact && (
        <ChatContextBanner
          document={activeDocument}
          selectedText={activeSelectedText}
          onClear={onClearContext}
        />
      )}
      {contextSwitchEvent && (
        <div className="chat-context-switch-event" role="status" aria-live="polite">
          <FileText size="var(--icon-inline)" />
          <span>
            Context switched to <strong>{contextSwitchEvent.documentTitle}</strong> (
            <code>rev {shortId(contextSwitchEvent.revisionId)}</code>)
          </span>
        </div>
      )}
      {configQuery.isLoading ? (
        <StateMessage kind="loading" title="Preparing workspace chat" />
      ) : configQuery.isError || !configQuery.data ? (
        <StateMessage
          kind="error"
          title="Chat configuration could not be loaded"
          description="Check the Sangam server, then retry."
          action={
            <button className="secondary-action" onClick={() => void configQuery.refetch()}>
              Retry
            </button>
          }
        />
      ) : configQuery.data.transport_status !== 'ready' ? (
        <StateMessage
          kind="error"
          title="ChatKit browser transport needs setup"
          description={configQuery.data.transport_message}
          action={
            <button className="secondary-action" onClick={() => void configQuery.refetch()}>
              Check again
            </button>
          }
        />
      ) : (
        <>
          {!configQuery.data.inference_enabled && (
            <div className={`chat-runtime-status status-${configQuery.data.status}`} role="status">
              <strong>{configQuery.data.status.replace('_', ' ')}</strong>
              <span>{configQuery.data.message} History and proposal review remain available.</span>
            </div>
          )}
          {configQuery.data.autonomy_mode === 'workspace' && (
            <div className="chat-autonomy-banner" role="status">
              <strong>YOLO · private workspace</strong>
              <span>
                Bounded creation and organization effects can run without review. Publication still pauses for
                approval.
              </span>
            </div>
          )}
          {!compact && <SelectionChip selectedText={activeSelectedText} />}
          {openedCitation && (
            <CitationNavigationStatus
              target={openedCitation}
              currentDocument={activeDocument}
              onClose={() => setOpenedCitation(null)}
            />
          )}
          {pendingPublication && pendingEffect && !settledEffectIds.has(pendingEffect.effect_id) && (
            <PublishConfirmationCard
              request={pendingPublication}
              publishing={publishing}
              error={publishError}
              onApprove={() => void approvePublication()}
              onCancel={() => void cancelPublication()}
            />
          )}
          {pendingCreate && pendingEffect && !settledEffectIds.has(pendingEffect.effect_id) && (
            <ChatCreateConfirmation
              request={pendingCreate}
              pending={creating}
              error={createError}
              onApprove={() => void approveCreate()}
              onCancel={() => void cancelCreate()}
            />
          )}
          {pendingOrganization && pendingEffect && !settledEffectIds.has(pendingEffect.effect_id) && (
            <OrganizationPlanConfirmation
              effect={pendingEffect}
              operations={pendingOrganization}
              pending={creating}
              error={createError}
              onApprove={() => void decideOrganization('approve')}
              onDeny={() => void decideOrganization('deny')}
            />
          )}
          {createdDocument && (
            <CreatedFromChat document={createdDocument} onDismiss={() => setCreatedDocument(null)} />
          )}
          {published && <PublishedFromChat result={published} onDismiss={() => setPublished(null)} />}
          <DurableEffectsSummary
            effects={(effectsQuery.data ?? []).filter(
              (effect) =>
                effect.status !== 'pending_approval' &&
                effect.resource_id !== createdDocument?.document_id &&
                effect.resource_id !== published?.publication_id,
            )}
            resumingEffectId={resumingEffectId}
            resumeErrorIds={resumeErrorIds}
            onResume={(effect) => void resumeEffect(effect)}
          />
          {script.status === 'loading' && <StateMessage kind="loading" title="Loading chat interface" />}
          {script.status === 'error' && (
            <StateMessage
              kind="error"
              title="The ChatKit interface could not be loaded"
              description="The browser could not load ChatKit's script. Check the connection, then retry."
              action={
                <button className="secondary-action" onClick={script.retry}>
                  Retry ChatKit
                </button>
              }
            />
          )}
          {script.status === 'ready' && configQuery.data && (
            <WorkspaceChatSurface
              key={chatEpoch}
              liveRef={liveRef}
              theme={preferences.theme === 'midnight' ? 'dark' : 'light'}
              typography={chatTypography}
              density={chatDensity}
              domainKey={configQuery.data.domain_key}
              inferenceEnabled={configQuery.data.inference_enabled}
              models={models}
              initialThreadId={threadId}
              activeThreadId={threadId}
              onThreadChange={handleThreadChange}
              onResponseEnd={handleResponseEnd}
              hasDocument={Boolean(activeDocument)}
              hasSelection={Boolean(activeSelectedText)}
              onCitationDeeplink={handleCitationDeeplink}
              onReset={resetChatSurface}
              compact={compact}
            />
          )}
          {proposalsQuery.isLoading ? (
            activeDocument && <StateMessage compact kind="loading" title="Loading edit proposals" />
          ) : proposalsQuery.isError ? (
            <div className="chat-proposals-error" role="alert">
              <span>Proposals could not be loaded.</span>
              <button className="secondary-action" onClick={() => void proposalsQuery.refetch()}>
                Retry
              </button>
            </div>
          ) : (
            activeDocument &&
            onDocumentUpdated && (
              <ProposalReviewList
                proposals={proposalsQuery.data ?? []}
                document={activeDocument}
                onDocumentUpdated={onDocumentUpdated}
                onChanged={() => void refreshProposals()}
              />
            )
          )}
        </>
      )}
    </div>
  )
}

export type PublishConfirmationInput = {
  document_id?: string
  document_title?: string
  slug?: string
  access_policy?: string
}

const publishConfirmationParamsSchema = z.object({
  document_id: z.string().trim().min(1).max(200),
  document_title: z.string().trim().optional(),
  slug: z.string().trim().min(1).max(200),
  access_policy: z.enum(['private', 'unlisted', 'public']),
})

export function parsePublishConfirmation(
  params: PublishConfirmationInput | null | undefined,
): PublishConfirmationRequest | null {
  const result = publishConfirmationParamsSchema.safeParse(params)
  if (!result.success) {
    return null
  }
  return {
    documentId: result.data.document_id,
    documentTitle: result.data.document_title || 'Untitled document',
    slug: result.data.slug,
    accessPolicy: result.data.access_policy,
  }
}

export function PublishConfirmationCard({
  request,
  publishing,
  error,
  onApprove,
  onCancel,
}: {
  request: PublishConfirmationRequest
  publishing: boolean
  error: boolean
  onApprove: () => void
  onCancel: () => void
}) {
  const reach = {
    private: 'Only authenticated Sangam users can open it.',
    unlisted: 'Anyone with the one-time access link can open it.',
    public: 'Anyone who knows or discovers the URL can open it.',
  }[request.accessPolicy]
  return (
    <section className="chat-effect-confirmation" role="alertdialog" aria-labelledby="publish-confirm-title">
      <div>
        <p className="eyebrow">External side effect</p>
        <strong id="publish-confirm-title">Publish “{request.documentTitle}”?</strong>
        <span>
          Chat requested <b>{request.accessPolicy}</b> access at <code>/p/{request.slug}</code>. {reach}
        </span>
        <small>No publication is created unless you approve this exact request.</small>
        {error && (
          <p className="error-text">
            Publishing failed. Nothing was confirmed to the assistant; retry or cancel.
          </p>
        )}
      </div>
      <div className="chat-effect-actions">
        <button type="button" className="primary-button" disabled={publishing} onClick={onApprove}>
          {publishing ? 'Publishing…' : `Approve ${request.accessPolicy} publication`}
        </button>
        <button type="button" className="secondary-action" disabled={publishing} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </section>
  )
}

export function CreatedFromChat({
  document,
  onDismiss,
}: {
  document: Pick<Document, 'document_id' | 'title'>
  onDismiss: () => void
}) {
  const navigate = useNavigate()
  return (
    <CompletionRow
      label="Document created"
      detail={
        <>
          “{document.title}” · <code>{shortId(document.document_id)}</code>
        </>
      }
      openLabel="Open document"
      onOpen={() => void navigate({ href: `/documents/${document.document_id}` })}
      onDismiss={onDismiss}
    />
  )
}

function PublishedFromChat({ result, onDismiss }: { result: IssuedPublication; onDismiss: () => void }) {
  const href = result.url
  if (result.token) {
    return (
      <OneTimeSecret
        compact
        title="Publication approved · copy this link now"
        description="The access token is shown only in your browser and is not returned to the assistant."
        value={`${href}#token=${result.token}`}
        copyLabel="Copy publication link"
        dismissLabel="I saved it"
        onDismiss={onDismiss}
      />
    )
  }
  return (
    <CompletionRow
      label="Publication created"
      detail={result.access_policy}
      openLabel="Open publication"
      href={href}
      onDismiss={onDismiss}
    />
  )
}

export function DurableEffectStatus({
  effect,
  resuming,
  resumeFailed,
  onResume,
}: {
  effect: ChatEffect
  resuming: boolean
  resumeFailed: boolean
  onResume: () => void
}) {
  const effectResultSchema = z.object({ url: z.string().optional() })
  const failed = effect.status === 'failed'
  const retrySafe = effect.failure?.retry_safe === true
  const interrupted = effect.status === 'approved' || effect.status === 'executing'
  const canResume = interrupted || (failed && retrySafe)
  const noun =
    effect.capability_id === 'publish_document'
      ? 'Publication'
      : effect.capability_id === 'apply_workspace_organization_plan'
        ? 'Organization plan'
        : 'Document creation'
  const href =
    effectResultSchema.safeParse(effect.result).data?.url ??
    (effect.capability_id === 'create_document' && effect.resource_id
      ? `/documents/${effect.resource_id}`
      : undefined)
  return (
    <div
      className={`chat-effect-complete ${failed || interrupted ? 'is-failed' : ''}`}
      role={failed || resumeFailed ? 'alert' : 'status'}
    >
      <div className="chat-effect-complete-copy">
        <strong>
          {interrupted ? 'Approved effect ready to resume' : failed ? `${noun} failed` : `${noun} completed`}
        </strong>
        <span>
          {resumeFailed
            ? 'Resume failed. The stored operation key makes another attempt safe.'
            : interrupted
              ? 'The exact approval is stored. Resume with the original operation key.'
              : failed
                ? `${String(effect.failure?.message ?? 'The effect could not be completed.')} ${retrySafe ? 'Retry is safe.' : 'A new review is required.'}`
                : `Recorded effect ${shortId(effect.effect_id)}`}
        </span>
      </div>
      {canResume && (
        <button type="button" className="secondary-action" disabled={resuming} onClick={onResume}>
          {resuming ? 'Resuming…' : failed ? 'Retry safely' : 'Resume safely'}
        </button>
      )}
      {href && (
        <a className="secondary-action" href={href}>
          <ExternalLink size="var(--icon-inline)" />
          Open result
        </a>
      )}
    </div>
  )
}

function OrganizationPlanConfirmation({
  effect,
  operations,
  pending,
  error,
  onApprove,
  onDeny,
}: {
  effect: ChatEffect
  operations: OrganizationOperation[]
  pending: boolean
  error: boolean
  onApprove: () => void
  onDeny: () => void
}) {
  const expires = new Date(effect.expires_at).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  })
  return (
    <section
      className="chat-effect-confirmation organization-plan-review"
      role="alertdialog"
      aria-labelledby="organization-plan-title"
    >
      <header>
        <p className="eyebrow">Private workspace effect</p>
        <h3 id="organization-plan-title">
          Review {operations.length} organization change{operations.length === 1 ? '' : 's'}
        </h3>
        <p>
          Requested by {effect.requested_by} · expires at {expires}
        </p>
      </header>
      <details open={operations.length <= 6}>
        <summary>
          <FolderInput size="var(--icon-inline)" /> Inspect exact plan
          <ChevronDown size="var(--icon-inline)" />
        </summary>
        <ol className="organization-plan-operations">
          {operations.map((operation, index) => (
            <li key={`${operation.kind}-${index}`}>
              <strong>{organizationOperationTitle(operation)}</strong>
              <span>{organizationOperationDetail(operation)}</span>
            </li>
          ))}
        </ol>
      </details>
      {error && (
        <p className="error-text" role="alert">
          The decision could not be completed. Refresh the plan before trying again.
        </p>
      )}
      <div className="chat-effect-actions">
        <button type="button" className="secondary-action" disabled={pending} onClick={onDeny}>
          Deny
        </button>
        <button type="button" className="primary-button" disabled={pending} onClick={onApprove}>
          {pending ? 'Applying…' : 'Approve exact plan'}
        </button>
      </div>
    </section>
  )
}

function organizationOperationTitle(operation: OrganizationOperation) {
  if (operation.kind === 'create_folder') return `Create folder ${operation.path}`
  if (operation.kind === 'move_document') return `Move document ${shortId(operation.document_id)}`
  if (operation.kind === 'trash_document') return `Move document ${shortId(operation.document_id)} to Trash`
  if (operation.kind === 'move_folder') return `Move folder ${operation.expected_source_path}`
  if (operation.kind === 'update_document_metadata')
    return `Update document ${shortId(operation.document_id)} metadata`
  return `Update folder ${shortId(operation.folder_id)} metadata`
}

function organizationOperationDetail(operation: OrganizationOperation) {
  if (operation.kind === 'create_folder')
    return `New path: ${operation.path} · category ${operation.category ?? 'none'} · ${operation.tag_ids.length} tags`
  if (operation.kind === 'move_document')
    return `${operation.expected_source_path} → ${operation.destination_path} · revision ${shortId(operation.expected_revision_id)}`
  if (operation.kind === 'trash_document')
    return `${operation.expected_source_path} → Trash · revision ${shortId(operation.expected_revision_id)}`
  if (operation.kind === 'move_folder')
    return `${operation.expected_source_path} → ${operation.destination_path} · ${operation.expected_descendant_documents} descendant documents`
  return `Category ${operation.expected_category ?? 'none'} → ${operation.category ?? 'none'} · tags ${operation.expected_tag_ids.length ? operation.expected_tag_ids.join(', ') : 'none'} → ${operation.tag_ids.length ? operation.tag_ids.join(', ') : 'none'} · metadata version ${operation.expected_metadata_version}`
}

function DurableEffectsSummary({
  effects,
  resumingEffectId,
  resumeErrorIds,
  onResume,
}: {
  effects: ChatEffect[]
  resumingEffectId: string | null
  resumeErrorIds: Set<string>
  onResume: (effect: ChatEffect) => void
}) {
  if (!effects.length) return null
  const settled = effects.filter((effect) => effect.status === 'completed')
  const needsAttention = effects.filter((effect) => effect.status !== 'completed')
  const creations = settled.filter((effect) => effect.capability_id === 'create_document').length
  const publications = settled.filter((effect) => effect.capability_id === 'publish_document').length
  const plans = settled.filter(
    (effect) => effect.capability_id === 'apply_workspace_organization_plan',
  ).length
  const summary = [
    creations ? `${creations} document${creations === 1 ? '' : 's'} created` : '',
    publications ? `${publications} publication${publications === 1 ? '' : 's'} completed` : '',
    plans ? `${plans} organization plan${plans === 1 ? '' : 's'} applied` : '',
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <div className="chat-effect-history">
      {needsAttention.map((effect) => (
        <DurableEffectStatus
          key={effect.effect_id}
          effect={effect}
          resuming={resumingEffectId === effect.effect_id}
          resumeFailed={resumeErrorIds.has(effect.effect_id)}
          onResume={() => onResume(effect)}
        />
      ))}
      {settled.length > 0 && (
        <details className="chat-effect-stack">
          <summary>
            <span>
              <strong>{summary}</strong>
              <small>Completed effects are collapsed to keep the conversation visible.</small>
            </span>
            <ChevronDown size="var(--icon-inline)" />
          </summary>
          <div>
            {settled.map((effect) => (
              <DurableEffectStatus
                key={effect.effect_id}
                effect={effect}
                resuming={false}
                resumeFailed={false}
                onResume={() => onResume(effect)}
              />
            ))}
          </div>
        </details>
      )}
    </div>
  )
}

export function CompletionRow({
  label,
  detail,
  openLabel,
  href,
  onOpen,
  onDismiss,
}: {
  label: string
  detail?: React.ReactNode
  openLabel: string
  href?: string
  onOpen?: () => void
  onDismiss: () => void
}) {
  const openControl = href ? (
    <a className="secondary-action" href={href} target="_blank" rel="noreferrer">
      <ExternalLink size="var(--icon-inline)" />
      {openLabel}
    </a>
  ) : (
    <button type="button" className="secondary-action" onClick={onOpen}>
      {openLabel}
    </button>
  )
  return (
    <div className="chat-effect-complete" role="status">
      <div className="chat-effect-complete-copy">
        <strong>{label}</strong>
        {detail && <span>{detail}</span>}
      </div>
      <div className="chat-effect-complete-actions">
        {openControl}
        <button type="button" className="secondary-action" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </div>
  )
}

export function CitationNavigationStatus({
  target,
  currentDocument,
  onClose,
}: {
  target: CitationTarget
  currentDocument: (Pick<Document, 'document_id'> & Partial<Pick<Document, 'current_revision_id'>>) | null
  onClose: () => void
}) {
  const atDocument = currentDocument?.document_id === target.documentId
  const stale = Boolean(
    atDocument && target.revisionId && target.revisionId !== currentDocument?.current_revision_id,
  )
  return (
    <aside className={`chat-citation-status ${stale ? 'stale' : ''}`} aria-label="Opened chat citation">
      <div>
        <strong>
          {stale
            ? 'Source changed since the answer'
            : atDocument
              ? 'Opened cited evidence'
              : 'Opening cited evidence…'}
        </strong>
        <small>
          {target.revisionId ? `Revision ${shortId(target.revisionId)}` : 'Current revision'}
          {target.pageNumber ? ` · PDF page ${target.pageNumber}` : ''}
          {target.annotationId ? ` · annotation ${shortId(target.annotationId)}` : ''}
        </small>
      </div>
      <button type="button" className="secondary-action" onClick={onClose}>
        Dismiss
      </button>
    </aside>
  )
}

function shortId(value: string) {
  return value.length > 12 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value
}

export function ChatContextBanner({
  document,
  selectedText,
  onClear,
}: {
  document: Document | null
  selectedText: string
  onClear?: () => void
}) {
  return (
    <div className="chat-context-banner" aria-label="Active chat context">
      <div className="chat-context-main">
        <span className="chat-context-title">{document?.title ?? 'Whole workspace'}</span>
        <span className="chat-context-meta">
          {document ? <code>rev {shortId(document.current_revision_id)}</code> : 'No document pinned'}
          {selectedText.length > 0 && <span> · {selectedText.length.toLocaleString()} chars selected</span>}
        </span>
      </div>
      {document && onClear && (
        <button type="button" className="icon-button" aria-label="Remove document context" onClick={onClear}>
          <X size="var(--icon-control)" />
        </button>
      )}
    </div>
  )
}

export function SelectionChip({ selectedText }: { selectedText: string }) {
  if (selectedText.length === 0) return null
  const truncated = selectedText.length > SELECTION_LIMIT
  const sentCount = Math.min(selectedText.length, SELECTION_LIMIT)
  const preview = selectedText.slice(0, SELECTION_LIMIT)
  return (
    <details className="chat-selection-chip">
      <summary>
        <span className="chat-selection-chip-label">
          {truncated
            ? `Using selection: ${sentCount.toLocaleString()} of ${selectedText.length.toLocaleString()} chars (truncated)`
            : `Using selection: ${sentCount.toLocaleString()} chars`}
        </span>
      </summary>
      <pre className="chat-selection-chip-preview">{preview}</pre>
      {truncated && (
        <p className="chat-selection-chip-note">
          Only the first {SELECTION_LIMIT.toLocaleString()} characters are sent to the assistant. Narrow your
          selection to send a specific passage.
        </p>
      )}
    </details>
  )
}

function ProposalReviewList({
  proposals,
  document,
  onDocumentUpdated,
  onChanged,
}: {
  proposals: ChatProposal[]
  document: Document
  onDocumentUpdated: (document: Document, replaceContent?: boolean) => void
  onChanged: () => void
}) {
  const reviewable = proposals.filter(
    (proposal) => proposal.status === 'pending' || proposal.status === 'stale',
  )
  if (reviewable.length === 0) return null
  return (
    <section className="chat-proposals" aria-label="Chat edit proposals">
      <p className="eyebrow">Review proposed edits</p>
      {reviewable.map((proposal) => (
        <ProposalReview
          key={proposal.proposal_id}
          proposal={proposal}
          document={document}
          onDocumentUpdated={onDocumentUpdated}
          onChanged={onChanged}
        />
      ))}
    </section>
  )
}

function ProposalReview({
  proposal,
  document,
  onDocumentUpdated,
  onChanged,
}: {
  proposal: ChatProposal
  document: Document
  onDocumentUpdated: (document: Document, replaceContent?: boolean) => void
  onChanged: () => void
}) {
  const [dismissing, setDismissing] = useState(false)
  const [reason, setReason] = useState('')
  const apply = useMutation({
    mutationFn: () => api.applyChatProposal(proposal),
    onSuccess: async () => {
      onDocumentUpdated(await api.getDocument(document.document_id), true)
      onChanged()
    },
    onError: onChanged,
  })
  const dismiss = useMutation({
    mutationFn: () => api.dismissChatProposal(proposal.proposal_id, reason),
    onSuccess: onChanged,
  })
  const reload = useMutation({
    mutationFn: () => api.getDocument(document.document_id),
    onSuccess: (nextDocument) => {
      onDocumentUpdated(nextDocument, true)
      onChanged()
    },
  })
  const current = document.current_revision_id === proposal.expected_revision_id
  const isStale = proposal.status === 'stale' || apply.isError
  const busy = apply.isPending || dismiss.isPending || reload.isPending
  return (
    <article className="chat-proposal">
      <header>
        <strong>{proposal.summary ?? 'Proposed document edit'}</strong>
        <span className={`scope-badge ${current && !isStale ? 'workspace' : ''}`}>
          {isStale ? 'Document changed' : current ? 'Ready to review' : 'Document changed'}
        </span>
      </header>
      <RevisionMergeView original={document.content} modified={proposal.content} />
      {isStale && (
        <div className="chat-proposal-stale">
          <p className="error-text">
            The document changed while you were reviewing, so this edit can no longer apply. Reload to see the
            current text, then ask again if you still want the change.
          </p>
          <button className="secondary-action" disabled={busy} onClick={() => reload.mutate()}>
            {reload.isPending ? 'Reloading…' : 'Reload document'}
          </button>
        </div>
      )}
      {dismissing ? (
        <div className="chat-proposal-dismiss">
          <label>
            Reason for dismissing (optional)
            <input
              value={reason}
              maxLength={500}
              placeholder="e.g. Wrong section, or I edited it myself"
              onChange={(event) => setReason(event.target.value)}
              autoFocus
            />
          </label>
          <div className="chat-proposal-actions">
            <button className="primary-button" disabled={busy} onClick={() => dismiss.mutate()}>
              {dismiss.isPending ? 'Dismissing…' : 'Confirm dismiss'}
            </button>
            <button
              className="secondary-action"
              disabled={busy}
              onClick={() => {
                setDismissing(false)
                setReason('')
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="chat-proposal-actions">
          {!isStale && (
            <button className="primary-button" disabled={!current || busy} onClick={() => apply.mutate()}>
              {apply.isPending ? 'Applying…' : 'Apply reviewed edit'}
            </button>
          )}
          <button className="secondary-action" disabled={busy} onClick={() => setDismissing(true)}>
            Dismiss
          </button>
        </div>
      )}
      {dismiss.isError && <p className="error-text">The proposal could not be dismissed.</p>}
    </article>
  )
}

type ChatFramePhase = 'connecting' | 'ready' | 'error'

const CHAT_FRAME_TIMEOUT_MS = 15_000

type LiveChatContext = {
  documentId: string | null
  revisionId: string | null
  pdfPageNumber: number | null
  annotationId: string | null
  selectedText: string
  refreshProposals: () => void
  navigate: ReturnType<typeof useNavigate>
  requestEffectReview: (params: {
    effect_id?: string
    argument_digest?: string
  }) => Promise<Record<string, JsonPayload>>
}

const chatTurnRequestSchema = z.object({
  type: z.enum(['threads.create', 'threads.add_user_message']),
})

export function chatRequestNeedsTurnContext(body: BodyInit | null | undefined): boolean {
  if (!body || Object.prototype.toString.call(body) !== '[object String]') return false
  try {
    // SAFETY: body string representation verified via Object.prototype.toString
    const request = JSON.parse(body as string)
    return chatTurnRequestSchema.safeParse(request).success
  } catch {
    return false
  }
}

export function CompactChatControls({
  onNewChat,
  onShowHistory,
}: {
  onNewChat: () => void
  onShowHistory: () => void
}) {
  return (
    <div className="chat-compact-controls" aria-label="Document chat controls">
      <button
        type="button"
        className="icon-button"
        aria-label="New chat"
        title="New chat"
        onClick={onNewChat}
      >
        <Plus size="var(--icon-control)" />
      </button>
      <button
        type="button"
        className="icon-button"
        aria-label="Chat history"
        title="Chat history"
        onClick={onShowHistory}
      >
        <History size="var(--icon-control)" />
      </button>
    </div>
  )
}

export function hasMountedChatInterface(host: HTMLElement) {
  const root = host.shadowRoot
  if (!root) return false
  return Boolean(root.querySelector('iframe, .ck-wrapper, [contenteditable="true"], textarea'))
}

function WorkspaceChatSurface({
  liveRef,
  theme,
  typography,
  density,
  domainKey,
  inferenceEnabled,
  models,
  initialThreadId,
  activeThreadId,
  onThreadChange,
  onResponseEnd,
  hasDocument,
  hasSelection,
  onCitationDeeplink,
  onReset,
  compact,
}: {
  liveRef: React.MutableRefObject<LiveChatContext>
  theme: 'dark' | 'light'
  typography: TypographyOption
  density: 'compact' | 'normal' | 'spacious'
  domainKey: string
  inferenceEnabled: boolean
  models: Array<{ id: string; label: string; description: string; default?: boolean }>
  initialThreadId: string | null
  activeThreadId: string | null
  onThreadChange: (thread: { threadId: string | null }) => void
  onResponseEnd: () => void
  hasDocument: boolean
  hasSelection: boolean
  onCitationDeeplink: (event: { name: string; data?: CitationDataPayload }) => void
  onReset: () => void
  compact: boolean
}) {
  const [phase, setPhase] = useState<ChatFramePhase>('connecting')
  const [isResponding, setIsResponding] = useState(false)
  const responseAbortRef = useRef<AbortController | null>(null)
  useEffect(() => {
    // ChatKit can fail silently (blocked CDN subresource, stale thread id after a
    // server reset). If the frame never reports ready, surface a recoverable
    // error instead of leaving the panel blank.
    const timeout = window.setTimeout(
      () => setPhase((current) => (current === 'connecting' ? 'error' : current)),
      CHAT_FRAME_TIMEOUT_MS,
    )
    return () => window.clearTimeout(timeout)
  }, [])
  const customFetch = useCallback(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      if (liveRef.current.documentId) {
        headers.set('X-Sangam-Document-ID', liveRef.current.documentId)
        if (liveRef.current.revisionId) headers.set('X-Sangam-Revision-ID', liveRef.current.revisionId)
        else headers.delete('X-Sangam-Revision-ID')
        headers.delete('X-Sangam-Workspace-Context')
      } else {
        headers.delete('X-Sangam-Document-ID')
        headers.delete('X-Sangam-Revision-ID')
        headers.set('X-Sangam-Workspace-Context', '1')
      }
      headers.set('X-Sangam-Chat-Entry', liveRef.current.documentId ? 'document' : 'workspace')
      const startsTurn = chatRequestNeedsTurnContext(init?.body)
      if (startsTurn) {
        const snapshot = await api.createChatTurnContext({
          entry_point: liveRef.current.documentId ? 'document' : 'workspace',
          document_id: liveRef.current.documentId,
          revision_id: liveRef.current.revisionId,
          pdf_page_number: liveRef.current.pdfPageNumber,
          annotation_id: liveRef.current.annotationId,
          selected_text: liveRef.current.selectedText.slice(0, SELECTION_LIMIT),
        })
        headers.set('X-Sangam-Context-ID', snapshot.context_id)
      } else {
        headers.delete('X-Sangam-Context-ID')
      }
      const controller = startsTurn ? new AbortController() : null
      if (controller) {
        responseAbortRef.current = controller
        setIsResponding(true)
        if (init?.signal?.aborted) controller.abort()
        else init?.signal?.addEventListener('abort', () => controller.abort(), { once: true })
      }
      return fetch(input, { ...init, headers, signal: controller?.signal ?? init?.signal })
    },
    [liveRef],
  )
  const chatkitTheme = useMemo(
    () => ({ colorScheme: theme, typography, density }),
    [theme, typography, density],
  )
  const chatkit = useChatKit({
    api: {
      url: '/api/v1/chatkit',
      domainKey,
      fetch: customFetch,
    },
    frameTitle: 'Workspace chat',
    initialThread: initialThreadId ?? undefined,
    theme: chatkitTheme,
    header: compact ? { enabled: false } : { enabled: true, title: { text: 'Workspace chat' } },
    history: { enabled: true, showDelete: !compact, showRename: !compact },
    startScreen: {
      greeting: compact ? 'Ask about this document' : 'Ask about this workspace',
      prompts: [
        {
          label: hasDocument ? 'Summarize this document' : 'Find related work',
          prompt: hasDocument
            ? 'Summarize the current document with citations.'
            : 'Find related documents in this workspace and summarize their connection with citations.',
        },
        {
          label: hasSelection
            ? 'Review selected text'
            : hasDocument
              ? 'Find related documents'
              : 'Search the workspace',
          prompt: hasSelection
            ? 'Review the selected text and suggest improvements.'
            : hasDocument
              ? 'Find documents related to the current document and explain the connection with citations.'
              : 'Search the workspace for the most important recent material and cite the sources.',
        },
      ],
    },
    composer: {
      placeholder: inferenceEnabled
        ? compact
          ? 'Ask about this document…'
          : 'Ask about this workspace…'
        : 'Inference unavailable · history remains readable',
      models,
      attachments: { enabled: false },
    },
    disclaimer: compact
      ? undefined
      : { text: 'Edits stay as proposals until you review and apply the diff.' },
    threadItemActions: { retry: true, feedback: false },
    thread: { autoScroll: true },
    onReady: () => {
      // `chatkit.ready` only means the host initialized. Domain verification and
      // iframe mounting happen afterward, so keep waiting for usable UI.
    },
    onError: () => setPhase('error'),
    onClientTool: ({ name, params }) => {
      if (name === 'review_chat_effect') return liveRef.current.requestEffectReview(params)
      return { error: 'Unknown client tool' }
    },
    onThreadChange,
    onResponseEnd: () => {
      responseAbortRef.current = null
      setIsResponding(false)
      onResponseEnd()
    },
    onDeeplink: onCitationDeeplink,
  })
  const chatkitHostRef = useRef<HTMLElement | null>(null)
  useEffect(() => {
    let stopped = false
    let observedRoot: ShadowRoot | null = null
    const observer = new MutationObserver(() => check())
    const check = () => {
      const host = chatkitHostRef.current
      if (!host || stopped) return
      if (host.shadowRoot && host.shadowRoot !== observedRoot) {
        observer.disconnect()
        observedRoot = host.shadowRoot
        observer.observe(observedRoot, { childList: true, subtree: true })
      }
      if (hasMountedChatInterface(host)) setPhase('ready')
    }
    check()
    const interval = window.setInterval(check, 250)
    return () => {
      stopped = true
      observer.disconnect()
      window.clearInterval(interval)
    }
  }, [])
  return (
    <>
      {compact && (
        <CompactChatControls
          onNewChat={() => {
            onThreadChange({ threadId: null })
            void chatkit.setThreadId(null).then(() => chatkit.focusComposer())
          }}
          onShowHistory={() => void chatkit.showHistory()}
        />
      )}
      {isResponding && (
        <div className="chat-run-control" role="status">
          <span>Agent is working</span>
          <button
            type="button"
            className="secondary-action"
            onClick={() => {
              responseAbortRef.current?.abort()
              responseAbortRef.current = null
              setIsResponding(false)
              if (activeThreadId) void api.cancelChatRun(activeThreadId)
            }}
          >
            <Square size="var(--icon-inline)" /> Stop
          </button>
        </div>
      )}
      <div className={`chatkit-shell phase-${phase}`}>
        <ChatKit
          ref={(host) => {
            chatkitHostRef.current = host
          }}
          control={chatkit.control}
          className="chatkit-frame"
        />
        {phase === 'connecting' && (
          <div className="chatkit-state-overlay">
            <StateMessage kind="loading" title="Connecting to workspace chat" />
          </div>
        )}
        {phase === 'error' && (
          <div className="chatkit-state-overlay">
            <StateMessage
              kind="error"
              title="Workspace chat could not finish loading"
              description="ChatKit did not mount a composer. Check domain registration and the browser connection, then retry."
              action={
                <button className="secondary-action" onClick={onReset}>
                  Retry workspace chat
                </button>
              }
            />
          </div>
        )}
      </div>
    </>
  )
}
