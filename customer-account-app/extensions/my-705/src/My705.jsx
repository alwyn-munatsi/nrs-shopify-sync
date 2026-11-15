import '@shopify/ui-extensions/preact';
import {render} from 'preact';
import {useEffect, useState} from 'preact/hooks';
import {api, STORE, ACCOUNT, money, prettyDate, isOpenNow, reorderUrl} from './api.js';

/*
  "My 705": a home page inside the customer account.
  - Hello + member since / orders
  - Welcome offer (10% off the first order) and age verification status
  - Order again: the customer's most-bought items (adds to the 705brbr.org cart)
  - Recent orders with status, View and Order again
  - Shortcuts: shop, order options, visit us, NY Lottery, call, email
  Data comes from the 705 BRBR Worker (/account/me), authenticated with Shopify's session token.
*/

export default async () => {
  render(<My705 />, document.body);
};

function statusBadge(o) {
  if (o.cancelled) return {tone: 'critical', text: 'Cancelled'};
  const f = String(o.fulfillment || '').toUpperCase();
  if (f === 'FULFILLED') return {tone: 'auto', text: 'Completed'};
  if (f === 'PARTIALLY_FULFILLED') return {tone: 'neutral', text: 'Partly ready'};
  if (f === 'IN_PROGRESS' || f === 'SCHEDULED' || f === 'OPEN') return {tone: 'neutral', text: 'Being prepared'};
  if (f === 'ON_HOLD') return {tone: 'neutral', text: 'On hold'};
  return {tone: 'neutral', text: 'Received'};
}

const SHORTCUTS = [
  {label: 'Shop all products', href: `${STORE}/collections/all`, icon: 'bag'},
  {label: 'Order delivery', href: `${STORE}/pages/order`, icon: 'delivery'},
  {label: 'Visit us', href: `${STORE}/pages/visit-us`, icon: 'location'},
  {label: 'NY Lottery', href: `${STORE}/pages/lottery`, icon: 'gift'},
  {label: 'Call (917) 265-8063', href: 'tel:+19172658063', icon: 'mobile'},
  {label: 'Email us', href: 'mailto:705quickstop@gmail.com?subject=Question%20about%20my%20705%20BRBR%20account', icon: 'email'},
];

function My705() {
  const [me, setMe] = useState(null);
  const [error, setError] = useState('');
  const open = isOpenNow();

  useEffect(() => {
    api('/account/me')
      .then(setMe)
      .catch((e) => setError(e.status === 503 ? 'Your 705 dashboard is almost ready. Please check back soon.' : "We couldn't load your account right now. Please refresh the page."));
  }, []);

  const heading = me && me.firstName ? `Hi, ${me.firstName}!` : 'My 705';

  return (
    <s-page heading={heading} subheading="Your 705 BRBR home: offers, favorites and recent orders">
      {error ? (
        <s-banner tone="info">{error}</s-banner>
      ) : !me ? (
        <s-section>
          <s-skeleton-paragraph />
        </s-section>
      ) : (
        <s-query-container>
        <s-stack direction="block" gap="base">
          {/* Store status */}
          <s-stack direction="inline" gap="small-200" alignItems="center">
            <s-badge tone={open ? 'auto' : 'neutral'} icon="clock">
              {open ? 'Open now' : 'Closed now (pre-order online)'} · 6:00am – 12:00am daily
            </s-badge>
            <s-badge tone="neutral" icon="location">705 2nd Ave, Midtown East</s-badge>
            {me.memberSince && <s-badge tone="neutral">Member since {prettyDate(me.memberSince, true)}</s-badge>}
          </s-stack>

          {/* Offer + age */}
          <s-grid gridTemplateColumns="@container (inline-size > 560px) 1fr 1fr, 1fr" gap="base">
            <s-section heading={me.welcomeOffer.available ? 'Your 10% welcome offer' : 'Thanks for shopping with us'}>
              <s-stack direction="block" gap="small-200">
                {me.welcomeOffer.available ? (
                  <>
                    <s-text>
                      Take 10% off your first order. It's applied automatically at checkout while you're signed in.
                    </s-text>
                    <s-badge icon="discount-code">{me.welcomeOffer.code}</s-badge>
                    <s-stack direction="inline">
                      <s-button variant="primary" href={`${STORE}/collections/all`} target="_blank">
                        Start shopping
                      </s-button>
                    </s-stack>
                  </>
                ) : (
                  <>
                    <s-text>
                      {me.ordersCount} {me.ordersCount === 1 ? 'order' : 'orders'} so far · {money(me.amountSpent)} spent
                    </s-text>
                    <s-text color="subdued">Your favorites are below, ready to order again.</s-text>
                  </>
                )}
              </s-stack>
            </s-section>

            <s-section heading="Age verification">
              <s-stack direction="block" gap="small-200">
                {me.ageVerified ? (
                  <>
                    <s-badge icon="check-circle">Age verified (21+)</s-badge>
                    <s-text>No age check when you buy 21+ items while signed in. Bring photo ID for pickup or delivery.</s-text>
                  </>
                ) : (
                  <>
                    <s-badge tone="neutral">Not verified yet</s-badge>
                    <s-text>Verify once to skip the date-of-birth check on beer, wine and other 21+ items.</s-text>
                    <s-stack direction="inline">
                      <s-button href={`${ACCOUNT}/profile`}>Verify on my profile</s-button>
                    </s-stack>
                  </>
                )}
              </s-stack>
            </s-section>
          </s-grid>

          {/* Order again */}
          {me.favorites.length > 0 && (
            <s-section heading="Order again">
              <s-stack direction="block" gap="base">
                <s-grid gridTemplateColumns="@container (inline-size > 560px) 1fr 1fr 1fr 1fr, 1fr 1fr" gap="base">
                  {me.favorites.slice(0, 8).map((f) => (
                    <s-stack key={f.variantId} direction="block" gap="small-200">
                      <s-clickable href={`${STORE}/products/${f.handle}`} target="_blank" accessibilityLabel={f.title}>
                        <s-box border="base" borderRadius="large" padding="small" background="base">
                          {f.image ? (
                            <s-image src={f.image} alt={f.title} aspectRatio="1/1" objectFit="contain" inlineSize="fill" loading="lazy" />
                          ) : (
                            <s-text color="subdued">{f.title}</s-text>
                          )}
                        </s-box>
                      </s-clickable>
                      <s-text type="strong">{money({amount: f.price, currencyCode: 'USD'})}</s-text>
                      <s-text color="subdued">{f.title}</s-text>
                      <s-button href={reorderUrl([{variantId: f.variantId, quantity: 1}])} target="_blank" inlineSize="fill">
                        Add to cart
                      </s-button>
                    </s-stack>
                  ))}
                </s-grid>
                <s-stack direction="inline">
                  <s-link href={reorderUrl(me.favorites.map((f) => ({variantId: f.variantId, quantity: 1})))} target="_blank">
                    Add all favorites to cart
                  </s-link>
                </s-stack>
              </s-stack>
            </s-section>
          )}

          {/* Recent orders */}
          <s-section heading="Recent orders">
            {me.orders.length === 0 ? (
              <s-stack direction="block" gap="small-200">
                <s-text color="subdued">No orders yet. Your orders will show up here with their status.</s-text>
                <s-stack direction="inline">
                  <s-button href={`${STORE}/collections/all`} target="_blank">
                    Browse the store
                  </s-button>
                </s-stack>
              </s-stack>
            ) : (
              <s-stack direction="block" gap="base">
                {me.orders.map((o, i) => {
                  const b = statusBadge(o);
                  const again = o.items.filter((it) => it.available);
                  return (
                    <s-stack key={o.id} direction="block" gap="small-200">
                      {i > 0 && <s-divider />}
                      <s-grid gridTemplateColumns="@container (inline-size > 480px) 1fr auto, 1fr" alignItems="center" gap="base">
                        <s-stack direction="block" gap="small-300">
                          <s-stack direction="inline" gap="small-200" alignItems="center">
                            <s-text type="strong">Order {o.name}</s-text>
                            <s-badge tone={b.tone}>{b.text}</s-badge>
                          </s-stack>
                          <s-text color="subdued">
                            {prettyDate(o.createdAt)} · {money(o.total)} · {o.items.reduce((n, it) => n + (it.quantity || 0), 0)} items
                            {o.method ? ` · ${o.method}` : ''}
                          </s-text>
                        </s-stack>
                        <s-stack direction="inline" gap="small-200">
                          <s-button variant="secondary" href={`${ACCOUNT}/orders/${o.id}`}>
                            View
                          </s-button>
                          {again.length > 0 && !o.cancelled && (
                            <s-button href={reorderUrl(again)} target="_blank">
                              Order again
                            </s-button>
                          )}
                        </s-stack>
                      </s-grid>
                    </s-stack>
                  );
                })}
                <s-link href={`${ACCOUNT}/orders`}>See all orders</s-link>
              </s-stack>
            )}
          </s-section>

          {/* Shortcuts */}
          <s-section heading="Shortcuts">
            <s-grid gridTemplateColumns="@container (inline-size > 560px) 1fr 1fr 1fr, 1fr 1fr" gap="base">
              {SHORTCUTS.map((s) => (
                <s-clickable key={s.label} href={s.href} target={s.href.startsWith('http') ? '_blank' : undefined} border="base" borderRadius="large" padding="base">
                  <s-stack direction="inline" gap="small-200" alignItems="center">
                    <s-icon type={s.icon} />
                    <s-text type="strong">{s.label}</s-text>
                  </s-stack>
                </s-clickable>
              ))}
            </s-grid>
          </s-section>
        </s-stack>
        </s-query-container>
      )}
    </s-page>
  );
}
