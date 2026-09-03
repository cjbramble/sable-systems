'use client';

import Link from 'next/link';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  KeyboardEvent,
  SyntheticEvent,
  useEffect,
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
  MoreHorizontal,
  Plus,
  RotateCcw,
  Search,
  ShieldCheck,
  ShoppingBag,
  Sparkles,
  TriangleAlert,
  X,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { buildChatRequestHistory } from '@/lib/chat-history';
import { redirectToLogin, signOut } from '@/lib/client-session';
import type { AccountSummary } from '@/lib/contracts';
import { cn } from '@/lib/utils';

type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
};

type RuntimeState = 'checking' | 'ready' | 'offline';

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

const openingMessage: ChatMessage = {
  id: 'welcome',
  role: 'assistant',
  content:
    'COV-E customer operations node online. I can assist with your authorized orders, allocations, shipments, returns, and SABLE inventory. What do you need traced?',
  createdAt: 'Now',
};

const conversations = [
  { label: 'Priority shipment trace', time: 'Today' },
  { label: 'Nerveline allocation', time: 'Aug 29' },
  { label: '2030 contract releases', time: 'Aug 24' },
];

function timestamp() {
  return new Intl.DateTimeFormat('en', {
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date());
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

export default function SupportPage() {
  const [messages, setMessages] = useState<ChatMessage[]>([openingMessage]);
  const [draft, setDraft] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [runtime, setRuntime] = useState<RuntimeState>('checking');
  const [account, setAccount] = useState<AccountSummary | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const messageEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

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
    let active = true;
    fetch('/api/account', { cache: 'no-store' })
      .then(async (response) => {
        if (response.status === 401) {
          redirectToLogin('/support');
          throw new Error('Authentication required');
        }
        if (!response.ok) throw new Error('Account summary unavailable');
        return (await response.json()) as AccountSummary;
      })
      .then((summary) => {
        if (active) {
          setAccount(summary);
          setAuthChecked(true);
        }
      })
      .catch(() => {
        if (active) setAuthChecked(true);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    messageEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isSending]);

  function newConversation() {
    setMessages([openingMessage]);
    setDraft('');
    setRequestError(null);
    setMobileMenuOpen(false);
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }

  async function sendMessage(rawMessage?: string) {
    const content = (rawMessage ?? draft).trim();
    if (!content || isSending) return;

    const userMessage: ChatMessage = {
      id: createId(),
      role: 'user',
      content,
      createdAt: timestamp(),
    };
    const nextMessages = [...messages, userMessage];

    setMessages(nextMessages);
    setDraft('');
    setRequestError(null);
    setIsSending(true);

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: buildChatRequestHistory(nextMessages),
        }),
      });

      const payload = (await response.json()) as {
        message?: string;
        error?: string;
      };
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
      if (!payload.message)
        throw new ChatRequestError(
          'The local assistant did not return a response.',
          true,
        );
      const reply = payload.message;

      setMessages((current) => [
        ...current,
        {
          id: createId(),
          role: 'assistant',
          content: reply,
          createdAt: timestamp(),
        },
      ]);
      setRuntime('ready');
    } catch (error) {
      if (!(error instanceof ChatRequestError) || error.modelUnavailable)
        setRuntime('offline');
      setRequestError(
        error instanceof Error
          ? error.message
          : 'The support request could not be completed. Please try again.',
      );
    } finally {
      setIsSending(false);
      window.setTimeout(() => inputRef.current?.focus(), 0);
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

  if (!authChecked) {
    return (
      <main className="access-check">
        <ShieldCheck />
        <span>VERIFYING DISTRIBUTION CREDENTIALS</span>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <aside className={cn('sidebar', mobileMenuOpen && 'sidebar--open')}>
        <div className="sidebar__brand">
          <Link className="wordmark" href="/" aria-label="SABLE home">
            <span className="wordmark__sigil" aria-hidden="true" />
            <span>
              <strong>SABLE</strong>
              <small>Morrow Vale Holdings</small>
            </span>
          </Link>
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
          <input type="search" placeholder="Search incidents" />
        </label>

        <nav className="conversation-list" aria-label="Open service incidents">
          <p className="eyebrow">Open incidents</p>
          {conversations.map((conversation, index) => (
            <button
              type="button"
              key={conversation.label}
              className={cn('conversation-item', index === 0 && 'is-active')}
            >
              <MessageCircleMore />
              <span>
                <strong>{conversation.label}</strong>
                <small>{conversation.time}</small>
              </span>
              {index === 0 ? (
                <MoreHorizontal className="conversation-more" />
              ) : null}
            </button>
          ))}
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
          <button type="button" className="profile-row" onClick={signOut}>
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
            <span
              className={cn('runtime-status', `runtime-status--${runtime}`)}
            >
              <i />
              {runtime === 'ready'
                ? 'COV-E NODE // ONLINE'
                : runtime === 'checking'
                  ? 'AUTHORIZING NODE'
                  : 'NODE // OFFLINE'}
            </span>
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
            <div className="today-divider">
              <span>Today</span>
            </div>

            {messages.map((message) => (
              <article
                key={message.id}
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
                      {message.role === 'assistant' ? 'COV-E' : 'CALDER PIKE'}
                    </strong>
                    {message.role === 'assistant' ? (
                      <BadgeCheck aria-label="Verified assistant" />
                    ) : null}
                    <time>{message.createdAt}</time>
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
            ))}

            {isSending ? (
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

            {requestError ? (
              <div className="chat-notice" role="alert">
                <TriangleAlert aria-hidden="true" />
                <div>
                  <strong>Support request interrupted</strong>
                  <p>{requestError}</p>
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
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={handleKeyDown}
              maxLength={4000}
              rows={1}
              placeholder="Enter order, item, shipment, or allocation inquiry…"
              aria-label="Message COV-E"
              disabled={isSending}
            />
            <Button
              type="submit"
              size="icon-lg"
              aria-label="Send message"
              disabled={!draft.trim() || isSending}
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
                Dataset current to {account?.asOfDate ?? 'initializing'}
              </small>
            </span>
          </div>
        </div>
      </aside>
    </main>
  );
}
