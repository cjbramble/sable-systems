import {
  serializeSeedRecord,
  type SeedRecord,
  type SeedStatement,
} from './seed-records.ts';
import type { OrderStatus } from '../lib/contracts.ts';

type ProductSeed = {
  itemNumber: string;
  name: string;
  category: string;
  fulfillmentType: 'physical' | 'license';
  unitPriceCents: number;
  unitLabel: string;
  casePack: number;
  leadTimeDays: number;
  warrantyMonths: number;
  activeFrom: string;
  activeTo: string | null;
  searchTerms: string;
  available: number;
  reserved: number;
  quarantined: number;
  inbound: number;
  restockDate: string | null;
};

type OrderItemSeed = {
  itemNumber: string;
  quantity: number;
};

type OrderSeed = {
  orderId: string;
  customerId: string;
  placedByUserId: string;
  customerPoNumber: string;
  createdOn: string;
  requestedShipDate: string;
  status: OrderStatus;
  shippingRegion: string;
  items: OrderItemSeed[];
  eventDescription?: string;
};

const PRIMARY_CUSTOMER_ID = 'WHS-0427';
const PRIMARY_USER_ID = 'USR-CPD-001';
export const AS_OF_DATE = '2026-09-02';

const userIdByCustomer: Record<string, string> = {
  'WHS-0427': PRIMARY_USER_ID,
  'WHS-1098': 'USR-MCS-001',
  'WHS-2714': 'USR-NPC-001',
  'WHS-5830': 'USR-HIX-001',
};

const products: ProductSeed[] = [
  product(
    'SBL-M14-CW',
    'Monarch M14 Compute Wafer',
    'Compute',
    128000,
    'wafer',
    4,
    28,
    36,
    'monarch,m14,compute wafer',
    224,
    72,
  ),
  product(
    'SBL-EID-R8',
    'Eidolon R8 Neural Coprocessor',
    'Compute',
    465000,
    'unit',
    2,
    45,
    48,
    'eidolon,r8,neural coprocessor',
    48,
    20,
  ),
  product(
    'SBL-HXB-09',
    'Hexrail System Backplane',
    'Compute',
    78000,
    'unit',
    6,
    21,
    24,
    'hexrail,backplane',
    310,
    66,
  ),
  product(
    'SBL-NV-16T',
    'Nightvault 16 TB Solid-State Array',
    'Compute',
    194000,
    'array',
    4,
    35,
    36,
    'nightvault,16 tb,storage,array',
    96,
    28,
  ),
  product(
    'SBL-GG-R2',
    'Ghostglass Retinal Display R2',
    'Interface',
    320000,
    'display',
    2,
    42,
    24,
    'ghostglass,retinal display,r2',
    61,
    17,
  ),
  product(
    'SBL-NL-4P',
    'Nerveline Four-Port Neural I/O Hub',
    'Interface',
    590000,
    'hub',
    1,
    42,
    36,
    'nerveline,neural io,neural i/o,hub',
    0,
    84,
    0,
    80,
    '2026-10-14',
  ),
  product(
    'SBL-BCH-V3',
    'Blackchannel Haptic Controller',
    'Interface',
    146000,
    'controller',
    4,
    24,
    24,
    'blackchannel,haptic,controller',
    134,
    38,
  ),
  product(
    'SBL-SWC-12',
    'Signal-Weave Active Cable, 12 m',
    'Interface',
    29000,
    'cable',
    12,
    10,
    12,
    'signal-weave,signal weave,cable',
    720,
    144,
  ),
  product(
    'SBL-KTA-T7',
    'Kestrel Tendon Assembly T7',
    'Cybernetics',
    875000,
    'assembly',
    1,
    60,
    48,
    'kestrel,tendon,t7',
    7,
    24,
  ),
  product(
    'SBL-MYO-H2',
    'Meridian Myomer Driver H2',
    'Cybernetics',
    248000,
    'driver',
    2,
    36,
    36,
    'meridian,myomer,driver,h2',
    74,
    26,
  ),
  product(
    'SBL-SIN-44',
    'Synapse Isolation Node S44',
    'Cybernetics',
    115000,
    'node',
    6,
    30,
    24,
    'synapse,isolation node,s44',
    206,
    58,
  ),
  product(
    'SBL-DMK-A9',
    'Dermal Maintenance Kit A9',
    'Cybernetics',
    42500,
    'kit',
    12,
    14,
    12,
    'dermal,maintenance kit,a9',
    488,
    96,
  ),
  product(
    'SBL-AEG-4',
    'Aegis Hardware Firewall',
    'Security',
    185000,
    'unit',
    4,
    21,
    36,
    'aegis,hardware firewall,firewall',
    87,
    33,
  ),
  product(
    'SBL-PAL-1Y',
    'Palisade Endpoint License, Annual',
    'Software',
    39000,
    'seat',
    25,
    0,
    0,
    'palisade,endpoint license,license',
    0,
    0,
    0,
    0,
    null,
    'license',
  ),
  product(
    'SBL-RLY-1Y',
    'RelayMesh Node License, Annual',
    'Software',
    62000,
    'node',
    10,
    0,
    0,
    'relaymesh,relay mesh,node license',
    0,
    0,
    0,
    0,
    null,
    'license',
  ),
  product(
    'SBL-RPC-12',
    'Redline Power Cell R12',
    'Power',
    68000,
    'cell',
    8,
    18,
    18,
    'redline,power cell,r12',
    312,
    64,
  ),
  product(
    'SBL-GLV-V5',
    'Grayline Voice Interface V5',
    'Legacy Interface',
    98000,
    'unit',
    4,
    0,
    12,
    'grayline,voice interface,v5,legacy',
    8,
    0,
    0,
    0,
    null,
    'physical',
    '2021-01-01',
    '2025-06-30',
  ),
  product(
    'SBL-CSR-R2',
    'Coldstart Rack Controller R2',
    'Compute',
    225000,
    'controller',
    4,
    90,
    24,
    'coldstart,rack controller,r2',
    0,
    0,
    36,
    48,
    '2026-12-03',
  ),
];

const productById = new Map(products.map((row) => [row.itemNumber, row]));

const representativeOrders: OrderSeed[] = [
  order(
    'SBL-2021-000041',
    'CPD-PO-210041',
    '2021-03-18',
    '2021-04-12',
    'delivered',
    [['SBL-GLV-V5', 24]],
    'Legacy interface consignment delivered and accepted.',
  ),
  order(
    'SBL-2022-000118',
    'CPD-PO-220118',
    '2022-06-04',
    '2022-06-27',
    'delivered',
    [['SBL-DMK-A9', 120]],
    'Delivery completed; twelve kits were later authorized for return.',
  ),
  order(
    'SBL-2023-000205',
    'CPD-PO-230205',
    '2023-02-08',
    '2023-03-01',
    'cancelled',
    [['SBL-AEG-4', 12]],
    'Cancelled by Calder Pike before allocation.',
  ),
  order(
    'SBL-2024-000311',
    'CPD-PO-240311',
    '2024-05-11',
    '2024-06-07',
    'delivered',
    [
      ['SBL-GG-R2', 40],
      ['SBL-BCH-V3', 24],
    ],
    'Two-part delivery completed at the North Atlantic receiving stack.',
  ),
  order(
    'SBL-2025-000366',
    'CPD-PO-250366',
    '2025-09-02',
    '2025-10-06',
    'delivered',
    [
      ['SBL-M14-CW', 80],
      ['SBL-HXB-09', 36],
    ],
    'Compute consignment delivered without exception.',
  ),
  order(
    'SBL-2026-000417',
    'CPD-PO-260417',
    '2026-08-03',
    '2026-08-26',
    'partially_shipped',
    [
      ['SBL-RPC-12', 64],
      ['SBL-SWC-12', 120],
    ],
    'Cable allocation shipped in full; thirty-two power cells remain pending carrier recovery.',
  ),
  order(
    'SBL-2026-000418',
    'CPD-PO-260418',
    '2026-08-12',
    '2026-09-12',
    'backordered',
    [['SBL-NL-4P', 20]],
    'Nerveline allocation is awaiting the inbound lot expected 2026-10-14.',
  ),
  order(
    'SBL-2026-000419',
    'CPD-PO-260419',
    '2026-08-16',
    '2026-09-18',
    'on_hold',
    [['SBL-CSR-R2', 12]],
    'Coldstart controllers are held under batch quarantine pending inspection.',
  ),
  order(
    'SBL-2026-000420',
    'CPD-PO-260420',
    '2026-08-22',
    '2026-09-28',
    'confirmed',
    [
      ['SBL-AEG-4', 20],
      ['SBL-PAL-1Y', 200],
    ],
    'Order confirmed; physical allocation has not started.',
  ),
  order(
    'SBL-2027-000031',
    'CPD-REL-270031',
    '2026-08-25',
    '2027-02-15',
    'scheduled',
    [
      ['SBL-KTA-T7', 12],
      ['SBL-MYO-H2', 24],
    ],
    'Scheduled contract release; allocation opens 2027-01-04.',
  ),
  order(
    'SBL-2029-000077',
    'CPD-REL-290077',
    '2026-08-25',
    '2029-04-09',
    'scheduled',
    [
      ['SBL-GG-R2', 30],
      ['SBL-NL-4P', 10],
    ],
    'Scheduled contract release under the 2026 framework agreement.',
  ),
  order(
    'SBL-2031-000124',
    'CPD-REL-310124',
    '2026-08-25',
    '2031-08-18',
    'scheduled',
    [
      ['SBL-M14-CW', 200],
      ['SBL-NV-16T', 40],
    ],
    'Long-range scheduled release; pricing is fixed by the framework agreement.',
  ),
];

export function buildSeedStatements(): SeedStatement[] {
  return buildSeedRecords().map(serializeSeedRecord);
}

export function buildSeedRecords(): SeedRecord[] {
  const records: SeedRecord[] = [];
  appendReferenceRecords(records);

  const orders = [
    ...representativeOrders,
    ...generatePrimaryOrders(636),
    ...generateOtherDistributorOrders(),
  ];
  for (const row of orders) appendOrderRecords(records, row);

  appendReturnRecords(records);
  records.push({
    table: 'metadata',
    values: { key: 'as_of_date', value: AS_OF_DATE },
  });
  return records;
}

function product(
  itemNumber: string,
  name: string,
  category: string,
  unitPriceCents: number,
  unitLabel: string,
  casePack: number,
  leadTimeDays: number,
  warrantyMonths: number,
  searchTerms: string,
  available: number,
  reserved: number,
  quarantined = 0,
  inbound = 0,
  restockDate: string | null = null,
  fulfillmentType: 'physical' | 'license' = 'physical',
  activeFrom = '2021-01-01',
  activeTo: string | null = null,
): ProductSeed {
  return {
    itemNumber,
    name,
    category,
    fulfillmentType,
    unitPriceCents,
    unitLabel,
    casePack,
    leadTimeDays,
    warrantyMonths,
    activeFrom,
    activeTo,
    searchTerms,
    available,
    reserved,
    quarantined,
    inbound,
    restockDate,
  };
}

function order(
  orderId: string,
  customerPoNumber: string,
  createdOn: string,
  requestedShipDate: string,
  status: OrderStatus,
  items: Array<[string, number]>,
  eventDescription?: string,
): OrderSeed {
  return {
    orderId,
    customerId: PRIMARY_CUSTOMER_ID,
    placedByUserId: PRIMARY_USER_ID,
    customerPoNumber,
    createdOn,
    requestedShipDate,
    status,
    shippingRegion: 'North Atlantic Trade District',
    items: items.map(([itemNumber, quantity]) => ({ itemNumber, quantity })),
    eventDescription,
  };
}

function appendReferenceRecords(records: SeedRecord[]) {
  const distributors = [
    {
      customer_id: 'WHS-0427',
      legal_name: 'Calder Pike Distribution Cooperative',
      display_name: 'Calder Pike Distribution',
      account_tier: 'Obsidian Preferred',
      account_status: 'active',
      payment_terms: 'Net 45',
      currency: 'USD',
      region: 'North Atlantic Trade District',
    },
    {
      customer_id: 'WHS-1098',
      legal_name: 'Meridian Civic Supply Limited',
      display_name: 'Meridian Civic Supply',
      account_tier: 'Standard',
      account_status: 'active',
      payment_terms: 'Net 30',
      currency: 'USD',
      region: 'Meridian Corridor',
    },
    {
      customer_id: 'WHS-2714',
      legal_name: 'Northline Prosthetics Cooperative',
      display_name: 'Northline Prosthetics Cooperative',
      account_tier: 'Preferred',
      account_status: 'active',
      payment_terms: 'Net 45',
      currency: 'USD',
      region: 'Great Lakes District',
    },
    {
      customer_id: 'WHS-5830',
      legal_name: 'Halcyon Industrial Exchange Incorporated',
      display_name: 'Halcyon Industrial Exchange',
      account_tier: 'Standard',
      account_status: 'active',
      payment_terms: 'Net 30',
      currency: 'USD',
      region: 'Pacific Trade Zone',
    },
  ];
  for (const values of distributors)
    records.push({ table: 'distributors', values: values });

  const users = [
    {
      user_id: PRIMARY_USER_ID,
      distributor_id: PRIMARY_CUSTOMER_ID,
      display_name: 'Mara Venn',
      email: 'mara.venn@calderpike.example',
      role: 'account_admin',
      status: 'active',
      created_on: '2021-01-04',
      last_login_at: '2026-09-02T08:42:00Z',
    },
    {
      user_id: 'USR-MCS-001',
      distributor_id: 'WHS-1098',
      display_name: 'Imani Kade',
      email: 'imani.kade@meridiancivic.example',
      role: 'account_admin',
      status: 'active',
      created_on: '2021-02-15',
      last_login_at: '2026-08-29T13:05:00Z',
    },
    {
      user_id: 'USR-NPC-001',
      distributor_id: 'WHS-2714',
      display_name: 'Rowan Sato',
      email: 'rowan.sato@northline.example',
      role: 'account_admin',
      status: 'active',
      created_on: '2021-03-08',
      last_login_at: '2026-08-31T16:20:00Z',
    },
    {
      user_id: 'USR-HIX-001',
      distributor_id: 'WHS-5830',
      display_name: 'Lena Orr',
      email: 'lena.orr@halcyonexchange.example',
      role: 'account_admin',
      status: 'active',
      created_on: '2021-04-19',
      last_login_at: '2026-08-27T10:15:00Z',
    },
  ];
  for (const values of users) records.push({ table: 'users', values: values });

  const credentials = [
    {
      user_id: PRIMARY_USER_ID,
      password_salt: '1lIuQK9XkwWkY0c0AE4ZXg',
      password_hash: 'RSZ-1tPotPr5bdAasAm06V-Qa4mC_m5Lj5khmqATtdE',
      password_iterations: 210000,
      password_updated_at: '2026-09-02T10:30:00Z',
    },
    {
      user_id: 'USR-MCS-001',
      password_salt: 'Wt9n8uox9Upi6cBE_ye-6g',
      password_hash: 'UrIMz0NH1Hhy8E5yDuElml5XW3z8E_KKnbvQmtG3AsM',
      password_iterations: 210000,
      password_updated_at: '2026-09-02T10:30:00Z',
    },
    {
      user_id: 'USR-NPC-001',
      password_salt: 'g8JLxlQzzW2g424PDxucig',
      password_hash: 'kQ99m_A5Z6uyu145H3Kq50iDLIaVskUN5KovMkapyZY',
      password_iterations: 210000,
      password_updated_at: '2026-09-02T10:30:00Z',
    },
    {
      user_id: 'USR-HIX-001',
      password_salt: 'gd8bi2Giq_dEaikXJ3kGaA',
      password_hash: 'Yehzp-jylkN6Zz74bgfGGr9on7GoyCeqV5ht6mVHilA',
      password_iterations: 210000,
      password_updated_at: '2026-09-02T10:30:00Z',
    },
  ];
  for (const values of credentials)
    records.push({ table: 'user_credentials', values: values });

  for (const row of products) {
    records.push({
      table: 'products',
      values: {
        item_number: row.itemNumber,
        product_name: row.name,
        category: row.category,
        fulfillment_type: row.fulfillmentType,
        unit_price_cents: row.unitPriceCents,
        unit_label: row.unitLabel,
        case_pack: row.casePack,
        lead_time_days: row.leadTimeDays,
        warranty_months: row.warrantyMonths,
        active_from: row.activeFrom,
        active_to: row.activeTo,
        search_terms: row.searchTerms,
      },
    });
  }

  const locations = [
    {
      location_id: 'ATL-01',
      location_name: 'Atlantic Stack Fulfillment Hub',
      service_region: 'North Atlantic Trade District',
    },
    {
      location_id: 'GLK-02',
      location_name: 'Great Lakes Technical Depot',
      service_region: 'Great Lakes District',
    },
    {
      location_id: 'PAC-03',
      location_name: 'Pacific Rim Bonded Yard',
      service_region: 'Pacific Trade Zone',
    },
  ];
  for (const values of locations)
    records.push({ table: 'fulfillment_locations', values: values });

  for (const row of products.filter(
    (item) => item.fulfillmentType === 'physical',
  )) {
    const weights = [0.5, 0.3, 0.2];
    const locationIds = ['ATL-01', 'GLK-02', 'PAC-03'];
    let availableRemaining = row.available;
    let reservedRemaining = row.reserved;
    let quarantineRemaining = row.quarantined;
    let inboundRemaining = row.inbound;
    for (let index = 0; index < locationIds.length; index += 1) {
      const last = index === locationIds.length - 1;
      const available = last
        ? availableRemaining
        : Math.floor(row.available * weights[index]);
      const reserved = last
        ? reservedRemaining
        : Math.floor(row.reserved * weights[index]);
      const quarantined = last
        ? quarantineRemaining
        : Math.floor(row.quarantined * weights[index]);
      const inbound = last
        ? inboundRemaining
        : Math.floor(row.inbound * weights[index]);
      availableRemaining -= available;
      reservedRemaining -= reserved;
      quarantineRemaining -= quarantined;
      inboundRemaining -= inbound;
      records.push({
        table: 'inventory_balances',
        values: {
          item_number: row.itemNumber,
          location_id: locationIds[index],
          on_hand_quantity: available + reserved + quarantined,
          reserved_quantity: reserved,
          quarantined_quantity: quarantined,
          inbound_quantity: inbound,
          expected_restock_date: row.restockDate,
          updated_at: `${AS_OF_DATE}T09:00:00Z`,
        },
      });
    }
  }
}

function generatePrimaryOrders(count: number): OrderSeed[] {
  return Array.from({ length: count }, (_, index) =>
    generatedOrder(
      PRIMARY_CUSTOMER_ID,
      'CPD',
      index,
      100000 + index,
      primaryGeneratedYear(index),
    ),
  );
}

function generateOtherDistributorOrders(): OrderSeed[] {
  const customers = [
    ['WHS-1098', 'MCS'],
    ['WHS-2714', 'NPC'],
    ['WHS-5830', 'HIX'],
  ] as const;
  return customers.flatMap(([customerId, prefix], customerIndex) =>
    Array.from({ length: 24 }, (_, index) =>
      generatedOrder(
        customerId,
        prefix,
        index + customerIndex * 24,
        500000 + customerIndex * 1000 + index,
        otherGeneratedYear(index),
      ),
    ),
  );
}

function generatedOrder(
  customerId: string,
  poPrefix: string,
  index: number,
  sequence: number,
  year: number,
): OrderSeed {
  const month = year === 2026 ? 8 : 1 + ((index * 5) % 12);
  const day = 1 + ((index * 11) % 24);
  const requestedShipDate = isoDate(year, month, day);
  const createdOn =
    year > 2026
      ? isoDate(2026, 7 + (index % 2), 1 + (index % 24))
      : isoDate(year, Math.max(1, month - 1), day);
  const status = generatedStatus(year, month, index);
  const lineCount = 2 + (index % 4);
  const activeProducts = products.filter(
    (row) => row.activeTo === null && row.itemNumber !== 'SBL-CSR-R2',
  );
  const items = Array.from({ length: lineCount }, (_, lineIndex) => {
    const selected =
      activeProducts[(index * 3 + lineIndex * 5) % activeProducts.length];
    const packs = 1 + ((index + lineIndex * 7) % 16);
    return {
      itemNumber: selected.itemNumber,
      quantity: selected.casePack * packs,
    };
  });
  return {
    orderId: `SBL-${year}-${String(sequence).padStart(6, '0')}`,
    customerId,
    placedByUserId: userIdByCustomer[customerId],
    customerPoNumber: `${poPrefix}-${year > 2026 ? 'REL' : 'PO'}-${String(sequence).padStart(6, '0')}`,
    createdOn,
    requestedShipDate,
    status,
    shippingRegion:
      customerId === PRIMARY_CUSTOMER_ID
        ? 'North Atlantic Trade District'
        : 'Authorized external district',
    items,
  };
}

function primaryGeneratedYear(index: number) {
  if (index < 414) return 2021 + (index % 5);
  if (index < 478) return 2026;
  return 2027 + ((index - 478) % 5);
}

function otherGeneratedYear(index: number) {
  if (index < 16) return 2021 + (index % 5);
  if (index < 18) return 2026;
  return 2027 + ((index - 18) % 5);
}

function generatedStatus(
  year: number,
  month: number,
  index: number,
): OrderStatus {
  if (year < 2026) return index % 17 === 0 ? 'cancelled' : 'delivered';
  if (year > 2026)
    return year === 2027 && index % 5 === 0 ? 'confirmed' : 'scheduled';
  if (month > 9) return index % 3 === 0 ? 'confirmed' : 'scheduled';
  const active: OrderStatus[] = [
    'delivered',
    'shipped',
    'partially_shipped',
    'allocating',
    'backordered',
    'on_hold',
  ];
  return active[index % active.length];
}

function appendOrderRecords(records: SeedRecord[], row: OrderSeed) {
  const plannedShippedOn = addDays(
    row.requestedShipDate,
    row.status === 'delivered' ? -2 : 0,
  );
  const plannedDelivery = addDays(row.requestedShipDate, 5);
  // The flagship delayed shipment keeps its missed estimate on purpose.
  const delayed =
    row.status === 'partially_shipped' && row.orderId === 'SBL-2026-000417';
  const shipmentTimeline = [
    'delivered',
    'shipped',
    'partially_shipped',
  ].includes(row.status)
    ? {
        // Early-year generated orders can be created on their requested ship date.
        shippedOn:
          plannedShippedOn < row.createdOn ? row.createdOn : plannedShippedOn,
        // A shipment still moving at the as-of date can't already be due.
        estimatedDeliveryDate:
          row.status !== 'delivered' &&
          !delayed &&
          plannedDelivery <= AS_OF_DATE
            ? addDays(AS_OF_DATE, 3)
            : plannedDelivery,
        deliveredOn:
          row.status === 'delivered' ? addDays(row.requestedShipDate, 4) : null,
      }
    : null;
  // Status events happen on or before the as-of date; a future ship date is
  // when the order is due, not when its status was recorded.
  const statusDate =
    shipmentTimeline?.deliveredOn ??
    shipmentTimeline?.shippedOn ??
    (row.requestedShipDate <= AS_OF_DATE
      ? row.requestedShipDate
      : earliestDate(addDays(row.createdOn, 7), AS_OF_DATE));
  const itemRows = row.items.map((item, index) => {
    const catalog = productById.get(item.itemNumber);
    if (!catalog) throw new Error(`Unknown seed product ${item.itemNumber}`);
    const quantities = quantitiesForStatus(
      row.status,
      item.quantity,
      catalog.casePack,
      index,
    );
    // Licenses are allocated digitally; they never travel in a shipment.
    const freight = catalog.fulfillmentType !== 'license';
    return {
      catalog,
      lineNumber: index + 1,
      quantity: item.quantity,
      freight,
      ...quantities,
    };
  });
  const totalCents = itemRows.reduce(
    (total, item) => total + item.catalog.unitPriceCents * item.quantity,
    0,
  );
  records.push({
    table: 'orders',
    values: {
      order_id: row.orderId,
      customer_id: row.customerId,
      placed_by_user_id: row.placedByUserId,
      customer_po_number: row.customerPoNumber,
      created_on: row.createdOn,
      requested_ship_date: row.requestedShipDate,
      status: row.status,
      currency: 'USD',
      order_total_cents: totalCents,
      shipping_region: row.shippingRegion,
    },
  });
  for (const item of itemRows) {
    records.push({
      table: 'order_items',
      values: {
        order_id: row.orderId,
        line_number: item.lineNumber,
        item_number: item.catalog.itemNumber,
        product_name_snapshot: item.catalog.name,
        unit_price_cents: item.catalog.unitPriceCents,
        ordered_quantity: item.quantity,
        allocated_quantity: item.allocated,
        shipped_quantity: item.shipped,
        cancelled_quantity: item.cancelled,
      },
    });
  }
  records.push({
    table: 'order_events',
    values: {
      event_id: `EVT-${row.orderId}-001`,
      order_id: row.orderId,
      occurred_at: `${row.createdOn}T14:00:00Z`,
      event_type: 'order_created',
      customer_safe_description: `Purchase order ${row.customerPoNumber} entered the SABLE fulfillment network.`,
    },
  });
  records.push({
    table: 'order_events',
    values: {
      event_id: `EVT-${row.orderId}-002`,
      order_id: row.orderId,
      occurred_at: `${statusDate}T09:00:00Z`,
      event_type: row.status,
      customer_safe_description:
        row.eventDescription ?? statusDescription(row.status),
    },
  });

  if (shipmentTimeline) {
    const shipmentId = `SHP-${row.orderId.slice(4)}`;
    const shipmentStatus =
      row.status === 'delivered'
        ? 'delivered'
        : delayed
          ? 'delayed'
          : 'in_transit';
    records.push({
      table: 'shipments',
      values: {
        shipment_id: shipmentId,
        order_id: row.orderId,
        status: shipmentStatus,
        carrier_name: 'Astra Freight Systems',
        tracking_reference: `AST-${row.orderId.replaceAll('-', '').slice(3)}`,
        shipped_on: shipmentTimeline.shippedOn,
        estimated_delivery_date: shipmentTimeline.estimatedDeliveryDate,
        delivered_on: shipmentTimeline.deliveredOn,
      },
    });
    for (const item of itemRows.filter(
      (candidate) => candidate.freight && candidate.shipped > 0,
    )) {
      records.push({
        table: 'shipment_items',
        values: {
          shipment_id: shipmentId,
          order_id: row.orderId,
          line_number: item.lineNumber,
          shipped_quantity: item.shipped,
        },
      });
    }
  }
}

function quantitiesForStatus(
  status: OrderStatus,
  quantity: number,
  casePack: number,
  lineIndex: number,
) {
  if (status === 'delivered' || status === 'shipped')
    return { allocated: quantity, shipped: quantity, cancelled: 0 };
  if (status === 'cancelled')
    return { allocated: 0, shipped: 0, cancelled: quantity };
  // Even lines ship half their packs, rounded down, so the first line is
  // always short and the order is genuinely partial.
  if (status === 'partially_shipped') {
    const packs = Math.floor(
      quantity / casePack / (lineIndex % 2 === 0 ? 2 : 1),
    );
    return {
      allocated: quantity,
      shipped: Math.min(quantity, packs * casePack),
      cancelled: 0,
    };
  }
  if (status === 'allocating')
    return {
      allocated: Math.floor(quantity / casePack / 2) * casePack,
      shipped: 0,
      cancelled: 0,
    };
  return { allocated: 0, shipped: 0, cancelled: 0 };
}

function appendReturnRecords(records: SeedRecord[]) {
  records.push({
    table: 'returns',
    values: {
      return_id: 'RTN-2022-000014',
      order_id: 'SBL-2022-000118',
      status: 'closed',
      reason_code: 'sealed_surplus',
      requested_on: '2022-07-08',
      authorized_on: '2022-07-09',
      received_on: '2022-07-21',
    },
  });
  records.push({
    table: 'return_items',
    values: {
      return_id: 'RTN-2022-000014',
      order_id: 'SBL-2022-000118',
      line_number: 1,
      return_quantity: 12,
      disposition: 'restock',
    },
  });
}

function statusDescription(status: OrderStatus) {
  const descriptions: Record<OrderStatus, string> = {
    scheduled: 'Scheduled release is recorded; allocation has not opened.',
    confirmed:
      'Commercial terms confirmed; physical allocation has not started.',
    allocating: 'Inventory allocation is in progress.',
    backordered: 'One or more order lines are awaiting inbound inventory.',
    partially_shipped: 'A partial consignment has entered the carrier network.',
    shipped: 'The consignment has entered the carrier network.',
    delivered: 'Carrier delivery was confirmed.',
    on_hold: 'Fulfillment is paused pending an operational review.',
    cancelled: 'The order was cancelled before completion.',
  };
  return descriptions[status];
}

function isoDate(year: number, month: number, day: number) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function earliestDate(left: string, right: string) {
  return left < right ? left : right;
}

function addDays(value: string, days: number) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// Support history uses its own transactional marker, independent of main seed offsets.
export function buildSupportSeedStatements(
  userIds: readonly string[],
): SeedStatement[] {
  const templates = [
    {
      suffix: '01',
      title: 'Priority shipment trace',
      timestamp: '2026-09-03T08:42:00Z',
      customer: 'Trace the priority shipment on our latest release.',
      assistant:
        'The latest priority release is allocated and queued for carrier handoff. I can provide the order-level milestones if you share the order number.',
    },
    {
      suffix: '02',
      title: 'Nerveline allocation',
      timestamp: '2026-08-29T15:18:00Z',
      customer: 'Check Nerveline hub availability for our account.',
      assistant:
        'I can check current Nerveline allocation, inbound quantities, and lead times against your authorized account.',
    },
    {
      suffix: '03',
      title: '2030 contract releases',
      timestamp: '2026-08-24T11:06:00Z',
      customer: 'Show our scheduled contract releases for 2030.',
      assistant:
        'Your 2030 releases can be reviewed by requested ship date, allocation state, or customer purchase order.',
    },
  ];
  const statements: SeedStatement[] = [];
  for (const userId of userIds) {
    for (const template of templates) {
      const incidentId = `INC-${userId}-${template.suffix}`;
      statements.push(
        {
          sql: `INSERT OR IGNORE INTO support_incidents
            (incident_id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
          params: [
            incidentId,
            userId,
            template.title,
            template.timestamp,
            template.timestamp,
          ],
        },
        {
          sql: `INSERT OR IGNORE INTO support_messages
            (message_id, incident_id, sequence_number, role, content, created_at)
            VALUES (?, ?, 1, 'user', ?, ?)`,
          params: [
            `MSG-${userId}-${template.suffix}-01`,
            incidentId,
            template.customer,
            template.timestamp,
          ],
        },
        {
          sql: `INSERT OR IGNORE INTO support_messages
            (message_id, incident_id, sequence_number, role, content, created_at)
            VALUES (?, ?, 2, 'assistant', ?, ?)`,
          params: [
            `MSG-${userId}-${template.suffix}-02`,
            incidentId,
            template.assistant,
            template.timestamp,
          ],
        },
      );
    }
  }
  return statements;
}
