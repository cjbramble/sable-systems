'use client';

import Link from 'next/link';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  KeyboardEvent,
  Fragment,
  SyntheticEvent,
  useEffect,
  useMemo,
  useRef,
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
import { buildChatRequestHistory } from '@/lib/chat-history';
import { redirectToLogin, useSignOut } from '@/lib/client-session';
import type { AccountSummary } from '@/lib/contracts';
import {
  createIncidentTitle,
  filterSupportIncidents,
  removeSupportIncident,
  type SupportChatMessage,
  type SupportIncident,
  type SupportReply,
} from '@/lib/support-incidents';
import {
  supportDateKey,
  supportDateLabel,
  supportTimeLabel,
} from '@/lib/support-time';
import { cn } from '@/lib/utils';

type RuntimeState = 'checking' | 'ready' | 'offline';

type SupportRequest = {
  incidentId: string;
  messageId: string;
  messages: ReturnType<typeof buildChatRequestHistory>;
};

type IncidentFailure = { error: string; request?: SupportRequest };

class ChatRequestError extends Error {
  constructor(
    message: string,
    readonly modelUnavailable = false,
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
  const [conversation, setConversation] = useState<{
    incidents: SupportIncident[];
    activeIncidentId: string | null;
    draft: string;
  }>({ incidents: [], activeIncidentId: null, draft: '' });
  const { incidents, activeIncidentId, draft } = conversation;
  const [incidentSearch, setIncidentSearch] = useState('');
  const pendingRequest = useRef<SupportRequest | null>(null);
  const [sendingIncidentId, setSendingIncidentId] = useState<string | null>(
    null,
  );
  const deletingIncidents = useRef(new Set<string>());
  const [deletingIds, setDeletingIds] = useState<string[]>([]);
  const [failures, setFailures] = useState<Record<string, IncidentFailure>>({});
  const failure = activeIncidentId ? failures[activeIncidentId] : undefined;
  const retryRequest = failure?.request;
  const isSending = sendingIncidentId !== null;
  const composerDisabled =
    isSending || deletingIds.includes(activeIncidentId ?? '');
  const [runtime, setRuntime] = useState<RuntimeState>('checking');
  const [account, setAccount] = useState<AccountSummary | null>(null);
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
  const messages = useMemo(
    () => activeIncident?.messages ?? [openingMessage],
    [activeIncident],
  );
  const filteredIncidents = useMemo(
    () => filterSupportIncidents(incidents, incidentSearch),
    [incidentSearch, incidents],
  );

  useEffect(() => {
    let active = true;

    async function checkRuntime() {
      try {
        const response = await fetch('/api/status', { cache: 'no-store' });
        if (active) setRuntime(response.ok ? 'ready' : 'offline');
      } catch {
        if (active) setRuntime('offline');
      }
    }

    void checkRuntime();
    const interval = window.setInterval(checkRuntime, 10_000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, []);

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
          setConversation({
            incidents: incidentPayload.incidents,
            activeIncidentId: incidentPayload.incidents[0]?.id ?? null,
            draft: '',
          });
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
  }, [loadAttempt]);

  function retrySupport() {
    setLoadStatus('loading');
    setLoadError('');
    setLoadAttempt((attempt) => attempt + 1);
  }

  useEffect(() => {
    messageEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isSending]);

  function newConversation() {
    if (
      activeIncident?.title === 'New service incident' &&
      activeIncident.messages.length === 1
    ) {
      setMobileMenuOpen(false);
      window.setTimeout(() => inputRef.current?.focus(), 0);
      return;
    }
    const incident: SupportIncident = {
      id: createIncidentId(),
      title: 'New service incident',
      updatedAt: timestamp(),
      messages: [openingMessage],
    };
    setConversation((current) => ({
      incidents: [incident, ...current.incidents],
      activeIncidentId: incident.id,
      draft: '',
    }));
    setIncidentSearch('');
    setMobileMenuOpen(false);
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }

  function selectIncident(incidentId: string) {
    setConversation((current) => ({
      ...current,
      activeIncidentId: incidentId,
      draft: '',
    }));
    setMobileMenuOpen(false);
  }

  async function deleteIncident(incident: SupportIncident) {
    const signal = pageRequest.current?.signal;
    if (!signal || signal.aborted) return;
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
        redirectToLogin('/support');
        return;
      }
      if (!response.ok) {
        const payload = (await response.json()) as { error?: string };
        throw new Error(payload.error || 'The incident could not be deleted.');
      }
      setConversation((current) => {
        const remaining = removeSupportIncident(current.incidents, incident.id);
        return {
          incidents: remaining,
          activeIncidentId:
            current.activeIncidentId === incident.id
              ? (remaining[0]?.id ?? null)
              : current.activeIncidentId,
          draft: current.activeIncidentId === incident.id ? '' : current.draft,
        };
      });
      clearFailure(incident.id);
    } catch (error) {
      if (signal.aborted) return;
      setFailures((current) => ({
        ...current,
        [incident.id]: {
          ...current[incident.id],
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

  function clearFailure(incidentId: string) {
    setFailures((current) => {
      const next = { ...current };
      delete next[incidentId];
      return next;
    });
  }

  async function sendMessage(rawMessage?: string) {
    const signal = pageRequest.current?.signal;
    if (!signal || signal.aborted) return;
    const content = (rawMessage ?? draft).trim();
    if (
      !content ||
      pendingRequest.current ||
      deletingIncidents.current.has(activeIncidentId ?? '')
    )
      return;

    const userMessage: SupportChatMessage = {
      id: createId(),
      role: 'user',
      content,
      createdAt: timestamp(),
    };
    const incidentId = activeIncident?.id ?? createIncidentId();
    const nextMessages = [...messages, userMessage];

    if (activeIncident) {
      setConversation((current) => ({
        ...current,
        draft: '',
        incidents: current.incidents.map((incident) =>
          incident.id === incidentId
            ? {
                ...incident,
                title:
                  incident.messages.length === 1
                    ? createIncidentTitle(content)
                    : incident.title,
                updatedAt: userMessage.createdAt!,
                messages: nextMessages,
              }
            : incident,
        ),
      }));
    } else {
      setConversation((current) => ({
        draft: '',
        activeIncidentId: incidentId,
        incidents: [
          {
            id: incidentId,
            title: createIncidentTitle(content),
            updatedAt: userMessage.createdAt!,
            messages: nextMessages,
          },
          ...current.incidents,
        ],
      }));
    }
    await submitRequest({
      incidentId,
      messageId: userMessage.id,
      messages: buildChatRequestHistory(nextMessages),
    });
  }

  async function submitRequest(request: SupportRequest) {
    const signal = pageRequest.current?.signal;
    if (
      !signal ||
      signal.aborted ||
      pendingRequest.current ||
      deletingIncidents.current.has(request.incidentId)
    )
      return;
    // Retain the exact exchange identity/history so a lost response can replay
    // the server's saved winner without creating another customer message.
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

      const payload = (await response.json()) as Partial<SupportReply> & {
        error?: string;
      };
      if (signal.aborted) return;
      if (response.status === 401) {
        redirectToLogin('/support');
        return;
      }
      if (!response.ok) {
        throw new ChatRequestError(
          payload.error || 'The support request could not be completed.',
          response.status >= 500,
        );
      }
      if (
        !payload.message ||
        !payload.customerCreatedAt ||
        !payload.assistantCreatedAt ||
        !payload.incidentUpdatedAt
      )
        throw new ChatRequestError(
          'The local assistant did not return a response.',
          true,
        );
      const reply = payload.message;

      const replyMessage: SupportChatMessage = {
        id: `AST-${request.messageId}`,
        role: 'assistant',
        content: reply,
        createdAt: payload.assistantCreatedAt,
      };
      setConversation((current) => ({
        ...current,
        incidents: current.incidents.map((incident) =>
          incident.id === request.incidentId
            ? {
                ...incident,
                updatedAt: payload.incidentUpdatedAt!,
                messages: [
                  ...incident.messages.map((message) =>
                    message.id === request.messageId
                      ? { ...message, createdAt: payload.customerCreatedAt! }
                      : message,
                  ),
                  replyMessage,
                ],
              }
            : incident,
        ),
      }));
      setRuntime('ready');
    } catch (error) {
      if (signal.aborted) return;
      if (!(error instanceof ChatRequestError) || error.modelUnavailable)
        setRuntime('offline');
      setFailures((current) => ({
        ...current,
        [request.incidentId]: {
          request,
          error:
            error instanceof Error
              ? error.message
              : 'The support request could not be completed. Please try again.',
        },
      }));
    } finally {
      if (!signal.aborted) {
        pendingRequest.current = null;
        setSendingIncidentId(null);
        window.setTimeout(() => inputRef.current?.focus(), 0);
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

  return (
    <main className="app-shell">
      <aside className={cn('sidebar', mobileMenuOpen && 'sidebar--open')}>
        <div className="sidebar__brand">
          <BrandWordmark />
          <Button
            className="sidebar__close md:hidden"
            variant="ghost"
            size="icon"
            aria-label="Close navigation"
            onClick={() => setMobileMenuOpen(false)}
          >
            <X />
          </Button>
        </div>

        <Button className="new-chat" onClick={newConversation}>
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
              <small>
                {account?.displayName ?? 'Authorized records'} only.
              </small>
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
      </aside>

      {mobileMenuOpen ? (
        <button
          type="button"
          className="sidebar-scrim"
          aria-label="Close navigation"
          onClick={() => setMobileMenuOpen(false)}
        />
      ) : null}

      <section className="chat-panel">
        <header className="chat-header">
          <Button
            className="md:hidden"
            variant="ghost"
            size="icon"
            aria-label="Open navigation"
            onClick={() => setMobileMenuOpen(true)}
          >
            <Menu />
          </Button>
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
              onClick={newConversation}
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
                  <div className="today-divider" aria-label="Conversation date">
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
                      {message.createdAt ? (
                        <time dateTime={message.createdAt}>
                          {supportTimeLabel(message.createdAt)}
                        </time>
                      ) : null}
                    </div>
                    <div className="message-bubble">
                      {message.role === 'assistant' ? (
                        <Markdown remarkPlugins={[remarkGfm]} skipHtml>
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

            {failure ? (
              <div className="chat-notice" role="alert">
                <TriangleAlert aria-hidden="true" />
                <div>
                  <strong>Support request interrupted</strong>
                  <p>{failure.error}</p>
                  {retryRequest ? (
                    <Button
                      disabled={composerDisabled}
                      onClick={() => void submitRequest(retryRequest)}
                    >
                      Retry message
                    </Button>
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
              onChange={(event) =>
                setConversation((current) => ({
                  ...current,
                  draft: event.target.value,
                }))
              }
              onKeyDown={handleKeyDown}
              maxLength={4000}
              rows={1}
              placeholder="Enter order, item, shipment, or allocation inquiry…"
              aria-label="Message COV-E"
              disabled={composerDisabled}
            />
            <Button
              type="submit"
              size="icon-lg"
              aria-label="Send message"
              disabled={!draft.trim() || composerDisabled}
            >
              <ArrowUp />
            </Button>
          </form>
          <p>
            <ShieldCheck />
            COV-E output is advisory. Verify critical fulfillment instructions.
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
            <p>COV-E will flag incidents requiring a Morrow Vale specialist.</p>
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
              <strong>Private cognition node</strong>
              <small>Qwen3 4B · local inference</small>
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
  );
}
