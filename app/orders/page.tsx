'use client';

import Link from 'next/link';
import { SyntheticEvent, useEffect, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  CalendarClock,
  CheckCircle2,
  Clock3,
  FileClock,
  LogOut,
  Search,
  ShieldCheck,
  ShoppingBag,
} from 'lucide-react';

import { BrandWordmark } from '@/components/brand-wordmark';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type {
  OrderHistoryFilter,
  OrderHistoryResponse,
  OrderStatus,
} from '@/lib/contracts';
import { redirectToLogin, useSignOut } from '@/lib/client-session';
import { formatCurrency, formatDate } from '@/lib/format';
import { cn } from '@/lib/utils';

import './orders.css';

const filters: { value: OrderHistoryFilter; label: string }[] = [
  { value: 'all', label: 'All orders' },
  { value: 'active', label: 'Active' },
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'fulfilled', label: 'Fulfilled' },
  { value: 'closed', label: 'Closed' },
];

function statusLabel(status: OrderStatus) {
  return status.replaceAll('_', ' ');
}

function statusTone(status: OrderStatus) {
  if (status === 'delivered') return 'is-fulfilled';
  if (status === 'scheduled') return 'is-scheduled';
  if (status === 'cancelled' || status === 'on_hold') return 'is-closed';
  return 'is-active';
}

export default function OrdersPage() {
  const { signOut, signingOut, signOutError } = useSignOut();
  const [data, setData] = useState<OrderHistoryResponse | null>(null);
  const [filter, setFilter] = useState<OrderHistoryFilter>('all');
  const [page, setPage] = useState(1);
  const [searchInput, setSearchInput] = useState('');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    const parameters = new URLSearchParams({
      page: String(page),
      status: filter,
    });
    if (query) parameters.set('query', query);

    fetch(`/api/orders?${parameters}`, {
      cache: 'no-store',
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = (await response.json()) as OrderHistoryResponse & {
          error?: string;
        };
        if (controller.signal.aborted) return;
        if (response.status === 401) {
          redirectToLogin('/orders');
          throw new Error('Authentication required.');
        }
        if (!response.ok)
          throw new Error(payload.error || 'Order history unavailable.');
        return payload;
      })
      .then((payload) => {
        if (!controller.signal.aborted && payload) setData(payload);
      })
      .catch((requestError: unknown) => {
        if (controller.signal.aborted) return;
        setError(
          requestError instanceof Error
            ? requestError.message
            : 'Order history unavailable.',
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [filter, page, query]);

  function applySearch(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextQuery = searchInput.trim();
    if (nextQuery === query && page === 1) return;
    setLoading(true);
    setError('');
    setPage(1);
    setQuery(nextQuery);
  }

  function chooseFilter(nextFilter: OrderHistoryFilter) {
    if (nextFilter === filter && page === 1) return;
    setLoading(true);
    setError('');
    setFilter(nextFilter);
    setPage(1);
  }

  function choosePage(nextPage: number) {
    setLoading(true);
    setError('');
    setPage(nextPage);
  }

  if (!data && loading) {
    return (
      <main className="access-check">
        <ShieldCheck />
        <span>OPENING AUTHORIZED ORDER LEDGER</span>
      </main>
    );
  }

  const rangeStart =
    data && data.total ? (data.page - 1) * data.pageSize + 1 : 0;
  const rangeEnd = data ? Math.min(data.page * data.pageSize, data.total) : 0;

  return (
    <main className="orders-page">
      <header className="shop-nav orders-nav">
        <BrandWordmark />
        <div className="shop-account">
          <span>AUTHORIZED USER</span>
          <strong>
            {data?.account.userDisplayName ?? 'Authorized user'} {'//'}{' '}
            {data?.account.displayName ?? 'Distribution account'}
          </strong>
        </div>
        <div className="shop-nav__actions">
          <Link href="/shop">Procurement</Link>
          <Link href="/support">COV-E Support</Link>
          <Button
            className="shop-logout"
            variant="ghost"
            size="icon"
            aria-label="Sign out"
            onClick={signOut}
            disabled={signingOut}
          >
            <LogOut />
          </Button>
        </div>
      </header>
      {signOutError ? (
        <p className="session-error" role="alert">
          {signOutError}
        </p>
      ) : null}

      <section className="orders-hero">
        <div>
          <Link className="back-link" href="/shop">
            <ArrowLeft /> Procurement node
          </Link>
          <p className="brand-kicker">
            <span /> AUTHORIZED ORDER LEDGER
          </p>
          <h1>
            Order <em>history.</em>
          </h1>
          <p className="orders-hero__lede">
            Current, scheduled, and fulfilled orders for{' '}
            {data?.account.displayName ?? 'this distribution account'}.
          </p>
        </div>
        <dl className="orders-account-card">
          <div>
            <dt>Distributor</dt>
            <dd>{data?.account.displayName}</dd>
          </div>
          <div>
            <dt>Customer ID</dt>
            <dd>{data?.account.customerId}</dd>
          </div>
          <div>
            <dt>Trade district</dt>
            <dd>{data?.account.region}</dd>
          </div>
        </dl>
      </section>

      <section className="orders-summary" aria-label="Order summary">
        <article>
          <FileClock />
          <span>Account total</span>
          <strong>{data?.summary.totalOrders ?? '—'}</strong>
        </article>
        <article>
          <Clock3 />
          <span>Active</span>
          <strong>{data?.summary.activeOrders ?? '—'}</strong>
        </article>
        <article>
          <CalendarClock />
          <span>Scheduled</span>
          <strong>{data?.summary.scheduledOrders ?? '—'}</strong>
        </article>
        <article>
          <CheckCircle2 />
          <span>Fulfilled</span>
          <strong>{data?.summary.fulfilledOrders ?? '—'}</strong>
        </article>
      </section>

      <section className="orders-ledger">
        <div className="orders-ledger__heading">
          <div>
            <p className="eyebrow">Distribution records</p>
            <h2>Order register</h2>
          </div>
          <Link href="/shop">
            <ShoppingBag /> Create order <ArrowRight />
          </Link>
        </div>

        <div className="orders-tools">
          <div className="orders-filters" aria-label="Filter order history">
            {filters.map((item) => (
              <button
                key={item.value}
                type="button"
                className={cn(filter === item.value && 'is-active')}
                aria-pressed={filter === item.value}
                onClick={() => chooseFilter(item.value)}
              >
                {item.label}
              </button>
            ))}
          </div>
          <form className="orders-search" onSubmit={applySearch}>
            <Search aria-hidden="true" />
            <span className="sr-only">Search order history</span>
            <Input
              value={searchInput}
              maxLength={80}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="Order ID, PO, or buyer"
            />
            <Button type="submit">Search</Button>
          </form>
        </div>

        {error ? (
          <div className="orders-state orders-state--error">
            <ShieldCheck />
            <h3>Ledger link interrupted.</h3>
            <p>{error}</p>
          </div>
        ) : loading ? (
          <div className="orders-state">
            <span className="loading-ring" />
            <p>Synchronizing order records…</p>
          </div>
        ) : data?.orders.length ? (
          <>
            <div className="orders-table-shell">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Order / Customer PO</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Placed by</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead>Requested ship</TableHead>
                    <TableHead>Volume</TableHead>
                    <TableHead className="orders-money">Total</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.orders.map((order) => (
                    <TableRow key={order.orderId}>
                      <TableCell>
                        <strong className="orders-order-id">
                          {order.orderId}
                        </strong>
                        <span className="orders-po">
                          PO {order.customerPoNumber}
                        </span>
                      </TableCell>
                      <TableCell>
                        <span
                          className={cn(
                            'orders-status',
                            statusTone(order.status),
                          )}
                        >
                          <i /> {statusLabel(order.status)}
                        </span>
                      </TableCell>
                      <TableCell>
                        <strong className="orders-buyer">
                          {order.placedByName}
                        </strong>
                        <span className="orders-user-id">
                          {order.placedByUserId}
                        </span>
                      </TableCell>
                      <TableCell>{formatDate(order.createdOn)}</TableCell>
                      <TableCell>
                        {formatDate(order.requestedShipDate)}
                      </TableCell>
                      <TableCell>
                        {order.lineCount}{' '}
                        {order.lineCount === 1 ? 'line' : 'lines'}
                        <span className="orders-units">
                          {order.unitCount.toLocaleString()} units
                        </span>
                      </TableCell>
                      <TableCell className="orders-money">
                        {formatCurrency(order.orderTotalCents, order.currency, 0)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <footer className="orders-pagination">
              <span>
                Showing {rangeStart}–{rangeEnd} of {data.total} matching orders
              </span>
              <div>
                <Button
                  variant="outline"
                  disabled={data.page <= 1}
                  onClick={() => choosePage(Math.max(1, data.page - 1))}
                >
                  <ArrowLeft /> Previous
                </Button>
                <strong>
                  {String(data.page).padStart(2, '0')} /{' '}
                  {String(data.totalPages).padStart(2, '0')}
                </strong>
                <Button
                  variant="outline"
                  disabled={data.page >= data.totalPages}
                  onClick={() => choosePage(data.page + 1)}
                >
                  Next <ArrowRight />
                </Button>
              </div>
            </footer>
          </>
        ) : (
          <div className="orders-state">
            <Search />
            <h3>No matching orders.</h3>
            <p>Change the status filter or search by order ID, PO, or buyer.</p>
          </div>
        )}
      </section>
    </main>
  );
}
