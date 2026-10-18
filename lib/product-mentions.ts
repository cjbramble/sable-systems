import type {
  ProductMention,
  QuantityOccurrence,
} from './support-quantities.ts';
import { itemReferences } from './support-references.ts';

// The catalog fields that let a message name a product.
export type ProductTerms = {
  item_number: string;
  product_name: string;
  unit_label: string;
  search_terms: string;
};

function termMentions(
  message: string,
  itemNumber: string,
  term: string,
  wholeToken = false,
): ProductMention[] {
  const mentions: ProductMention[] = [];
  let start = message.indexOf(term);
  while (start !== -1) {
    const end = start + term.length;
    if (
      !wholeToken ||
      (!/[\w-]/.test(message[start - 1] ?? '') &&
        !/[\w-]/.test(message[end] ?? ''))
    )
      mentions.push({ itemNumber, start, end });
    start = message.indexOf(term, end);
  }
  return mentions;
}

function terms(product: ProductTerms) {
  return product.search_terms.split(',').map((term) => term.trim());
}

// Short terms are model codes ("r2", "m14") and can be shared between
// products, so they name nothing. A short plain word ("hub", "kit") that only
// one product uses is as specific as a long alias.
function usableTerms(products: readonly ProductTerms[]) {
  const owners = new Map<string, Set<string>>();
  for (const product of products)
    for (const term of [product.unit_label, ...terms(product)]) {
      const key = term.trim().toLowerCase();
      owners.set(key, (owners.get(key) ?? new Set()).add(product.item_number));
    }
  return (term: string) =>
    term.length >= 4 ||
    (/^[a-z]{3}$/i.test(term) && owners.get(term.toLowerCase())?.size === 1);
}

// Finds products a lowercase message names by item number, full name, or
// alias. Full names and item numbers outrank aliases; within each tier the
// products keep their input order.
export function findProductMentions<Product extends ProductTerms>(
  message: string,
  products: readonly Product[],
  quantities: QuantityOccurrence[] = [],
) {
  const explicitProducts: Product[] = [];
  const references = new Set(itemReferences(message));
  const mentions: ProductMention[] = [];
  const usable = usableTerms(products);
  for (const product of products) {
    const itemNumber = product.item_number.toLowerCase();
    const productName = product.product_name.toLowerCase();
    if (references.has(product.item_number) || message.includes(productName)) {
      explicitProducts.push(product);
      const exact = [
        ...termMentions(message, product.item_number, itemNumber, true),
        ...termMentions(message, product.item_number, productName),
      ];
      // "SBL-CSR-R2 controller" describes the explicit product; its trailing
      // noun must not become another product through the generic alias tier.
      const descriptors = [
        product.unit_label,
        `${product.unit_label}s`,
        ...terms(product),
      ]
        .map((term) => term.trim())
        .filter(usable)
        .flatMap((term) =>
          termMentions(message, product.item_number, term, true),
        )
        .filter((descriptor) =>
          exact.some(
            (mention) =>
              (descriptor.start >= mention.end &&
                /^\s+$/.test(message.slice(mention.end, descriptor.start))) ||
              (descriptor.end <= mention.start &&
                /^\s+$/.test(message.slice(descriptor.end, mention.start))),
          ),
        );
      mentions.push(...exact, ...descriptors);
    }
  }
  for (const reference of references)
    if (!products.some((product) => product.item_number === reference))
      mentions.push(
        ...termMentions(message, reference, reference.toLowerCase(), true),
      );
  // Mask exact references without shifting the source positions. A word in a
  // full product name must not also identify another product through an alias.
  const keywordCharacters = message.split('');
  for (const { start, end } of mentions)
    keywordCharacters.fill(' ', start, end);
  const keywordMessage = keywordCharacters.join('');
  // The final word of a parsed quantity is usually its unit, not a product
  // alias: "20 licenses of SBL-RLY-1Y" must not also select Palisade via
  // "license". When nothing else names a product, the unit word is the
  // product: "8 hubs", "5 cables".
  const units = quantities.flatMap(({ start, end }) => {
    const unit = message.slice(start, end).match(/[a-z]+$/i)?.[0];
    return unit ? [{ start: end - unit.length, end }] : [];
  });
  const inUnit = (mention: ProductMention) =>
    units.some((unit) => mention.start < unit.end && mention.end > unit.start);
  // Check aliases after collecting all explicit references, regardless of row
  // order. Separately mentioned aliases remain available for mixed comparisons.
  const aliasMentions = products.flatMap((product) =>
    terms(product)
      .filter(usable)
      // Whole words only, with a plural: "applicable" must not match "cable".
      .flatMap((term) => [
        ...termMentions(keywordMessage, product.item_number, term, true),
        ...termMentions(keywordMessage, product.item_number, `${term}s`, true),
      ]),
  );
  const named =
    mentions.length > 0 || aliasMentions.some((mention) => !inUnit(mention));
  const keywordMentions = named
    ? aliasMentions.filter((mention) => !inUnit(mention))
    : aliasMentions;
  mentions.push(...keywordMentions);
  const keywordProducts = products.filter(
    (product) =>
      !explicitProducts.includes(product) &&
      keywordMentions.some(
        (mention) => mention.itemNumber === product.item_number,
      ),
  );
  return { explicitProducts, keywordProducts, mentions };
}
