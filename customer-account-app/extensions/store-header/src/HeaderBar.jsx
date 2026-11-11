import '@shopify/ui-extensions/preact';
import {render} from 'preact';

/*
  705 BRBR header bar under the Thank you page logo: Open now badge plus the same quick links as the
  website header (Shop, NY Lottery, Order delivery, Contact, phone).
*/

const STORE = 'https://705brbr.org';

export const LINKS = [
  ['Shop', `${STORE}/collections/all`],
  ['NY Lottery', `${STORE}/pages/lottery`],
  ['Order delivery', 'https://www.ubereats.com/store/705-brbr-705-2nd-avenue/8D1S_353X-G_0TRsvhGytw'],
  ['Contact', `${STORE}/pages/contact`],
];

export function isOpenNow(date = new Date()) {
  const hour = Number(
    new Intl.DateTimeFormat('en-US', {timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23'}).format(date),
  );
  return hour >= 6;
}

export default async () => {
  render(<HeaderBar />, document.body);
};

function HeaderBar() {
  const open = isOpenNow();
  const links = [...LINKS, ['(917) 265-8063', 'tel:9172658063']];
  // Plain text inside s-clickable takes the header's own (light) text colour, so it stays readable on the
  // dark header; s-link would use the purple accent, which is hard to read there.
  return (
    <s-stack direction="inline" gap="base" alignItems="center">
      <s-badge tone={open ? 'success' : 'neutral'}>{open ? 'Open now' : 'Closed now'} · 6 AM – 12 AM daily</s-badge>
      {links.map(([label, href]) => (
        <s-clickable key={label} href={href} target={href.startsWith('tel:') ? undefined : '_blank'}>
          <s-text type="strong">{label}</s-text>
        </s-clickable>
      ))}
    </s-stack>
  );
}
