# Ordering

How the shop's charge-account checkout treats ship dates, order status,
uncertain results, and prices.

## Requested ship date

Dates are checked against the buyer's local date. The browser sends its time
zone with the order; without one, checkout uses the UTC date.

| Rule      | Allowed dates                                                                                                           |
| --------- | ----------------------------------------------------------------------------------------------------------------------- |
| Lead time | On or after local today plus the longest `lead_time_days` among the order's physical lines. Licenses have no lead time. |
| Horizon   | On or before the same date five years from local today.                                                                 |

Checkout rejects a date outside this window with a 422 and names the limit. The
shop's date field uses the same window for the current cart, and moves the date
forward when a longer lead time is added.

## Initial order status

| Requested ship date                 | Status      | History filter |
| ----------------------------------- | ----------- | -------------- |
| Up to 90 days after local today     | `confirmed` | Active         |
| More than 90 days after local today | `scheduled` | Scheduled      |

Ninety days is longer than every product lead time, and the seeded release
orders all ship four or more months after they were placed. Later status
changes belong to fulfillment.

## Uncertain checkout

If checkout cannot confirm its result, the cart and form stay locked and
**Retry this order** resends the same command, which returns the original
receipt if the order was placed. After a retry also fails:

- **Check order history** opens order history in a new tab, searched by the
  order's PO.
- **Start over** asks for confirmation, then unlocks the cart for a new
  command. Keeping the same PO is safe: a PO can be used once per distributor,
  so a duplicate of a placed order is rejected.

## Prices and currency

Product prices are stored in US dollar cents, and every seeded distributor bills
in USD. Charges record the distributor's currency code without conversion, so a
non-USD distributor would need converted prices first.
