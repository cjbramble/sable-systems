'use client';

import Link from 'next/link';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  KeyboardEvent,
  Fragment,
  SyntheticEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useReducer,
  useState,
} from 'react';
import {
  ArrowUp,
  BadgeCheck,
  Check,
  CircleUserRound,
  Clock3,
  Headphones,
  History,
  LogOut,
  Menu,
  MessageCircleMore,
  Plus,
  RotateCcw,
  Search,
  ShieldCheck,
  ShoppingBag,
  Sparkles,
  Trash2,
  TriangleAlert,
  X,
} from 'lucide-react';

import { BrandWordmark } from '@/components/brand-wordmark';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  Sheet,
  SheetTrigger,
  SheetContent,
  SheetTitle,
  SheetClose,
} from '@/components/ui/sheet';
import {
  MAX_CHAT_MESSAGE_LENGTH,
  parseSupportReply,
  parseSupportFailure,
  type SupportCommand,
} from '@/lib/chat-request';
import {
  redirectToLogin,
  useSessionGuard,
  useSignOut,
} from '@/lib/client-session';
import { SessionChangedNotice } from '@/components/session-changed-notice';
import type { AccountSummary } from '@/lib/contracts';
import {
  filterSupportIncidents,
  type SupportChatMessage,
  type SupportIncident,
} from '@/lib/support-incidents';
import {
  supportDateKey,
  supportDateLabel,
  supportTimeLabel,
} from '@/lib/support-time';
import { cn } from '@/lib/utils';
import {
  parseIncidentSnapshot,
  reconcileSupportSnapshot,
} from '@/lib/support-reconciliation';
import {
  initialSupportConversation,
  supportConversationReducer,
  supportDraft,
} from '@/lib/support-conversation';
import {
  startSupportStatusPolling,
  type SupportRuntimeState,
} from '@/lib/support-status';

type IncidentFailure = { error: string };

class ChatRequestError extends Error {
  constructor(
    message: string,
    readonly requestNotSaved = false,
  ) {
    super(message);
    this.name = 'ChatRequestError';
  }
}

const starterPrompts = [
  'Help me trace an order',
  'Check Nerveline hub availability',
  'Show my scheduled releases',
];

const openingMessage: SupportChatMessage = {
  id: 'welcome',
  role: 'assistant',
  content:
    'COV-E customer operations node online. I can assist with your authorized orders, allocations, shipments, returns, and SABLE inventory. What do you need traced?',
  createdAt: null,
};

function timestamp() {
  return new Date().toISOString();
}

function roleLabel(role = 'account_admin') {
  return role
    .split('_')
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(' ');
}

function initials(name = 'Authorized User') {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('');
}

function createId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function createIncidentId() {
  return `INC-${crypto.randomUUID().toUpperCase()}`;
}

export default function SupportPage() {
  const { signOut, signingOut, signOutError } = useSignOut();
  const pageRequest = useRef<AbortController | null>(null);
  const [conversation, dispatch] = useReducer(
    supportConversationReducer,
    undefined,
    initialSupportConversation,
  );
  const {
    incidents,
    activeIncidentId,
    exchanges,
    recoveries,
    deletedMessages,
  } = conversation;
  const draft = supportDraft(conversation);
  const [incidentSearch, setIncidentSearch] = useState('');
  const pendingRequest = useRef<SupportCommand | null>(null);
  const [sendingIncidentId, setSendingIncidentId] = useState<string | null>(
    null,
  );
  const deletingIncidents = useRef(new Set<string>());
  const [deletingIds, setDeletingIds] = useState<string[]>([]);
  const [failures, setFailures] = useState<Record<string, IncidentFailure>>({});
  const refreshRequests = useRef(new Map<string, AbortController>());
  const [refreshingIds, setRefreshingIds] = useState<string[]>([]);
  const deletedMessage = deletedMessages[0] ?? null;
  const failure = activeIncidentId ? failures[activeIncidentId] : undefined;
  const exchange = activeIncidentId ? exchanges[activeIncidentId] : undefined;
  const recovery = activeIncidentId ? recoveries[activeIncidentId] : undefined;
  const isSending = sendingIncidentId !== null;
  const isRefreshing = refreshingIds.includes(activeIncidentId ?? '');
  const composerDisabled = deletingIds.includes(activeIncidentId ?? '');
  const actionDisabled = isSending || isRefreshing || composerDisabled;
  const sendDisabled =
    actionDisabled ||
    Boolean(exchange) ||
    Boolean(
      recovery && (recovery.status !== 'ready' || recovery.message !== null),
    );
  const [runtime, setRuntime] = useState<SupportRuntimeState>('checking');
  const [account, setAccount] = useState<AccountSummary | null>(null);
  const clearConversationState = useCallback(() => {
    pageRequest.current?.abort();
    for (const controller of refreshRequests.current.values())
      controller.abort();
    refreshRequests.current.clear();
    deletingIncidents.current.clear();
    pendingRequest.current = null;
    dispatch({ type: 'reset' });
    setFailures({});
    setSendingIncidentId(null);
    setDeletingIds([]);
    setRefreshingIds([]);
    setIncidentSearch('');
    setAccount(null);
  }, []);
  const { sessionChanged } = useSessionGuard(
    account,
    '/support',
    clearConversationState,
  );
  const [loadStatus, setLoadStatus] = useState<
    'loading' | 'ready' | 'error' | 'redirecting'
  >('loading');
  const [loadError, setLoadError] = useState('');
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const messageEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const activeIncident = useMemo(
    () => incidents.find((incident) => incident.id === activeIncidentId),
    [activeIncidentId, incidents],
  );
  const messages = useMemo(() => {
    const saved = activeIncident?.messages.length
      ? activeIncident.messages
      : [openingMessage];
    if (!exchange) return saved;
    return [
      ...saved,
      {
        id: exchange.request.messageId,
        role: 'user' as const,
        content: exchange.request.message,
        createdAt: exchange.createdAt,
      },
    ];
  }, [activeIncident, exchange]);
  const filteredIncidents = useMemo(
    () => filterSupportIncidents(incidents, incidentSearch),
    [incidentSearch, incidents],
  );

  useEffect(() => startSupportStatusPolling(setRuntime), []);

  useEffect(() => {
    const controller = new AbortController();
    pageRequest.current = controller;
    Promise.all([
      fetch('/api/account', { cache: 'no-store', signal: controller.signal }),
      fetch('/api/incidents', { cache: 'no-store', signal: controller.signal }),
    ])
      .then(async ([accountResponse, incidentsResponse]) => {
        if (controller.signal.aborted) return;
        if (
          accountResponse.status === 401 ||
          incidentsResponse.status === 401
        ) {
          clearConversationState();
          setLoadStatus('redirecting');
          redirectToLogin('/support');
          return;
        }
        if (!accountResponse.ok)
          throw new Error(
            'Support account details could not be loaded. Please try again.',
          );
        if (!incidentsResponse.ok)
          throw new Error(
            'Support history could not be loaded. Please try again.',
          );
        return Promise.all([
          accountResponse.json() as Promise<AccountSummary>,
          incidentsResponse.json() as Promise<{ incidents: SupportIncident[] }>,
        ]);
      })
      .then((payload) => {
        if (!controller.signal.aborted && payload) {
          const [summary, incidentPayload] = payload;
          dispatch({ type: 'load', incidents: incidentPayload.incidents });
          setAccount(summary);
          setLoadStatus('ready');
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setLoadError(
            error instanceof Error
              ? error.message
              : 'Support account and history could not be loaded. Please try again.',
          );
          setLoadStatus('error');
        }
      });
    return () => {
      controller.abort();
    };
  }, [loadAttempt, clearConversationState]);

  function retrySupport() {
    setLoadStatus('loading');
    setLoadError('');
    setLoadAttempt((attempt) => attempt + 1);
  }

  useEffect(() => {
    messageEndRef.current?.scrollIntoView({
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
        ? 'instant'
        : 'smooth',
    });
  }, [messages, isSending, deletedMessage]);

  useEffect(() => {
    const desktop = window.matchMedia('(min-width: 768px)');
    const closeOnDesktop = () => {
      if (desktop.matches) setMobileMenuOpen(false);
    };
    desktop.addEventListener('change', closeOnDesktop);
    return () => desktop.removeEventListener('change', closeOnDesktop);
  }, []);

  function expireSupportSession() {
    clearConversationState();
    setLoadStatus('redirecting');
    redirectToLogin('/support');
  }

  function newConversation() {
    if (
      activeIncident &&
      !(
        activeIncident.title === 'New service incident' &&
        activeIncident.messages.length === 0 &&
        !exchange
      )
    ) {
      dispatch({
        type: 'new',
        incidentId: createIncidentId(),
        createdAt: timestamp(),
      });
    }
    setIncidentSearch('');
    setMobileMenuOpen(false);
    if (!mobileMenuOpen) window.setTimeout(() => inputRef.current?.focus(), 0);
  }

  function recoverDeletedMessage() {
    dispatch({
      type: 'recoverDeleted',
      incidentId: createIncidentId(),
      createdAt: timestamp(),
    });
    setIncidentSearch('');
    setMobileMenuOpen(false);
  }

  function selectIncident(incidentId: string) {
    dispatch({ type: 'select', incidentId });
    setMobileMenuOpen(false);
  }

  async function deleteIncident(incident: SupportIncident) {
    const signal = pageRequest.current?.signal;
    if (!signal || signal.aborted || sessionChanged) return;
    if (
      pendingRequest.current?.incidentId === incident.id ||
      deletingIncidents.current.has(incident.id)
    )
      return;
    if (!window.confirm(`Delete “${incident.title}”?`)) return;
    deletingIncidents.current.add(incident.id);
    setDeletingIds([...deletingIncidents.current]);
    try {
      const response = await fetch('/api/incidents', {
        method: 'DELETE',
        signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ incidentId: incident.id }),
      });
      if (signal.aborted) return;
      if (response.status === 401) {
        expireSupportSession();
        return;
      }
      if (!response.ok) {
        const payload = (await response.json()) as { error?: string };
        throw new Error(payload.error || 'The incident could not be deleted.');
      }
      removeIncident(incident.id);
    } catch (error) {
      if (signal.aborted) return;
      setFailures((current) => ({
        ...current,
        [incident.id]: {
          error:
            error instanceof Error
              ? error.message
              : 'The incident could not be deleted.',
        },
      }));
    } finally {
      deletingIncidents.current.delete(incident.id);
      if (!signal.aborted) setDeletingIds([...deletingIncidents.current]);
    }
  }

  function removeIncident(incidentId: string, unavailable = false) {
    refreshRequests.current.get(incidentId)?.abort();
    refreshRequests.current.delete(incidentId);
    setRefreshingIds((current) => current.filter((id) => id !== incidentId));
    dispatch({ type: unavailable ? 'unavailable' : 'remove', incidentId });
    clearFailure(incidentId);
  }

  function clearFailure(incidentId: string) {
    setFailures((current) => {
      const next = { ...current };
      delete next[incidentId];
      return next;
    });
  }

  async function reloadConversation(incidentId: string) {
    const pageSignal = pageRequest.current?.signal;
    const retained = exchanges[incidentId];
    const stale = recoveries[incidentId];
    if (
      !pageSignal ||
      pageSignal.aborted ||
      sessionChanged ||
      (!stale && retained?.status !== 'uncertain') ||
      pendingRequest.current?.incidentId === incidentId ||
      refreshRequests.current.has(incidentId) ||
      deletingIncidents.current.has(incidentId)
    )
      return;
    const controller = new AbortController();
    const signal = AbortSignal.any([pageSignal, controller.signal]);
    refreshRequests.current.set(incidentId, controller);
    setRefreshingIds((current) => [...current, incidentId]);
    try {
      const response = await fetch('/api/incidents', {
        cache: 'no-store',
        signal,
      });
      if (signal.aborted) return;
      if (response.status === 401) {
        expireSupportSession();
        return;
      }
      if (!response.ok)
        throw new Error(
          'The conversation could not be reloaded. Please try again.',
        );
      const body: unknown = await response.json();
      if (signal.aborted) return;
      const snapshot = parseIncidentSnapshot(body, incidentId);
      if (stale) {
        if (!snapshot) {
          removeIncident(incidentId, true);
          return;
        }
        dispatch({ type: 'reloaded', snapshot });
      } else if (retained) {
        const outcome = reconcileSupportSnapshot(snapshot, retained.request);
        if (snapshot && outcome === 'confirmed') {
          dispatch({ type: 'reconciled', request: retained.request, snapshot });
        } else if (snapshot && outcome === 'changed') {
          dispatch({ type: 'changed', request: retained.request, snapshot });
        } else {
          dispatch({
            type: 'unconfirmed',
            request: retained.request,
            error:
              'Your message is not confirmed yet. Retry the same message to resolve it before sending another.',
          });
        }
      }
    } catch {
      if (signal.aborted) return;
      const error = 'The conversation could not be reloaded. Please try again.';
      if (stale) dispatch({ type: 'recoveryFailed', incidentId, error });
      else if (retained)
        dispatch({ type: 'unconfirmed', request: retained.request, error });
    } finally {
      if (refreshRequests.current.get(incidentId) === controller) {
        refreshRequests.current.delete(incidentId);
        setRefreshingIds((current) =>
          current.filter((id) => id !== incidentId),
        );
      }
    }
  }

  function changeDraft(message: string) {
    let incidentId = activeIncidentId;
    if (!incidentId) {
      if (!message) return;
      incidentId = createIncidentId();
      dispatch({ type: 'new', incidentId, createdAt: timestamp() });
    }
    dispatch({ type: 'edit', incidentId, message });
  }

  async function sendMessage(rawMessage?: string) {
    const signal = pageRequest.current?.signal;
    if (!signal || signal.aborted || sessionChanged) return;
    const content = (rawMessage ?? draft).trim();
    if (
      !content ||
      pendingRequest.current ||
      exchange ||
      (recovery &&
        (recovery.status !== 'ready' || recovery.message !== null)) ||
      refreshRequests.current.has(activeIncidentId ?? '') ||
      deletingIncidents.current.has(activeIncidentId ?? '')
    )
      return;
    const request: SupportCommand = {
      incidentId: activeIncident?.id ?? createIncidentId(),
      messageId: createId(),
      message: content,
      expectedRevision: activeIncident?.revision ?? 0,
    };
    dispatch({
      type: 'send',
      request,
      createdAt: timestamp(),
      consumeDraft:
        rawMessage === undefined || rawMessage.trim() === draft.trim(),
    });
    await submitRequest(request);
  }

  function retryMessage(request: SupportCommand) {
    if (
      pendingRequest.current ||
      refreshRequests.current.has(request.incidentId) ||
      deletingIncidents.current.has(request.incidentId) ||
      sessionChanged ||
      pageRequest.current?.signal.aborted
    )
      return;
    dispatch({ type: 'retry', incidentId: request.incidentId });
    void submitRequest(request);
  }

  async function submitRequest(request: SupportCommand) {
    const signal = pageRequest.current?.signal;
    if (
      !signal ||
      signal.aborted ||
      pendingRequest.current ||
      sessionChanged ||
      deletingIncidents.current.has(request.incidentId)
    )
      return;
    pendingRequest.current = request;
    setSendingIncidentId(request.incidentId);
    clearFailure(request.incidentId);
    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      });
      if (signal.aborted) return;
      if (response.status === 401) {
        expireSupportSession();
        return;
      }
      const body: unknown = await response.json();
      if (signal.aborted) return;
      const failure = parseSupportFailure(body);
      if (response.status === 410 && failure?.code === 'incident_deleted') {
        removeIncident(request.incidentId, true);
        return;
      }
      if (response.status === 409 && failure?.code === 'incident_changed') {
        dispatch({ type: 'changed', request });
        return;
      }
      if (!response.ok) {
        throw new ChatRequestError(
          failure?.error || 'The support request could not be completed.',
          failure?.code === 'request_not_saved',
        );
      }
      const payload = parseSupportReply(body);
      if (!payload)
        throw new ChatRequestError(
          'The support reply could not be verified. Please retry your message.',
        );
      dispatch({ type: 'confirmed', request, reply: payload });
    } catch (error) {
      if (signal.aborted) return;
      dispatch({
        type: 'failed',
        request,
        error:
          error instanceof Error
            ? error.message
            : 'The support request could not be completed. Please try again.',
        requestNotSaved:
          error instanceof ChatRequestError && error.requestNotSaved,
      });
    } finally {
      if (pendingRequest.current === request) {
        pendingRequest.current = null;
        if (!signal.aborted) {
          setSendingIncidentId(null);
          window.setTimeout(() => inputRef.current?.focus(), 0);
        }
      }
    }
  }

  function handleSubmit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    void sendMessage();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void sendMessage();
    }
  }

  if (sessionChanged) {
    return (
      <SessionChangedNotice>
        <p>
          Unsent drafts and pending messages have been cleared. Saved
          conversations remain with their original account.
        </p>
      </SessionChangedNotice>
    );
  }

  if (loadStatus !== 'ready') {
    return (
      <main className="access-check">
        <ShieldCheck />
        {loadStatus === 'error' ? (
          <div role="alert">
            <p>{loadError}</p>
            <Button onClick={retrySupport}>Retry support</Button>
          </div>
        ) : (
          <span>VERIFYING DISTRIBUTION CREDENTIALS</span>
        )}
      </main>
    );
  }

  const sidebarContent = (
    <>
      <div className="sidebar__brand">
        <BrandWordmark />
        <SheetClose
          render={
            <Button
              className="sidebar__close md:hidden"
              variant="ghost"
              size="icon"
              aria-label="Close navigation"
            />
          }
        >
          <X />
        </SheetClose>
      </div>

      <Button className="new-chat" onClick={() => newConversation()}>
        <Plus />
        New service incident
      </Button>

      <nav className="support-destinations" aria-label="Account navigation">
        <Link href="/shop">
          <ShoppingBag /> Procurement
        </Link>
        <Link href="/orders">
          <History /> Order history
        </Link>
      </nav>

      <label className="search-box">
        <Search aria-hidden="true" />
        <span className="sr-only">Search service incidents</span>
        <input
          type="search"
          value={incidentSearch}
          placeholder="Search incidents"
          onChange={(event) => setIncidentSearch(event.target.value)}
        />
      </label>

      <nav className="conversation-list" aria-label="Open service incidents">
        <p className="eyebrow">Open incidents</p>
        {filteredIncidents.map((incident) => (
          <div className="conversation-row" key={incident.id}>
            <button
              type="button"
              className={cn(
                'conversation-item',
                incident.id === activeIncidentId && 'is-active',
              )}
              aria-current={
                incident.id === activeIncidentId ? 'page' : undefined
              }
              onClick={() => selectIncident(incident.id)}
            >
              <MessageCircleMore />
              <span>
                <strong>{incident.title}</strong>
                <small>
                  <time dateTime={incident.updatedAt}>
                    {supportDateLabel(incident.updatedAt)}
                  </time>
                </small>
              </span>
            </button>
            <button
              type="button"
              className={cn(
                'conversation-delete',
                incident.id === activeIncidentId && 'is-visible',
              )}
              aria-label={`Delete ${incident.title}`}
              disabled={
                incident.id === sendingIncidentId ||
                deletingIds.includes(incident.id)
              }
              onClick={() => void deleteIncident(incident)}
            >
              <Trash2 />
            </button>
          </div>
        ))}
        {filteredIncidents.length === 0 ? (
          <p className="conversation-empty">
            {incidents.length === 0
              ? 'No open incidents.'
              : 'No incidents match this search.'}
          </p>
        ) : null}
      </nav>

      <div className="sidebar__footer">
        <div className="privacy-note">
          <ShieldCheck />
          <span>
            <strong>Verified private node</strong>
            <small>{account?.displayName ?? 'Authorized records'} only.</small>
          </span>
        </div>
        {signOutError ? (
          <p className="session-error" role="alert">
            {signOutError}
          </p>
        ) : null}
        <button
          type="button"
          className="profile-row"
          aria-label="Sign out"
          onClick={signOut}
          disabled={signingOut}
        >
          <span className="profile-avatar">
            {initials(account?.userDisplayName)}
          </span>
          <span>
            <strong>{account?.userDisplayName ?? 'Authorized user'}</strong>
            <small>
              {account?.displayName ?? 'Distribution account'} ·{' '}
              {roleLabel(account?.userRole)}
            </small>
          </span>
          <LogOut aria-label="Sign out" />
        </button>
      </div>
    </>
  );

  return (
    <Sheet open={mobileMenuOpen} onOpenChange={setMobileMenuOpen}>
      {/* The Sheet portals its content outside this inert background. */}
      <main className="app-shell" inert={mobileMenuOpen}>
        <aside className="sidebar sidebar--desktop">{sidebarContent}</aside>
        <SheetContent
          side="left"
          className="sidebar support-mobile-navigation"
          showCloseButton={false}
          finalFocus={() =>
            window.matchMedia('(min-width: 768px)').matches
              ? inputRef.current
              : true
          }
        >
          <SheetTitle className="sr-only">Support navigation</SheetTitle>
          {sidebarContent}
        </SheetContent>

        <section className="chat-panel">
          <header className="chat-header">
            <SheetTrigger
              render={
                <Button
                  className="md:hidden"
                  variant="ghost"
                  size="icon"
                  aria-label="Open navigation"
                />
              }
            >
              <Menu />
            </SheetTrigger>
            <div className="assistant-avatar assistant-avatar--small">
              <Sparkles />
              <span className="online-dot" />
            </div>
            <div className="chat-header__title">
              <h1>COV-E Customer Operations</h1>
              <p>SABLE Systems · Authorized wholesale channel</p>
            </div>
            <div className="chat-header__actions">
              <output
                className={cn('runtime-status', `runtime-status--${runtime}`)}
                aria-label="Model connection"
              >
                <i />
                {runtime === 'ready'
                  ? 'COV-E NODE // ONLINE'
                  : runtime === 'checking'
                    ? 'AUTHORIZING NODE'
                    : 'NODE // OFFLINE'}
              </output>
              <Button
                className="header-action"
                variant="outline"
                onClick={() => newConversation()}
              >
                <RotateCcw />
                <span className="hidden sm:inline">Start over</span>
              </Button>
            </div>
          </header>

          <div className="message-stage" aria-live="polite">
            <div className="message-stream">
              {messages.map((message, index) => (
                <Fragment key={message.id}>
                  {index === 0 ||
                  supportDateKey(message.createdAt) !==
                    supportDateKey(messages[index - 1].createdAt) ? (
                    <div
                      className="today-divider"
                      aria-label="Conversation date"
                    >
                      <span>{supportDateLabel(message.createdAt)}</span>
                    </div>
                  ) : null}
                  <article
                    className={cn(
                      'chat-message',
                      message.role === 'user' && 'chat-message--user',
                    )}
                  >
                    {message.role === 'assistant' ? (
                      <div className="assistant-avatar">
                        <Sparkles />
                      </div>
                    ) : null}
                    <div className="chat-message__body">
                      <div className="chat-message__meta">
                        <strong>
                          {message.role === 'assistant'
                            ? 'COV-E'
                            : (account?.userDisplayName ?? 'Authorized user')}
                        </strong>
                        {message.role === 'assistant' ? (
                          <BadgeCheck aria-label="Verified assistant" />
                        ) : null}
                        {exchange?.request.messageId === message.id ? (
                          <span>
                            {exchange.status === 'pending'
                              ? 'Pending'
                              : exchange.status === 'failed'
                                ? 'Not saved'
                                : 'Save unconfirmed'}
                          </span>
                        ) : null}
                        {message.createdAt ? (
                          <time dateTime={message.createdAt}>
                            {supportTimeLabel(message.createdAt)}
                          </time>
                        ) : null}
                      </div>
                      <div className="message-bubble">
                        {message.role === 'assistant' ? (
                          <Markdown
                            remarkPlugins={[remarkGfm]}
                            skipHtml
                            disallowedElements={['img']}
                          >
                            {message.content}
                          </Markdown>
                        ) : (
                          <p>{message.content}</p>
                        )}
                      </div>
                    </div>
                    {message.role === 'user' ? (
                      <div className="user-avatar">
                        <CircleUserRound />
                      </div>
                    ) : null}
                  </article>
                </Fragment>
              ))}

              {sendingIncidentId === activeIncidentId && isSending ? (
                <article className="chat-message">
                  <div className="assistant-avatar">
                    <Sparkles />
                  </div>
                  <div className="chat-message__body">
                    <div className="chat-message__meta">
                      <strong>COV-E</strong>
                      <span>Querying authorized local records…</span>
                    </div>
                    <div
                      className="typing-bubble"
                      aria-label="COV-E is responding"
                    >
                      <i />
                      <i />
                      <i />
                    </div>
                  </div>
                </article>
              ) : null}

              {deletedMessage !== null ? (
                <div className="chat-notice" role="alert">
                  <TriangleAlert aria-hidden="true" />
                  <div>
                    <strong>Incident deleted</strong>
                    <p>
                      This incident is no longer available. Use the retained
                      text in a new incident or discard it.
                    </p>
                    <blockquote>{deletedMessage}</blockquote>
                    {deletedMessages.length > 1 ? (
                      <p>
                        {deletedMessages.length - 1} more{' '}
                        {deletedMessages.length === 2 ? 'message' : 'messages'}{' '}
                        waiting to be recovered.
                      </p>
                    ) : null}
                    <Button onClick={recoverDeletedMessage}>
                      Use message in a new incident
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => dispatch({ type: 'discardDeleted' })}
                    >
                      Discard unsent message
                    </Button>
                  </div>
                </div>
              ) : null}

              {failure ? (
                <div className="chat-notice" role="alert">
                  <TriangleAlert aria-hidden="true" />
                  <div>
                    <strong>Support request interrupted</strong>
                    <p>{failure.error}</p>
                  </div>
                </div>
              ) : null}

              {exchange && exchange.status !== 'pending' ? (
                <div className="chat-notice" role="alert">
                  <TriangleAlert aria-hidden="true" />
                  <div>
                    <strong>Support request interrupted</strong>
                    <p>{exchange.error}</p>
                    <p>
                      {exchange.status === 'failed'
                        ? 'Your message was not saved. Retry it or discard it before sending another.'
                        : 'We could not confirm whether your message was saved. Retry it or check the saved conversation before sending another.'}
                    </p>
                    <Button
                      disabled={actionDisabled}
                      onClick={() => retryMessage(exchange.request)}
                    >
                      Retry message
                    </Button>
                    {exchange.status === 'failed' ? (
                      <Button
                        variant="ghost"
                        disabled={actionDisabled}
                        onClick={() =>
                          dispatch({
                            type: 'discardFailed',
                            incidentId: exchange.request.incidentId,
                          })
                        }
                      >
                        Discard unsent message
                      </Button>
                    ) : (
                      <Button
                        disabled={actionDisabled}
                        onClick={() =>
                          void reloadConversation(exchange.request.incidentId)
                        }
                      >
                        {isRefreshing
                          ? 'Checking saved conversation…'
                          : 'Check saved conversation'}
                      </Button>
                    )}
                  </div>
                </div>
              ) : null}

              {recovery ? (
                <div
                  className="chat-notice"
                  role={recovery.status === 'ready' ? 'status' : 'alert'}
                >
                  <TriangleAlert aria-hidden="true" />
                  <div>
                    <strong>
                      {recovery.status === 'ready'
                        ? 'Conversation reloaded'
                        : 'This conversation changed.'}
                    </strong>
                    <p>
                      {recovery.error ??
                        (recovery.status === 'ready'
                          ? 'Review the latest messages and your draft before sending again.'
                          : 'Reload it before sending your message again. Your draft is preserved.')}
                    </p>
                    {recovery.status !== 'ready' && activeIncidentId ? (
                      <Button
                        disabled={actionDisabled}
                        onClick={() =>
                          void reloadConversation(activeIncidentId)
                        }
                      >
                        {isRefreshing
                          ? 'Reloading conversation…'
                          : 'Reload conversation'}
                      </Button>
                    ) : null}
                    {recovery.message !== null && activeIncidentId ? (
                      <>
                        <blockquote>{recovery.message}</blockquote>
                        <p>
                          Your newer draft is preserved. Use this unsent message
                          when the draft is empty, or discard the message to
                          keep your draft.
                        </p>
                        <Button
                          disabled={draft.length > 0 || actionDisabled}
                          onClick={() =>
                            dispatch({
                              type: 'recoverUnsent',
                              incidentId: activeIncidentId,
                            })
                          }
                        >
                          Use unsent message
                        </Button>
                        <Button
                          variant="ghost"
                          disabled={actionDisabled}
                          onClick={() =>
                            dispatch({
                              type: 'discardUnsent',
                              incidentId: activeIncidentId,
                            })
                          }
                        >
                          Discard unsent message
                        </Button>
                      </>
                    ) : null}
                  </div>
                </div>
              ) : null}

              {messages.length === 1 ? (
                <div className="prompt-grid" aria-label="Suggested questions">
                  {starterPrompts.map((prompt) => (
                    <button
                      type="button"
                      key={prompt}
                      disabled={sendDisabled}
                      onClick={() => void sendMessage(prompt)}
                    >
                      <span>{prompt}</span>
                      <ArrowUp />
                    </button>
                  ))}
                </div>
              ) : null}
              <div ref={messageEndRef} />
            </div>
          </div>

          <footer className="composer-wrap">
            <form className="composer" onSubmit={handleSubmit}>
              <Textarea
                ref={inputRef}
                value={draft}
                onChange={(event) => changeDraft(event.target.value)}
                onKeyDown={handleKeyDown}
                maxLength={MAX_CHAT_MESSAGE_LENGTH}
                rows={1}
                placeholder="Enter order, item, shipment, or allocation inquiry…"
                aria-label="Message COV-E"
                disabled={composerDisabled}
              />
              <Button
                type="submit"
                size="icon-lg"
                aria-label="Send message"
                disabled={!draft.trim() || sendDisabled}
              >
                <ArrowUp />
              </Button>
            </form>
            <p>
              <ShieldCheck />
              COV-E output is advisory. Verify critical fulfillment
              instructions.
            </p>
          </footer>
        </section>

        <aside className="context-panel">
          <div className="context-panel__header">
            <p className="eyebrow">Authorized account</p>
            <h2>{account?.displayName ?? 'Authorized account'}</h2>
            <p>
              {account?.customerId ?? 'Verifying'} ·{' '}
              {account?.region ?? 'Trade district'}
            </p>
          </div>

          <div
            className="account-metrics"
            aria-label="Authorized account summary"
          >
            <div>
              <strong>{account?.activeOrders ?? '—'}</strong>
              <span>Active orders</span>
            </div>
            <div>
              <strong>{account?.scheduledOrders ?? '—'}</strong>
              <span>Scheduled</span>
            </div>
            <div>
              <strong>{account?.inventoryAlerts ?? '—'}</strong>
              <span>Stock advisories</span>
            </div>
          </div>

          <div className="topic-list">
            <button
              type="button"
              onClick={() => void sendMessage('Help me trace an order')}
            >
              <span className="topic-icon topic-icon--blue">
                <Clock3 />
              </span>
              <span>
                <strong>Trace an order</strong>
                <small>Allocation and delivery events</small>
              </span>
              <ArrowUp />
            </button>
            <button
              type="button"
              onClick={() => void sendMessage('Help me start a return')}
            >
              <span className="topic-icon topic-icon--coral">
                <RotateCcw />
              </span>
              <span>
                <strong>Returns protocol</strong>
                <small>Authorization and disposition</small>
              </span>
              <ArrowUp />
            </button>
            <button
              type="button"
              onClick={() =>
                void sendMessage('Show current inventory advisories')
              }
            >
              <span className="topic-icon topic-icon--mint">
                <CircleUserRound />
              </span>
              <span>
                <strong>Inventory channel</strong>
                <small>Availability and lead times</small>
              </span>
              <ArrowUp />
            </button>
          </div>

          <div className="service-card">
            <div className="service-card__icon">
              <Headphones />
            </div>
            <div>
              <span className="service-card__status">
                <i /> Biological escalation available
              </span>
              <h3>Request a liaison</h3>
              <p>
                COV-E will flag incidents requiring a Morrow Vale specialist.
              </p>
            </div>
          </div>

          <div className="trust-list">
            <div>
              <Check />
              <span>
                <strong>Tenant isolation active</strong>
                <small>
                  {account?.displayName ?? 'Account'} authorization scope
                </small>
              </span>
            </div>
            <div>
              <Check />
              <span>
                <strong>Grounded support responses</strong>
                <small>Authorized account records only</small>
              </span>
            </div>
            <div>
              <Check />
              <span>
                <strong>{account?.totalOrders ?? '—'} authorized orders</strong>
                <small>
                  Seed baseline: {account?.seedAsOfDate ?? 'initializing'}
                </small>
              </span>
            </div>
          </div>
        </aside>
      </main>
    </Sheet>
  );
}
