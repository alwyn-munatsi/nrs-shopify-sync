import '@shopify/ui-extensions/preact';
import {render} from 'preact';
import {useEffect, useState} from 'preact/hooks';

/*
  705 BRBR block for the customer account Orders page (placed below Shopify's order list).
  Shows: popular products (best sellers with photo and price), then a store strip with a live
  "Open now" badge, the address and the in-store services.
  Quick links (Shop, NY Lottery, Order delivery, Visit us) live in the account side menu
  (Online Store > Navigation > Customer account main menu).
*/

const STORE = 'https://705brbr.org';

const SERVICES = ['NY Lottery', 'ATM', 'LuggageHero', 'Vinted Go', 'Amazon Hub'];

const POPULAR_QUERY = `query Popular($first: Int!) {
  products(first: $first, sortKey: BEST_SELLING) {
    nodes {
      id
      title
      handle
      availableForSale
      featuredImage { url altText }
      priceRange { minVariantPrice { amount currencyCode } }
    }
  }
}`;

/** Store hours: 6:00 AM to 12:00 AM (midnight), every day, New York time. */
export function isOpenNow(date = new Date()) {
  const hour = Number(
    new Intl.DateTimeFormat('en-US', {timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23'}).format(date),
  );
  return hour >= 6;
}

export function formatPrice({amount, currencyCode}) {
  try {
    return new Intl.NumberFormat('en-US', {style: 'currency', currency: currencyCode || 'USD'}).format(Number(amount));
  } catch {
    return `$${Number(amount).toFixed(2)}`;
  }
}

/** Keeps sellable products that have a photo and a real price, up to `limit`. */
export function pickPopular(nodes, limit = 6) {
  return (nodes || [])
    .filter(
      (p) =>
        p &&
        p.availableForSale &&
        p.featuredImage &&
        p.featuredImage.url &&
        Number(p.priceRange && p.priceRange.minVariantPrice && p.priceRange.minVariantPrice.amount) > 0,
    )
    .slice(0, limit);
}

export default async () => {
  render(<StoreBlock />, document.body);
};

function StoreBlock() {
  const [popular, setPopular] = useState(null);
  const open = isOpenNow();

  useEffect(() => {
    shopify
      .query(POPULAR_QUERY, {variables: {first: 20}})
      .then(({data}) => setPopular(pickPopular(data && data.products && data.products.nodes)))
      .catch(() => setPopular([]));
  }, []);

  return (
    <s-section accessibilityLabel="Popular at 705 BRBR">
      <s-stack direction="block" gap="large-100">
        {/* Popular products */}
        <s-stack direction="block" gap="base">
          <s-grid gridTemplateColumns="1fr auto" alignItems="end" gap="base">
            <s-stack direction="block" gap="small-300">
              <s-heading>Popular at 705 BRBR</s-heading>
              <s-text color="subdued">What the neighborhood is buying this week</s-text>
            </s-stack>
            <s-link href={`${STORE}/collections/all`} target="_blank">
              Shop all
            </s-link>
          </s-grid>

          {popular === null ? (
            <s-skeleton-paragraph />
          ) : popular.length > 0 ? (
            <s-grid gridTemplateColumns="1fr 1fr 1fr" gap="base">
              {popular.map((p) => (
                <s-clickable
                  key={p.id}
                  href={`${STORE}/products/${p.handle}`}
                  target="_blank"
                  accessibilityLabel={`${p.title}, ${formatPrice(p.priceRange.minVariantPrice)}`}
                >
                  <s-stack direction="block" gap="small-200">
                    <s-box border="base" borderRadius="large" padding="small" background="base">
                      <s-image
                        src={p.featuredImage.url}
                        alt={p.featuredImage.altText || p.title}
                        aspectRatio="1/1"
                        objectFit="contain"
                        inlineSize="fill"
                        loading="lazy"
                      />
                    </s-box>
                    <s-text type="strong">{formatPrice(p.priceRange.minVariantPrice)}</s-text>
                    <s-text color="subdued">{p.title}</s-text>
                  </s-stack>
                </s-clickable>
              ))}
            </s-grid>
          ) : (
            <s-button href={`${STORE}/collections/all`} target="_blank">
              Browse the store
            </s-button>
          )}
        </s-stack>

        <s-divider />

        {/* Store strip */}
        <s-stack direction="block" gap="small-200">
          <s-stack direction="inline" gap="small-200" alignItems="center">
            <s-badge tone={open ? 'auto' : 'neutral'} icon="clock">
              {open ? 'Open now' : 'Closed now'} · 6 AM – 12 AM daily
            </s-badge>
            <s-badge tone="neutral" icon="location">705 2nd Ave, Murray Hill</s-badge>
          </s-stack>
          <s-stack direction="inline" gap="small-200" alignItems="center">
            <s-text color="subdued">Also in store:</s-text>
            {SERVICES.map((name) => (
              <s-badge key={name} tone="neutral">
                {name}
              </s-badge>
            ))}
          </s-stack>
        </s-stack>
      </s-stack>
    </s-section>
  );
}
