import '@shopify/ui-extensions/preact';
import {render} from 'preact';
import {useEffect, useState} from 'preact/hooks';
import {STORE, reorderUrl, isOpenNow} from './api.js';

/*
  Block on each order's page in the customer account:
  - "Order these again": puts this order's items back in the 705brbr.org cart (the site's age check still applies)
  - Need help with this order? Call or email with the order number filled in
  - Pickup reminder: address, hours, photo ID for 21+ items
*/

export default async () => {
  render(<OrderHelp />, document.body);
};

const numId = (gid) => String(gid || '').split('/').pop();

function useSignal(sig) {
  const [v, setV] = useState(sig ? sig.value : undefined);
  useEffect(() => (sig && sig.subscribe ? sig.subscribe((x) => setV(x)) : undefined), [sig]);
  return v;
}

function OrderHelp() {
  const order = useSignal(shopify.order);
  const lines = useSignal(shopify.lines) || [];
  const name = (order && order.name) || '';
  const items = lines
    .map((l) => ({variantId: l.merchandise && /ProductVariant/.test(l.merchandise.id || '') ? numId(l.merchandise.id) : '', quantity: l.quantity}))
    .filter((i) => i.variantId);
  const open = isOpenNow();
  const subject = encodeURIComponent(`Question about my order ${name}`.trim());

  return (
    <s-section heading={name ? `Need anything with order ${name}?` : 'Need anything with this order?'}>
      <s-query-container>
        <s-stack direction="block" gap="base">
          <s-grid gridTemplateColumns="@container (inline-size > 520px) 1fr 1fr 1fr, 1fr" gap="base">
            {items.length > 0 && (
              <s-button variant="primary" href={reorderUrl(items)} target="_blank" inlineSize="fill">
                Order these again
              </s-button>
            )}
            <s-button href="tel:+19172658063" inlineSize="fill">
              Call (917) 265-8063
            </s-button>
            <s-button href={`mailto:705quickstop@gmail.com?subject=${subject}`} inlineSize="fill">
              Email us
            </s-button>
          </s-grid>

          <s-box padding="base" borderRadius="large" background="subdued">
            <s-stack direction="block" gap="small-200">
              <s-stack direction="inline" gap="small-200" alignItems="center">
                <s-badge tone={open ? 'auto' : 'neutral'} icon="clock">
                  {open ? 'Open now' : 'Closed now'} · 6:00am – 12:00am daily
                </s-badge>
              </s-stack>
              <s-text>
                Picking up? Come to 705 2nd Ave (between E 38th &amp; E 39th St). Please bring a photo ID if your order has beer,
                wine or other 21+ items.
              </s-text>
              <s-stack direction="inline" gap="base">
                <s-link href={`${STORE}/pages/visit-us`} target="_blank">
                  Get directions
                </s-link>
                <s-link href={`${STORE}/pages/order`} target="_blank">
                  Delivery options
                </s-link>
              </s-stack>
            </s-stack>
          </s-box>
        </s-stack>
      </s-query-container>
    </s-section>
  );
}
