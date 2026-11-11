import '@shopify/ui-extensions/preact';
import {render} from 'preact';

/*
  705 BRBR store footer, matching the website footer.
  Shows on every customer account page (Orders, Order status, Profile, Settings) and on the Thank you page.
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
  ['Order delivery', 'https://www.ubereats.com/store/705-brbr-705-2nd-avenue/8D1S_353X-G_0TRsvhGytw'],
  ['Contact us', `${STORE}/pages/contact`],
];

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

function Column({title, children}) {
  return (
    <s-stack direction="block" gap="small-200">
      <s-text type="strong">{title}</s-text>
      {children}
    </s-stack>
  );
}

function StoreFooter() {
  const open = isOpenNow();
  return (
    <s-stack direction="block" gap="base">
      <s-divider />

      <s-grid gridTemplateColumns="@container (inline-size > 560px) 1.4fr 1fr 1fr, 1fr" gap="large">
        <s-stack direction="block" gap="small-200">
          <s-heading>705 BRBR Inc.</s-heading>
          <s-text color="subdued">Beer • Groceries • Pet supplies</s-text>
          <s-text>705 2nd Ave (Between E 38th & E 39th St), New York, NY 10016</s-text>
          <s-link href="tel:9172658063">(917) 265-8063</s-link>
          <s-link href="mailto:705quickstop@gmail.com">705quickstop@gmail.com</s-link>
        </s-stack>

        <Column title="Store hours">
          <s-stack direction="inline" gap="small-200" alignItems="center">
            <s-badge tone={open ? 'success' : 'neutral'}>{open ? 'Open now' : 'Closed now'}</s-badge>
          </s-stack>
          <s-text color="subdued">Every day, 6:00 AM – 12:00 AM (next day)</s-text>
          <s-stack direction="inline" gap="base">
            <s-link href="https://maps.app.goo.gl/Rn9GY1jnfXuEgcM48" target="_blank">Google Maps</s-link>
            <s-link href="https://maps.apple.com/?address=705+2nd+Ave,+New+York,+NY+10016&q=705+BRBR" target="_blank">
              Apple Maps
            </s-link>
          </s-stack>
        </Column>

        <Column title="Shop">
          {SHOP_LINKS.map(([label, href]) => (
            <s-link key={label} href={href} target="_blank">
              {label}
            </s-link>
          ))}
        </Column>
      </s-grid>

      <s-stack direction="block" gap="small-200">
        <s-text type="strong">Follow & connect</s-text>
        <s-stack direction="inline" gap="base">
          {SOCIALS.map(([label, href]) => (
            <s-link key={label} href={href} target="_blank">
              {label}
            </s-link>
          ))}
        </s-stack>
      </s-stack>

      <s-text color="subdued">© {new Date().getFullYear()} 705 BRBR Inc. All rights reserved.</s-text>
    </s-stack>
  );
}
