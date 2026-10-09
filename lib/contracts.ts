export type AccountRole = 'account_admin' | 'buyer' | 'support';

export type SessionSubject = {
  userId: string;
  customerId: string;
};

export type CheckoutInput = {
  commandId: string;
  expectedSubject: SessionSubject;
  customerPoNumber: string;
  requestedShipDate: string;
  shippingRegion: string;
  items: {
    itemNumber: string;
    quantity: number;
    expectedUnitPriceCents: number;
  }[];
};

export type CheckoutFailure = {
  error: string;
  code?: 'account_changed' | 'price_changed' | 'command_conflict';
};

export type CheckoutReceipt = {
  commandId: string;
  orderId: string;
  chargeId: string;
  authorizationCode: string;
  totalCents: number;
  currency: string;
  requestedShipDate: string;
};

export type AccountSummary = {
  customerId: string;
  displayName: string;
  accountTier: string;
  userId: string;
  userDisplayName: string;
  userRole: AccountRole;
  paymentTerms: string;
  currency: string;
  region: string;
  totalOrders: number;
  activeOrders: number;
  scheduledOrders: number;
  inventoryAlerts: number;
  seedAsOfDate: string;
  retrievedAt: string;
};

export type CatalogProduct = {
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

export type OrderStatus =
  | 'scheduled'
  | 'confirmed'
  | 'allocating'
  | 'backordered'
  | 'partially_shipped'
  | 'shipped'
  | 'delivered'
  | 'on_hold'
  | 'cancelled';

export type OrderHistoryFilter =
  | 'all'
  | 'active'
  | 'scheduled'
  | 'fulfilled'
  | 'closed';

export type OrderHistoryEntry = {
  orderId: string;
  customerPoNumber: string;
  createdOn: string;
  requestedShipDate: string;
  status: OrderStatus;
  currency: string;
  orderTotalCents: number;
  shippingRegion: string;
  placedByUserId: string;
  placedByName: string;
  lineCount: number;
  unitCount: number;
  shippedQuantity: number;
};

export type OrderHistoryResponse = {
  account: Pick<
    AccountSummary,
    | 'customerId'
    | 'userId'
    | 'displayName'
    | 'userDisplayName'
    | 'accountTier'
    | 'currency'
    | 'region'
  >;
  orders: OrderHistoryEntry[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  summary: {
    totalOrders: number;
    activeOrders: number;
    scheduledOrders: number;
    fulfilledOrders: number;
  };
};
