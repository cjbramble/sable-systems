'use client';

import Link from 'next/link';
import {
  KeyboardEvent,
  Fragment,
  MouseEvent,
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
  Check,
  CircleUserRound,
  Clock3,
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

import { ChatMessage } from '@/components/chat-message';
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
import { supportDateKey, supportDateLabel } from '@/lib/support-time';
import { cn } from '@/lib/utils';
import { reconcileSupportSnapshot } from '@/lib/support-reconciliation';
import { parseIncidentSnapshot } from '@/lib/support-snapshot';
import {
  loadSupportSnapshot,
  SupportSessionExpiredError,
} from '@/lib/support-loader';
import {
  hasUnsentSupportText,
  initialSupportConversation,
  supportConversationReducer,
  supportDraft,
} from '@/lib/support-conversation';
import {
  startSupportStatusPolling,
  type SupportRuntimeState,
} from '@/lib/support-status';

const DELETE_FAILED = 'The incident could not be deleted. Please try again.';
const LEAVE_WARNING =
  'Leave support? Unsent drafts and messages on this page will be lost.';

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

function createMessageId() {
  return crypto.randomUUID();
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
  const [deleteFailures, setDeleteFailures] = useState<Record<string, string>>(
    {},
  );
  // Bumped after a deletion so focus can move once the row is gone.
  const [deletionFocus, setDeletionFocus] = useState(0);
  const refreshRequests = useRef(new Map<string, AbortController>());
  const [refreshingIds, setRefreshingIds] = useState<string[]>([]);
  const deletedMessage = deletedMessages[0] ?? null;
  const deleteFailure = activeIncidentId
    ? deleteFailures[activeIncidentId]
    : undefined;
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
  const unsentText = useRef(false);
  const clearConversationState = useCallback(() => {
    // The caller may redirect before the cleared state renders.
    unsentText.current = false;
    pageRequest.current?.abort();
    for (const controller of refreshRequests.current.values())
      controller.abort();
    refreshRequests.current.clear();
    deletingIncidents.current.clear();
    pendingRequest.current = null;
    dispatch({ type: 'reset' });
    setDeleteFailures({});
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
  const sendButtonRef = useRef<HTMLButtonElement>(null);
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
  const respondingHere = isSending && sendingIncidentId === activeIncidentId;
  const latestReply = activeIncident?.messages.findLast(
    (message) => message.role === 'assistant',
  );
  // Announce a reply only when it arrives in the incident already shown, so
  // switching incidents never reads out a saved conversation.
  const [announcedReply, setAnnouncedReply] = useState({
    incidentId: activeIncidentId,
    messageId: latestReply?.id,
    text: '',
  });
  if (respondingHere && announcedReply.text) {
    // A failed send must not fall back to re-announcing the previous reply.
    setAnnouncedReply({ ...announcedReply, text: '' });
  } else if (
    announcedReply.incidentId !== activeIncidentId ||
    announcedReply.messageId !== latestReply?.id
  ) {
    setAnnouncedReply({
      incidentId: activeIncidentId,
      messageId: latestReply?.id,
      text:
        announcedReply.incidentId === activeIncidentId && latestReply
          ? `COV-E replied: ${latestReply.content}`
          : '',
    });
  }
  const hasUnsentText = hasUnsentSupportText(conversation) && !signingOut;

  useEffect(() => startSupportStatusPolling(setRuntime), []);

  useEffect(() => {
    const controller = new AbortController();
    pageRequest.current = controller;
    loadSupportSnapshot(controller.signal)
      .then(({ account: summary, incidents: savedIncidents }) => {
        if (controller.signal.aborted || pageRequest.current !== controller)
          return;
        dispatch({ type: 'load', incidents: savedIncidents });
        setAccount(summary);
        setLoadStatus('ready');
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || pageRequest.current !== controller)
          return;
        if (error instanceof SupportSessionExpiredError) {
          clearConversationState();
          setLoadStatus('redirecting');
          redirectToLogin('/support');
          return;
        }
        setLoadError(
          error instanceof Error
            ? error.message
            : 'Support account and history could not be loaded. Please try again.',
        );
        setLoadStatus('error');
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
    unsentText.current = hasUnsentText;
  }, [hasUnsentText]);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (unsentText.current) event.preventDefault();
    };
    // Back and Forward between app pages stay in this document, so
    // beforeunload never runs. Browsers without the Navigation API skip this.
    const navigation = (window as Window & { navigation?: EventTarget })
      .navigation;
    const confirmTraversal = (event: Event) => {
      const { navigationType } = event as Event & { navigationType?: string };
      if (
        unsentText.current &&
        navigationType === 'traverse' &&
        event.cancelable &&
        !window.confirm(LEAVE_WARNING)
      )
        event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    navigation?.addEventListener('navigate', confirmTraversal);
    return () => {
      window.removeEventListener('beforeunload', warn);
      navigation?.removeEventListener('navigate', confirmTraversal);
    };
  }, []);

  useEffect(() => {
    if (deletionFocus === 0) return;
    // Only recover focus the deleted row took with it.
    if (document.activeElement && document.activeElement !== document.body)
      return;
    const visible = (selector: string) =>
      [...document.querySelectorAll<HTMLElement>(selector)].find((element) =>
        element.checkVisibility(),
      );
    (visible('.conversation-item.is-active') ?? visible('.new-chat'))?.focus();
  }, [deletionFocus]);

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
    clearDeleteFailure(incident.id);
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
        // A proxy can answer with an HTML error page instead of JSON.
        const failure = parseSupportFailure(
          await response.json().catch(() => null),
        );
        if (!signal.aborted)
          recordDeleteFailure(incident.id, failure?.error || DELETE_FAILED);
        return;
      }
      removeIncident(incident.id);
      setDeletionFocus((count) => count + 1);
    } catch {
      if (!signal.aborted) recordDeleteFailure(incident.id, DELETE_FAILED);
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
    clearDeleteFailure(incidentId);
  }

  function recordDeleteFailure(incidentId: string, error: string) {
    setDeleteFailures((current) => ({ ...current, [incidentId]: error }));
  }

  function clearDeleteFailure(incidentId: string) {
    setDeleteFailures((current) => {
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
      const response = await fetch(
        `/api/incidents?${new URLSearchParams({ incidentId })}`,
        { cache: 'no-store', signal },
      );
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
      messageId: createMessageId(),
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
    clearDeleteFailure(request.incidentId);
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
          window.setTimeout(restoreComposerFocus, 0);
        }
      }
    }
  }

  // Return focus to the composer only if the user has not moved it elsewhere
  // while the reply was on its way.
  function restoreComposerFocus() {
    const focused = document.activeElement;
    if (
      !focused ||
      focused === document.body ||
      focused === inputRef.current ||
      focused === sendButtonRef.current
    )
      inputRef.current?.focus();
  }

  // Client-side navigation skips beforeunload, so in-app links ask here.
  // Traversals are confirmed by the navigate listener above.
  function confirmLeavingLink(event: MouseEvent<HTMLElement>) {
    if (
      !unsentText.current ||
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      !(event.target instanceof Element)
    )
      return;
    const link = event.target.closest('a[href]');
    if (!(link instanceof HTMLAnchorElement) || link.target) return;
    const destination = new URL(link.href);
    if (
      destination.origin !== window.location.origin ||
      destination.pathname === window.location.pathname
    )
      return;
    if (!window.confirm(LEAVE_WARNING)) event.preventDefault();
  }

  function handleSubmit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    void sendMessage();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // oxlint-disable-next-line typescript/no-deprecated -- IME confirmation can report 229 after isComposing clears.
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)
      return;
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
      <main
        className="app-shell"
        inert={mobileMenuOpen}
        onClickCapture={confirmLeavingLink}
      >
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
                aria-label="Start over"
                onClick={() => newConversation()}
              >
                <RotateCcw />
                <span className="hidden sm:inline">Start over</span>
              </Button>
            </div>
          </header>

          <output className="sr-only">
            {respondingHere ? 'COV-E is responding' : announcedReply.text}
          </output>
          <div className="message-stage">
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
                  <ChatMessage
                    message={message}
                    authorName={account?.userDisplayName ?? 'Authorized user'}
                    deliveryStatus={
                      exchange?.request.messageId === message.id
                        ? exchange.status
                        : undefined
                    }
                  />
                </Fragment>
              ))}

              {respondingHere ? (
                <article className="chat-message">
                  <div className="assistant-avatar">
                    <Sparkles />
                  </div>
                  <div className="chat-message__body">
                    <div className="chat-message__meta">
                      <strong>COV-E</strong>
                      <span>Querying authorized local records…</span>
                    </div>
                    <div className="typing-bubble" aria-hidden="true">
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

              {deleteFailure ? (
                <div className="chat-notice" role="alert">
                  <TriangleAlert aria-hidden="true" />
                  <div>
                    <strong>Incident not deleted</strong>
                    <p>{deleteFailure}</p>
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
                ref={sendButtonRef}
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
              disabled={sendDisabled}
              onClick={() => void sendMessage('Help me trace an order')}
            >
              <span className="topic-icon">
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
              disabled={sendDisabled}
              onClick={() => void sendMessage('Help me start a return')}
            >
              <span className="topic-icon">
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
              disabled={sendDisabled}
              onClick={() =>
                void sendMessage('Show current inventory advisories')
              }
            >
              <span className="topic-icon">
                <CircleUserRound />
              </span>
              <span>
                <strong>Inventory channel</strong>
                <small>Availability and lead times</small>
              </span>
              <ArrowUp />
            </button>
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
