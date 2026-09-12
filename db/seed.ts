import type { OrderStatus } from '../lib/contracts.ts';

export type SeedStatement = {
  sql: string;
  params: Array<string | number | null>;
};

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

export const PRIMARY_CUSTOMER_ID = 'WHS-0427';
export const PRIMARY_USER_ID = 'USR-CPD-001';
export const AS_OF_DATE = '2026-09-02';

const userIdByCustomer: Record<string, string> = {
  'WHS-0427': PRIMARY_USER_ID,
  'WHS-1098': 'USR-MCS-001',
  'WHS-2714': 'USR-NPC-001',
  'WHS-5830': 'USR-HIX-001',
};

export const products: ProductSeed[] = [
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
  const statements: SeedStatement[] = [];
  insertReferenceData(statements);

  const orders = [
    ...representativeOrders,
    ...generatePrimaryOrders(636),
    ...generateOtherDistributorOrders(),
  ];
  for (const row of orders) insertOrder(statements, row);

  insertRepresentativeReturn(statements);
  statements.push({
    sql: 'INSERT INTO metadata (key, value) VALUES (?, ?)',
    params: ['as_of_date', AS_OF_DATE],
  });
  return statements;
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

function insertReferenceData(statements: SeedStatement[]) {
  const distributors = [
    [
      'WHS-0427',
      'Calder Pike Distribution Cooperative',
      'Calder Pike Distribution',
      'Obsidian Preferred',
      'active',
      'Net 45',
      'USD',
      'North Atlantic Trade District',
    ],
    [
      'WHS-1098',
      'Meridian Civic Supply Limited',
      'Meridian Civic Supply',
      'Standard',
      'active',
      'Net 30',
      'USD',
      'Meridian Corridor',
    ],
    [
      'WHS-2714',
      'Northline Prosthetics Cooperative',
      'Northline Prosthetics Cooperative',
      'Preferred',
      'active',
      'Net 45',
      'USD',
      'Great Lakes District',
    ],
    [
      'WHS-5830',
      'Halcyon Industrial Exchange Incorporated',
      'Halcyon Industrial Exchange',
      'Standard',
      'active',
      'Net 30',
      'USD',
      'Pacific Trade Zone',
    ],
  ];
  for (const params of distributors)
    statements.push({
      sql: 'INSERT INTO distributors VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      params,
    });

  const users = [
    [
      PRIMARY_USER_ID,
      PRIMARY_CUSTOMER_ID,
      'Mara Venn',
      'mara.venn@calderpike.example',
      'account_admin',
      'active',
      '2021-01-04',
      '2026-09-02T08:42:00Z',
    ],
    [
      'USR-MCS-001',
      'WHS-1098',
      'Imani Kade',
      'imani.kade@meridiancivic.example',
      'account_admin',
      'active',
      '2021-02-15',
      '2026-08-29T13:05:00Z',
    ],
    [
      'USR-NPC-001',
      'WHS-2714',
      'Rowan Sato',
      'rowan.sato@northline.example',
      'account_admin',
      'active',
      '2021-03-08',
      '2026-08-31T16:20:00Z',
    ],
    [
      'USR-HIX-001',
      'WHS-5830',
      'Lena Orr',
      'lena.orr@halcyonexchange.example',
      'account_admin',
      'active',
      '2021-04-19',
      '2026-08-27T10:15:00Z',
    ],
  ];
  for (const params of users)
    statements.push({
      sql: 'INSERT INTO users VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      params,
    });

  const credentials = [
    [
      PRIMARY_USER_ID,
      '1lIuQK9XkwWkY0c0AE4ZXg',
      'RSZ-1tPotPr5bdAasAm06V-Qa4mC_m5Lj5khmqATtdE',
      210000,
      '2026-09-02T10:30:00Z',
    ],
    [
      'USR-MCS-001',
      'Wt9n8uox9Upi6cBE_ye-6g',
      'UrIMz0NH1Hhy8E5yDuElml5XW3z8E_KKnbvQmtG3AsM',
      210000,
      '2026-09-02T10:30:00Z',
    ],
    [
      'USR-NPC-001',
      'g8JLxlQzzW2g424PDxucig',
      'kQ99m_A5Z6uyu145H3Kq50iDLIaVskUN5KovMkapyZY',
      210000,
      '2026-09-02T10:30:00Z',
    ],
    [
      'USR-HIX-001',
      'gd8bi2Giq_dEaikXJ3kGaA',
      'Yehzp-jylkN6Zz74bgfGGr9on7GoyCeqV5ht6mVHilA',
      210000,
      '2026-09-02T10:30:00Z',
    ],
  ];
  for (const params of credentials)
    statements.push({
      sql: 'INSERT INTO user_credentials VALUES (?, ?, ?, ?, ?)',
      params,
    });

  for (const row of products) {
    statements.push({
      sql: `INSERT INTO products (
        item_number, product_name, category, fulfillment_type, unit_price_cents,
        unit_label, case_pack, lead_time_days, warranty_months, active_from, active_to, search_terms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        row.itemNumber,
        row.name,
        row.category,
        row.fulfillmentType,
        row.unitPriceCents,
        row.unitLabel,
        row.casePack,
        row.leadTimeDays,
        row.warrantyMonths,
        row.activeFrom,
        row.activeTo,
        row.searchTerms,
      ],
    });
  }

  const locations = [
    [
      'ATL-01',
      'Atlantic Stack Fulfillment Hub',
      'North Atlantic Trade District',
    ],
    ['GLK-02', 'Great Lakes Technical Depot', 'Great Lakes District'],
    ['PAC-03', 'Pacific Rim Bonded Yard', 'Pacific Trade Zone'],
  ];
  for (const params of locations)
    statements.push({
      sql: 'INSERT INTO fulfillment_locations VALUES (?, ?, ?)',
      params,
    });

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
      statements.push({
        sql: 'INSERT INTO inventory_balances VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        params: [
          row.itemNumber,
          locationIds[index],
          available + reserved + quarantined,
          reserved,
          quarantined,
          inbound,
          row.restockDate,
          `${AS_OF_DATE}T09:00:00Z`,
        ],
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

function insertOrder(statements: SeedStatement[], row: OrderSeed) {
  const plannedShippedOn = addDays(
    row.requestedShipDate,
    row.status === 'delivered' ? -2 : 0,
  );
  const shipmentTimeline = [
    'delivered',
    'shipped',
    'partially_shipped',
  ].includes(row.status)
    ? {
        // Early-year generated orders can be created on their requested ship date.
        shippedOn:
          plannedShippedOn < row.createdOn ? row.createdOn : plannedShippedOn,
        estimatedDeliveryDate: addDays(row.requestedShipDate, 5),
        deliveredOn:
          row.status === 'delivered' ? addDays(row.requestedShipDate, 4) : null,
      }
    : null;
  const statusDate =
    shipmentTimeline?.deliveredOn ??
    shipmentTimeline?.shippedOn ??
    row.requestedShipDate;
  const itemRows = row.items.map((item, index) => {
    const catalog = productById.get(item.itemNumber);
    if (!catalog) throw new Error(`Unknown seed product ${item.itemNumber}`);
    const quantities = quantitiesForStatus(
      row.status,
      item.quantity,
      catalog.casePack,
      index,
    );
    return {
      catalog,
      lineNumber: index + 1,
      quantity: item.quantity,
      ...quantities,
    };
  });
  const totalCents = itemRows.reduce(
    (total, item) => total + item.catalog.unitPriceCents * item.quantity,
    0,
  );
  statements.push({
    sql: `INSERT INTO orders (
      order_id, customer_id, placed_by_user_id, customer_po_number, created_on,
      requested_ship_date, status, currency, order_total_cents, shipping_region
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    params: [
      row.orderId,
      row.customerId,
      row.placedByUserId,
      row.customerPoNumber,
      row.createdOn,
      row.requestedShipDate,
      row.status,
      'USD',
      totalCents,
      row.shippingRegion,
    ],
  });
  for (const item of itemRows) {
    statements.push({
      sql: 'INSERT INTO order_items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      params: [
        row.orderId,
        item.lineNumber,
        item.catalog.itemNumber,
        item.catalog.name,
        item.catalog.unitPriceCents,
        item.quantity,
        item.allocated,
        item.shipped,
        item.cancelled,
      ],
    });
  }
  statements.push({
    sql: 'INSERT INTO order_events VALUES (?, ?, ?, ?, ?)',
    params: [
      `EVT-${row.orderId}-001`,
      row.orderId,
      `${row.createdOn}T14:00:00Z`,
      'order_created',
      `Purchase order ${row.customerPoNumber} entered the SABLE fulfillment network.`,
    ],
  });
  statements.push({
    sql: 'INSERT INTO order_events VALUES (?, ?, ?, ?, ?)',
    params: [
      `EVT-${row.orderId}-002`,
      row.orderId,
      `${statusDate}T09:00:00Z`,
      row.status,
      row.eventDescription ?? statusDescription(row.status),
    ],
  });

  if (shipmentTimeline) {
    const shipmentId = `SHP-${row.orderId.slice(4)}`;
    const shipmentStatus =
      row.status === 'delivered'
        ? 'delivered'
        : row.status === 'partially_shipped' &&
            row.orderId === 'SBL-2026-000417'
          ? 'delayed'
          : 'in_transit';
    statements.push({
      sql: 'INSERT INTO shipments VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      params: [
        shipmentId,
        row.orderId,
        shipmentStatus,
        'Astra Freight Systems',
        `AST-${row.orderId.replaceAll('-', '').slice(3)}`,
        shipmentTimeline.shippedOn,
        shipmentTimeline.estimatedDeliveryDate,
        shipmentTimeline.deliveredOn,
      ],
    });
    for (const item of itemRows.filter((candidate) => candidate.shipped > 0)) {
      statements.push({
        sql: 'INSERT INTO shipment_items VALUES (?, ?, ?, ?)',
        params: [shipmentId, row.orderId, item.lineNumber, item.shipped],
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
  if (status === 'partially_shipped') {
    const packs = Math.max(
      1,
      Math.floor(quantity / casePack / (lineIndex % 2 === 0 ? 2 : 1)),
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

function insertRepresentativeReturn(statements: SeedStatement[]) {
  statements.push({
    sql: 'INSERT INTO returns VALUES (?, ?, ?, ?, ?, ?, ?)',
    params: [
      'RTN-2022-000014',
      'SBL-2022-000118',
      'closed',
      'sealed_surplus',
      '2022-07-08',
      '2022-07-09',
      '2022-07-21',
    ],
  });
  statements.push({
    sql: 'INSERT INTO return_items VALUES (?, ?, ?, ?, ?)',
    params: ['RTN-2022-000014', 'SBL-2022-000118', 1, 12, 'restock'],
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

function addDays(value: string, days: number) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
