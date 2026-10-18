import type { ComponentProps } from 'react';
import Link from 'next/link';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { BadgeCheck, CircleUserRound, Sparkles } from 'lucide-react';
import type { SupportChatMessage } from '@/lib/support-incidents';
import { isAppRelativeLink } from '@/lib/support-reply-links';
import { supportTimeLabel } from '@/lib/support-time';
import { cn } from '@/lib/utils';
import './chat-message.css';

// Allowed targets are in-app paths; a client-side navigation avoids a full
// page load. A blocked target leaves no href. Render it as text: an empty
// href would reload /support and drop unsaved drafts and recovery state. Only
// href and title are forwarded, so no other attribute reaches the anchor.
function SafeLink({ href, title, children }: ComponentProps<'a'>) {
  return href ? (
    <Link href={href} title={title}>
      {children}
    </Link>
  ) : (
    <span>{children}</span>
  );
}

type ChatMessageProps = {
  message: SupportChatMessage;
  authorName: string;
  deliveryStatus?: 'pending' | 'failed' | 'uncertain';
};

export function ChatMessage({
  message,
  authorName,
  deliveryStatus,
}: ChatMessageProps) {
  return (
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
          <strong>{message.role === 'assistant' ? 'COV-E' : authorName}</strong>
          {message.role === 'assistant' ? (
            <BadgeCheck aria-label="Verified assistant" />
          ) : null}
          {deliveryStatus ? (
            <span>
              {deliveryStatus === 'pending'
                ? 'Pending'
                : deliveryStatus === 'failed'
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
              // Replies and server-written incident lists can carry
              // customer-authored text; never link outside the app.
              urlTransform={(url) => (isAppRelativeLink(url) ? url : undefined)}
              components={{ a: SafeLink }}
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
  );
}
