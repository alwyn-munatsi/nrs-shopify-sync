import '@shopify/ui-extensions/preact';
import {render} from 'preact';
import {useEffect, useState} from 'preact/hooks';

/*
  705 BRBR welcome block for the customer account Orders page.
  Shows: store hours with a live "Open now" badge, quick-link tiles, popular products
  (best sellers from the store, with photo and price) and the in-store services.
*/

const STORE = 'https://705brbr.org';

const QUICK_LINKS = [
  {label: 'Shop all', note: '3,500+ products', icon: 'bag', href: `${STORE}/collections/all`},
  {label: 'Cold beer', note: 'IPAs, lagers & more', icon: 'star', href: `${STORE}/collections/all-beer`},
  {label: 'Snacks', note: 'Chips, candy & sweets', icon: 'cart', href: `${STORE}/collections/snacks`},
  {label: 'Order delivery', note: 'Get it delivered', icon: 'delivery', href: 'https://www.doordash.com/convenience/store/26214688/'},
  {label: 'NY Lottery', note: 'Results & scratch-offs', icon: 'gift-card', href: `${STORE}/pages/lottery`},
  {label: 'Visit us', note: '705 2nd Ave, Murray Hill', icon: 'location', href: 'https://maps.app.goo.gl/Rn9GY1jnfXuEgcM48'},
];

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
  render(<OrdersWelcome />, document.body);
};

function OrdersWelcome() {
  const [popular, setPopular] = useState(null);
  const open = isOpenNow();

  useEffect(() => {
    shopify
      .query(POPULAR_QUERY, {variables: {first: 20}})
      .then(({data}) => setPopular(pickPopular(data && data.products && data.products.nodes)))
      .catch(() => setPopular([]));
  }, []);

  return (
    <s-section accessibilityLabel="Welcome to 705 BRBR">
      <s-stack direction="block" gap="large-100">
        {/* Welcome row */}
        <s-grid gridTemplateColumns="@container (inline-size > 560px) 1fr auto, 1fr" alignItems="center" gap="base">
          <s-stack direction="block" gap="small-200">
            <s-heading>Your neighborhood market, ready when you are</s-heading>
            <s-text color="subdued">
              Cold beer, groceries, snacks and pet supplies on 2nd Ave. Order online for pickup, or get it delivered.
            </s-text>
            <s-stack direction="inline" gap="small-200">
              <s-badge tone={open ? 'auto' : 'neutral'} icon="clock">
                {open ? 'Open now' : 'Closed now'} · 6 AM – 12 AM daily
              </s-badge>
              <s-badge tone="neutral" icon="location">Murray Hill, NYC</s-badge>
            </s-stack>
          </s-stack>
          <s-button variant="primary" href={`${STORE}/collections/all`} target="_blank">
            Start shopping
          </s-button>
        </s-grid>

        {/* Quick links */}
        <s-grid
          gridTemplateColumns="@container (inline-size > 640px) 1fr 1fr 1fr, 1fr 1fr"
          gap="base"
        >
          {QUICK_LINKS.map((link) => (
            <s-clickable
              key={link.label}
              href={link.href}
              target="_blank"
              border="base"
              borderRadius="large"
              padding="base"
              background="subdued"
              accessibilityLabel={`${link.label}: ${link.note}`}
            >
              <s-stack direction="inline" gap="small-100" alignItems="center">
                <s-icon type={link.icon} />
                <s-stack direction="block" gap="none">
                  <s-text type="strong">{link.label}</s-text>
                  <s-text color="subdued">{link.note}</s-text>
                </s-stack>
              </s-stack>
            </s-clickable>
          ))}
        </s-grid>

        {/* Popular products */}
        {popular === null ? (
          <s-skeleton-paragraph />
        ) : popular.length > 0 ? (
          <s-stack direction="block" gap="base">
            <s-grid gridTemplateColumns="1fr auto" alignItems="center">
              <s-heading>Popular right now</s-heading>
              <s-link href={`${STORE}/collections/all`} target="_blank">
                See all
              </s-link>
            </s-grid>
            <s-grid
              gridTemplateColumns="@container (inline-size > 460px) 1fr 1fr 1fr, 1fr 1fr"
              gap="base"
            >
              {popular.map((p) => (
                <s-clickable
                  key={p.id}
                  href={`${STORE}/products/${p.handle}`}
                  target="_blank"
                  accessibilityLabel={`${p.title}, ${formatPrice(p.priceRange.minVariantPrice)}`}
                >
                  <s-stack direction="block" gap="small-200">
                    <s-box border="base" borderRadius="large" padding="small" background="base" maxBlockSize="180px">
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
          </s-stack>
        ) : null}

        {/* In-store services */}
        <s-stack direction="block" gap="small-200">
          <s-text type="strong">Also in store</s-text>
          <s-stack direction="inline" gap="small-200">
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
