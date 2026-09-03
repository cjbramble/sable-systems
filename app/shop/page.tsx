'use client';

import Link from 'next/link';
import {
  SyntheticEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Box,
  ChevronRight,
  CircleDot,
  Cpu,
  LogOut,
  Minus,
  PackageCheck,
  Plus,
  ScanLine,
  Search,
  ShieldCheck,
  ShoppingBag,
  Sparkles,
  Trash2,
  Zap,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import {
  CATALOG_CATEGORIES,
  isCatalogCategory,
  type CatalogCategory,
} from '@/lib/catalog-categories';

type ShopCategory = 'All' | CatalogCategory;

type Product = {
  itemNumber: string;
  name: string;
  category: string;
  fulfillmentType: 'physical' | 'license';
  unitPriceCents: number;
  unitLabel: string;
  casePack: number;
  leadTimeDays: number;
  warrantyMonths: number;
  availableQuantity: number | null;
  inboundQuantity: number;
  restockDate: string | null;
};

type Confirmation = {
  orderId: string;
  authorizationCode: string;
  totalCents: number;
  requestedShipDate: string;
};

type AccountIdentity = {
  customerId: string;
  displayName: string;
  userDisplayName: string;
  paymentTerms: string;
  currency: string;
  region: string;
};

const categoryIcons = {
  Compute: Cpu,
  Interface: ScanLine,
  Cybernetics: CircleDot,
  Security: ShieldCheck,
  Software: Sparkles,
  Power: Zap,
} as const;

const productNotes: Record<string, string> = {
  'SBL-M14-CW': 'Cryogenic wafer-scale compute for dense autonomous systems.',
  'SBL-EID-R8':
    'Low-latency inference coprocessor with neural bus integration.',
  'SBL-NL-4P': 'Four-channel bidirectional neural signal gateway.',
  'SBL-KTA-T7': 'High-load synthetic tendon array for industrial augmentation.',
  'SBL-GG-R2': 'Sub-millimeter retinal projection for sealed field optics.',
  'SBL-AEG-4': 'Hardware-isolated perimeter defense for hostile networks.',
  'SBL-PAL-1Y': 'Managed endpoint hardening for distributed machine fleets.',
  'SBL-RLY-1Y': 'Encrypted node orchestration across unreliable links.',
};

function money(cents: number) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

function dateOffset(days: number) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

export default function ShopPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [account, setAccount] = useState<AccountIdentity | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [category, setCategory] = useState<ShopCategory>('All');
  const [query, setQuery] = useState('');
  const [cart, setCart] = useState<Record<string, number>>({});
  const [cartOpen, setCartOpen] = useState(false);
  const [poNumber, setPoNumber] = useState('');
  const [shipDate, setShipDate] = useState(dateOffset(14));
  const [region, setRegion] = useState('North Atlantic Trade District');
  const [chargeAccountAuthorized, setChargeAccountAuthorized] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [checkoutError, setCheckoutError] = useState('');
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);

  const loadCatalog = useCallback(async () => {
    try {
      const response = await fetch('/api/catalog', { cache: 'no-store' });
      const payload = (await response.json()) as {
        products?: Product[];
        error?: string;
      };
      if (response.status === 401) {
        window.location.replace('/login?next=/shop');
        return;
      }
      if (!response.ok || !payload.products)
        throw new Error(payload.error || 'Catalog unavailable.');
      setProducts(payload.products);
      setLoadError('');
    } catch (error) {
      setLoadError(
        error instanceof Error ? error.message : 'Catalog unavailable.',
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    fetch('/api/catalog', { cache: 'no-store' })
      .then(async (response) => {
        const payload = (await response.json()) as {
          products?: Product[];
          error?: string;
        };
        if (response.status === 401) {
          window.location.replace('/login?next=/shop');
          throw new Error('Authentication required.');
        }
        if (!response.ok || !payload.products)
          throw new Error(payload.error || 'Catalog unavailable.');
        return payload.products;
      })
      .then((nextProducts) => {
        if (!active) return;
        const requestedCategory = new URLSearchParams(
          window.location.search,
        ).get('category');
        setCategory(
          isCatalogCategory(requestedCategory) ? requestedCategory : 'All',
        );
        setProducts(nextProducts);
        setLoadError('');
      })
      .catch((error: unknown) => {
        if (active)
          setLoadError(
            error instanceof Error ? error.message : 'Catalog unavailable.',
          );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    fetch('/api/account', { cache: 'no-store' })
      .then(async (response) => {
        if (response.status === 401) {
          window.location.replace('/login?next=/shop');
          throw new Error('Authentication required.');
        }
        if (!response.ok) throw new Error('Account unavailable.');
        return (await response.json()) as AccountIdentity;
      })
      .then((identity) => {
        if (active) {
          setAccount(identity);
          setRegion(identity.region);
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

  const categories = useMemo<ShopCategory[]>(
    () => [
      'All',
      ...CATALOG_CATEGORIES.filter((catalogCategory) =>
        products.some((product) => product.category === catalogCategory),
      ),
    ],
    [products],
  );
  const filteredProducts = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return products.filter(
      (product) =>
        (category === 'All' || product.category === category) &&
        (!normalized ||
          `${product.name} ${product.itemNumber} ${product.category}`
            .toLowerCase()
            .includes(normalized)),
    );
  }, [category, products, query]);
  const cartProducts = products.filter((product) => cart[product.itemNumber]);
  const cartCount = Object.values(cart).reduce(
    (sum, quantity) => sum + quantity,
    0,
  );
  const subtotal = cartProducts.reduce(
    (sum, product) => sum + product.unitPriceCents * cart[product.itemNumber],
    0,
  );

  function changeQuantity(product: Product, delta: number) {
    setCart((current) => {
      const nextQuantity = Math.max(
        0,
        (current[product.itemNumber] || 0) + delta,
      );
      if (
        product.availableQuantity !== null &&
        nextQuantity > product.availableQuantity
      )
        return current;
      const next = { ...current };
      if (nextQuantity === 0) delete next[product.itemNumber];
      else next[product.itemNumber] = nextQuantity;
      return next;
    });
    setConfirmation(null);
    setCheckoutError('');
  }

  function removeFromCart(itemNumber: string) {
    setCart((current) => {
      const next = { ...current };
      delete next[itemNumber];
      return next;
    });
    setConfirmation(null);
    setCheckoutError('');
  }

  function chooseCategory(nextCategory: ShopCategory) {
    setCategory(nextCategory);
    const url = new URL(window.location.href);
    if (isCatalogCategory(nextCategory))
      url.searchParams.set('category', nextCategory);
    else url.searchParams.delete('category');
    window.history.replaceState(window.history.state, '', url);
  }

  async function submitOrder(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!cartProducts.length || !chargeAccountAuthorized || submitting) return;
    setSubmitting(true);
    setCheckoutError('');
    try {
      const response = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerPoNumber: poNumber,
          requestedShipDate: shipDate,
          shippingRegion: region,
          items: cartProducts.map((product) => ({
            itemNumber: product.itemNumber,
            quantity: cart[product.itemNumber],
          })),
        }),
      });
      const payload = (await response.json()) as Confirmation & {
        error?: string;
      };
      if (response.status === 401) {
        window.location.replace('/login?next=/shop');
        return;
      }
      if (!response.ok)
        throw new Error(payload.error || 'Order could not be placed.');
      setConfirmation(payload);
      setCart({});
      setPoNumber('');
      setChargeAccountAuthorized(false);
      await loadCatalog();
    } catch (error) {
      setCheckoutError(
        error instanceof Error ? error.message : 'Order could not be placed.',
      );
      await loadCatalog();
    } finally {
      setSubmitting(false);
    }
  }

  async function signOut() {
    await fetch('/api/auth/logout', { method: 'POST' });
    window.location.replace('/login');
  }

  if (!authChecked) {
    return (
      <main className="access-check">
        <ShieldCheck />
        <span>VERIFYING PROCUREMENT CREDENTIALS</span>
      </main>
    );
  }

  return (
    <main className="shop-page">
      <header className="shop-nav">
        <Link className="wordmark" href="/" aria-label="SABLE home">
          <span className="wordmark__sigil" aria-hidden="true" />
          <span>
            <strong>SABLE</strong>
            <small>Morrow Vale Holdings</small>
          </span>
        </Link>
        <div className="shop-account">
          <span>AUTHORIZED USER</span>
          <strong>
            {account?.userDisplayName ?? 'Authorized user'} {'//'}{' '}
            {account?.displayName ?? 'Distribution account'}
          </strong>
        </div>
        <div className="shop-nav__actions">
          <Link href="/orders">Order history</Link>
          <Link href="/support">COV-E Support</Link>
          <Button
            className="shop-logout"
            variant="ghost"
            size="icon"
            aria-label="Sign out"
            onClick={signOut}
          >
            <LogOut />
          </Button>
          <Button className="cart-trigger" onClick={() => setCartOpen(true)}>
            <ShoppingBag /> Cart <span>{cartCount}</span>
          </Button>
        </div>
      </header>

      <section className="shop-hero">
        <div>
          <Link className="back-link" href="/">
            <ArrowLeft /> SABLE Systems
          </Link>
          <p className="brand-kicker">
            <span /> LIVE PROCUREMENT NODE
          </p>
          <h1>
            Hardware for
            <br />
            <em>what comes next.</em>
          </h1>
        </div>
        <div className="shop-hero__meta">
          <div>
            <i />
            <span>Inventory synchronized</span>
          </div>
          <p>
            Wholesale pricing · Serialized fulfillment
            <br />
            Account terms: {account?.paymentTerms ?? 'Verified terms'}
          </p>
        </div>
      </section>

      <section className="catalog-tools">
        <div className="category-tabs" aria-label="Product categories">
          {categories.map((item) => (
            <button
              key={item}
              type="button"
              className={cn(category === item && 'is-active')}
              onClick={() => chooseCategory(item)}
            >
              {item}
            </button>
          ))}
        </div>
        <label className="catalog-search">
          <Search />
          <span className="sr-only">Search catalog</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search systems or item number"
          />
        </label>
      </section>

      <section className="catalog-section">
        <div className="catalog-heading">
          <span>
            {String(filteredProducts.length).padStart(2, '0')} systems online
          </span>
          <span>USD // WHOLESALE UNIT PRICING</span>
        </div>
        {loadError ? (
          <div className="catalog-state">
            <ShieldCheck />
            <h2>Inventory link interrupted</h2>
            <p>{loadError}</p>
            <Button onClick={() => void loadCatalog()}>Retry uplink</Button>
          </div>
        ) : loading ? (
          <div className="catalog-state">
            <span className="loading-ring" />
            <h2>Synchronizing inventory</h2>
          </div>
        ) : (
          <div className="product-grid">
            {filteredProducts.map((product, index) => {
              const Icon =
                categoryIcons[product.category as keyof typeof categoryIcons] ||
                Box;
              const unavailable = product.availableQuantity === 0;
              const inCart = cart[product.itemNumber] || 0;
              return (
                <article
                  className={cn(
                    'product-card',
                    unavailable && 'product-card--offline',
                  )}
                  key={product.itemNumber}
                >
                  <div className="product-card__top">
                    <span>{product.itemNumber}</span>
                    <span>
                      0{index + 1} /{' '}
                      {String(filteredProducts.length).padStart(2, '0')}
                    </span>
                  </div>
                  <div className="product-glyph">
                    <Icon />
                    <i />
                    <i />
                  </div>
                  <Badge variant="outline">{product.category}</Badge>
                  <h2>{product.name}</h2>
                  <p>
                    {productNotes[product.itemNumber] ||
                      `SABLE ${product.category.toLowerCase()} architecture for verified wholesale deployment.`}
                  </p>
                  <dl>
                    <div>
                      <dt>Pack</dt>
                      <dd>
                        {product.casePack} {product.unitLabel}
                        {product.casePack === 1 ? '' : 's'}
                      </dd>
                    </div>
                    <div>
                      <dt>Lead</dt>
                      <dd>
                        {product.leadTimeDays === 0
                          ? 'Instant'
                          : `${product.leadTimeDays} days`}
                      </dd>
                    </div>
                    <div>
                      <dt>Warranty</dt>
                      <dd>
                        {product.warrantyMonths
                          ? `${product.warrantyMonths} mo`
                          : 'License'}
                      </dd>
                    </div>
                  </dl>
                  <div className="product-stock">
                    <span className={cn(unavailable && 'is-empty')}>
                      <i />
                      {product.availableQuantity === null
                        ? 'Digital allocation'
                        : unavailable
                          ? 'Allocation exhausted'
                          : `${product.availableQuantity.toLocaleString()} available`}
                    </span>
                    {unavailable && product.restockDate ? (
                      <small>Inbound {product.restockDate}</small>
                    ) : null}
                  </div>
                  <div className="product-card__footer">
                    <div>
                      <strong>{money(product.unitPriceCents)}</strong>
                      <span>/ {product.unitLabel}</span>
                    </div>
                    {inCart ? (
                      <div className="quantity-control">
                        <Button
                          variant="outline"
                          size="icon-sm"
                          aria-label={`Remove ${product.casePack} ${product.name}`}
                          onClick={() =>
                            changeQuantity(product, -product.casePack)
                          }
                        >
                          <Minus />
                        </Button>
                        <strong>{inCart}</strong>
                        <Button
                          size="icon-sm"
                          aria-label={`Add ${product.casePack} ${product.name}`}
                          disabled={
                            product.availableQuantity !== null &&
                            inCart + product.casePack >
                              product.availableQuantity
                          }
                          onClick={() =>
                            changeQuantity(product, product.casePack)
                          }
                        >
                          <Plus />
                        </Button>
                      </div>
                    ) : (
                      <Button
                        disabled={unavailable}
                        onClick={() =>
                          changeQuantity(product, product.casePack)
                        }
                      >
                        {unavailable ? 'Unavailable' : 'Add case'}{' '}
                        <ChevronRight />
                      </Button>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      {cartCount ? (
        <button
          className="cart-dock"
          type="button"
          onClick={() => setCartOpen(true)}
        >
          <span>
            <ShoppingBag /> {cartCount} units queued
          </span>
          <strong>{money(subtotal)}</strong>
          <span>
            Review order <ArrowRight />
          </span>
        </button>
      ) : null}

      <Sheet open={cartOpen} onOpenChange={setCartOpen}>
        <SheetContent className="checkout-sheet">
          <SheetHeader className="checkout-header">
            <span className="brand-kicker">
              <span /> ORDER ASSEMBLY
            </span>
            <SheetTitle>Procurement queue</SheetTitle>
            <SheetDescription>
              {account?.displayName} · {account?.customerId}
            </SheetDescription>
          </SheetHeader>
          {confirmation ? (
            <div className="order-success">
              <span>
                <PackageCheck />
              </span>
              <p>CHARGE ACCOUNT AUTHORIZED</p>
              <h2>Order entered.</h2>
              <dl>
                <div>
                  <dt>Order</dt>
                  <dd>{confirmation.orderId}</dd>
                </div>
                <div>
                  <dt>Authorization</dt>
                  <dd>{confirmation.authorizationCode}</dd>
                </div>
                <div>
                  <dt>Order total</dt>
                  <dd>{money(confirmation.totalCents)}</dd>
                </div>
                <div>
                  <dt>Requested ship</dt>
                  <dd>{confirmation.requestedShipDate}</dd>
                </div>
              </dl>
              <p>
                The order has been posted to the {account?.displayName} charge
                account and inventory is reserved.
              </p>
              <Link className="order-history-link" href="/orders">
                View order history <ArrowRight />
              </Link>
              <Button onClick={() => setConfirmation(null)}>
                Build another order <ArrowRight />
              </Button>
            </div>
          ) : cartProducts.length ? (
            <form className="checkout-body" onSubmit={submitOrder}>
              <div className="checkout-lines">
                {cartProducts.map((product) => (
                  <div className="checkout-line" key={product.itemNumber}>
                    <div>
                      <span>{product.itemNumber}</span>
                      <strong>{product.name}</strong>
                      <small>
                        {money(product.unitPriceCents)} / {product.unitLabel}
                      </small>
                    </div>
                    <div className="quantity-control">
                      <Button
                        variant="outline"
                        size="icon-sm"
                        type="button"
                        onClick={() =>
                          changeQuantity(product, -product.casePack)
                        }
                      >
                        <Minus />
                      </Button>
                      <strong>{cart[product.itemNumber]}</strong>
                      <Button
                        size="icon-sm"
                        type="button"
                        disabled={
                          product.availableQuantity !== null &&
                          cart[product.itemNumber] + product.casePack >
                            product.availableQuantity
                        }
                        onClick={() =>
                          changeQuantity(product, product.casePack)
                        }
                      >
                        <Plus />
                      </Button>
                    </div>
                    <strong>
                      {money(product.unitPriceCents * cart[product.itemNumber])}
                    </strong>
                    <Button
                      className="remove-line"
                      variant="ghost"
                      size="icon-sm"
                      type="button"
                      aria-label={`Remove ${product.name} from cart`}
                      onClick={() => removeFromCart(product.itemNumber)}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                ))}
              </div>
              <div className="checkout-total">
                <span>Order total</span>
                <strong>{money(subtotal)}</strong>
              </div>
              <div className="checkout-form-grid">
                <label htmlFor="po-number">
                  <span>Purchase-order reference</span>
                  <Input
                    id="po-number"
                    required
                    minLength={4}
                    maxLength={40}
                    pattern="[A-Za-z0-9][A-Za-z0-9-]{3,39}"
                    value={poNumber}
                    onChange={(event) => setPoNumber(event.target.value)}
                    placeholder="ACCOUNT-PO-260901"
                  />
                </label>
                <label htmlFor="ship-date">
                  <span>Requested ship date</span>
                  <Input
                    id="ship-date"
                    required
                    type="date"
                    min={dateOffset(0)}
                    value={shipDate}
                    onChange={(event) => setShipDate(event.target.value)}
                  />
                </label>
                <label className="wide" htmlFor="ship-region">
                  <span>Destination region</span>
                  <Input
                    id="ship-region"
                    required
                    minLength={3}
                    maxLength={80}
                    value={region}
                    onChange={(event) => setRegion(event.target.value)}
                  />
                </label>
              </div>
              <label className="charge-account-consent">
                <input
                  type="checkbox"
                  checked={chargeAccountAuthorized}
                  onChange={(event) =>
                    setChargeAccountAuthorized(event.target.checked)
                  }
                />
                <span>
                  <strong>
                    Charge this order to the {account?.displayName} account
                  </strong>
                  <small>
                    Account terms: {account?.paymentTerms} · {account?.currency}{' '}
                    billing ledger
                  </small>
                </span>
                <ShieldCheck />
              </label>
              {checkoutError ? (
                <p className="checkout-error">{checkoutError}</p>
              ) : null}
              <Button
                className="place-order"
                size="lg"
                type="submit"
                disabled={!chargeAccountAuthorized || submitting}
              >
                {submitting
                  ? 'Reserving inventory…'
                  : 'Place charge account order'}{' '}
                <ArrowRight />
              </Button>
            </form>
          ) : (
            <div className="empty-cart">
              <ShoppingBag />
              <h2>Queue is empty.</h2>
              <p>Select whole case packs from the live catalog to begin.</p>
              <Button onClick={() => setCartOpen(false)}>
                Return to catalog
              </Button>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </main>
  );
}
