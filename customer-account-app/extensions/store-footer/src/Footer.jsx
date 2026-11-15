import '@shopify/ui-extensions/preact';
import {render} from 'preact';

/*
  705 BRBR store footer, laid out like the website footer:
  [ 705 BRBR Inc. + address/phone/email ] [ STORE HOURS box + FOLLOW & CONNECT buttons ] [ STORE LOCATION + map buttons ]
  then a bottom row with the copyright and shop links.
  Shows on every customer account page (Orders, Order status, Profile, My 705) and on the Thank you page.
  (Account pages can't use custom background colors, so it uses Shopify's light "subdued" panel instead of the
  site's dark navy.)
*/

export const STORE = 'https://705brbr.org';

export const SOCIALS = [
  ['X', 'https://x.com/705BRBRInc'],
  ['TikTok', 'https://www.tiktok.com/@705.brbr.inc'],
  ['YouTube', 'https://www.youtube.com/@705BRBRInc'],
  ['Instagram', 'https://instagram.com/705brbr'],
  ['Facebook', 'https://facebook.com/705BRBRInc'],
  ['LinkedIn', 'https://www.linkedin.com/company/705brbr/'],
  ['Pinterest', 'https://www.pinterest.com/705BRBR/'],
  ['Yelp', 'https://www.yelp.com/biz/705-brbr-new-york-3'],
];

export const SHOP_LINKS = [
  ['Shop all products', `${STORE}/collections/all`],
  ['NY Lottery', `${STORE}/pages/lottery`],
  ['Order delivery', `${STORE}/pages/order`],
  ['Visit us', `${STORE}/pages/visit-us`],
  ['Contact us', `${STORE}/#contact`],
];

const GOOGLE_MAPS = 'https://maps.app.goo.gl/Rn9GY1jnfXuEgcM48';
const APPLE_MAPS = 'https://maps.apple.com/?address=705+2nd+Ave,+New+York,+NY+10016&q=705+BRBR';

/** Store hours: 6:00 AM to 12:00 AM (midnight), every day, New York time. */
export function isOpenNow(date = new Date()) {
  const hour = Number(
    new Intl.DateTimeFormat('en-US', {timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23'}).format(date),
  );
  return hour >= 6;
}

export default async () => {
  render(<StoreFooter />, document.body);
};

function Label({children}) {
  return <s-text type="strong">{children}</s-text>;
}

function StoreFooter() {
  const open = isOpenNow();
  return (
    <s-query-container>
      <s-box background="subdued" borderRadius="large" padding="@container (inline-size > 560px) large-200, base">
        <s-stack direction="block" gap="large">
          <s-grid gridTemplateColumns="@container (inline-size > 640px) 1.2fr 1.3fr 1fr, 1fr" gap="large">
            {/* Brand + contact */}
            <s-stack direction="block" gap="small-200">
              <s-heading>705 BRBR Inc.</s-heading>
              <s-text color="subdued">Beer • Groceries • Pet supplies</s-text>
              <s-stack direction="inline" gap="small-200" alignItems="center">
                <s-icon type="location" size="small" />
                <s-text>705 2nd Ave (Between E 38th &amp; E 39th St), New York, NY 10016</s-text>
              </s-stack>
              <s-stack direction="inline" gap="small-200" alignItems="center">
                <s-icon type="mobile" size="small" />
                <s-link href="tel:+19172658063">(917) 265-8063</s-link>
              </s-stack>
              <s-stack direction="inline" gap="small-200" alignItems="center">
                <s-icon type="email" size="small" />
                <s-link href="mailto:705quickstop@gmail.com">705quickstop@gmail.com</s-link>
              </s-stack>
            </s-stack>

            {/* Hours + socials */}
            <s-stack direction="block" gap="base">
              <s-stack direction="block" gap="small-200">
                <Label>STORE HOURS</Label>
                <s-box background="base" border="base" borderRadius="base" padding="small-100">
                  <s-grid gridTemplateColumns="1fr auto" alignItems="center" gap="base">
                    <s-text type="strong">Every Day</s-text>
                    <s-text>6:00 AM – 12:00 AM (Next Day)</s-text>
                  </s-grid>
                </s-box>
                <s-stack direction="inline">
                  <s-badge tone={open ? 'auto' : 'neutral'} icon="clock">
                    {open ? 'Open now' : 'Closed now · pre-order online'}
                  </s-badge>
                </s-stack>
              </s-stack>
              <s-stack direction="block" gap="small-200">
                <Label>FOLLOW &amp; CONNECT</Label>
                <s-stack direction="inline" gap="small-200">
                  {SOCIALS.map(([label, href]) => (
                    <s-button key={label} variant="secondary" href={href} target="_blank">
                      {label}
                    </s-button>
                  ))}
                </s-stack>
              </s-stack>
            </s-stack>

            {/* Location */}
            <s-stack direction="block" gap="small-200">
              <Label>STORE LOCATION</Label>
              <s-text color="subdued">Midtown East · Murray Hill</s-text>
              <s-button variant="primary" href={GOOGLE_MAPS} target="_blank" inlineSize="fill">
                Google Maps
              </s-button>
              <s-button variant="secondary" href={APPLE_MAPS} target="_blank" inlineSize="fill">
                Apple Maps
              </s-button>
              <s-link href={`${STORE}/pages/visit-us`} target="_blank">
                More directions
              </s-link>
            </s-stack>
          </s-grid>

          <s-divider />

          {/* Bottom row */}
          <s-grid gridTemplateColumns="@container (inline-size > 640px) 1fr auto, 1fr" alignItems="center" gap="base">
            <s-text color="subdued">© {new Date().getFullYear()} 705 BRBR Inc. All rights reserved.</s-text>
            <s-stack direction="inline" gap="base">
              {SHOP_LINKS.map(([label, href]) => (
                <s-link key={label} href={href} target="_blank">
                  {label}
                </s-link>
              ))}
            </s-stack>
          </s-grid>
        </s-stack>
      </s-box>
    </s-query-container>
  );
}
