import '@shopify/ui-extensions/preact';
import {render} from 'preact';

/*
  705 BRBR order celebration (Thank you page block, placed at the top of the Main area).
  An animated confetti "HOORAY!" banner, then a message and a 3-step tracker that match how the order is
  fulfilled: picked up at the store, or shipped / delivered ("on the way").
  The banner is customer-account-app/assets/brbr-hooray.svg, served from the public repo through jsDelivr.
*/

export const BANNER_URL =
  'https://cdn.jsdelivr.net/gh/alwyn-munatsi/nrs-shopify-sync@main/customer-account-app/assets/brbr-hooray.svg';

export const STORE_ADDRESS = '705 2nd Ave (between E 38th & E 39th St)';

export const COPY = {
  delivery: {
    message:
      "Woohoo! Your order is on the way 🚚💨 The 705 BRBR crew is packing it up right now, and we'll email you the moment it heads out the door.",
    steps: [
      {emoji: '✅', title: 'Order confirmed', text: 'Payment received. You are all set!'},
      {emoji: '📦', title: 'Packing it up', text: 'Our team is getting your goodies ready.'},
      {emoji: '🚚', title: 'On the way', text: 'Heading to you. Tracking comes by email.'},
    ],
  },
  pickup: {
    message: `Woohoo! Your order is being packed for pickup 🛍️✨ We'll email you as soon as it's ready to grab at ${STORE_ADDRESS}. We're open 6 AM – 12 AM every day.`,
    steps: [
      {emoji: '✅', title: 'Order confirmed', text: 'Payment received. You are all set!'},
      {emoji: '📦', title: 'Packing it up', text: 'Our team is getting your goodies ready.'},
      {emoji: '🏪', title: 'Ready for pickup', text: 'Watch for our email, then come on by. Bring a photo ID for beer 🍺'},
    ],
  },
};

/**
 * 'pickup' when every delivery group the buyer chose is a store pickup, otherwise 'delivery'.
 * Falls back to 'delivery' when delivery details aren't available.
 */
export function fulfillmentMode(groups) {
  const selected = (groups || [])
    .map((group) => {
      const ref = group && group.selectedDeliveryOption;
      if (!ref) return null;
      return (group.deliveryOptions || []).find((option) => option.handle === ref.handle) || null;
    })
    .filter(Boolean);
  if (selected.length > 0 && selected.every((option) => option.type === 'pickup')) return 'pickup';
  return 'delivery';
}

export default async () => {
  render(<Celebration />, document.body);
};

function Celebration() {
  const confirmation = shopify.orderConfirmation && shopify.orderConfirmation.value;
  const number = confirmation && confirmation.number;
  const firstOrder = confirmation && confirmation.isFirstOrder;
  const groups = shopify.deliveryGroups && shopify.deliveryGroups.value;
  const copy = COPY[fulfillmentMode(groups)];

  return (
    <s-stack direction="block" gap="base">
      <s-image
        src={BANNER_URL}
        alt="Hooray! Confetti celebrating your 705 BRBR order"
        aspectRatio="2.857"
        objectFit="cover"
        inlineSize="fill"
        borderRadius="large"
      />

      <s-stack direction="block" gap="small-200">
        <s-heading>🎉 Hooray! Your order has been processed 🥳</s-heading>
        <s-text>{copy.message}</s-text>
      </s-stack>

      <s-grid gridTemplateColumns="@container (inline-size > 420px) 1fr 1fr 1fr, 1fr" gap="small">
        {copy.steps.map((step, i) => (
          <s-box
            key={step.title}
            padding="base"
            borderRadius="large"
            border="base"
            background={i === 0 ? 'subdued' : 'base'}
          >
            <s-stack direction="block" gap="small-300">
              <s-text type="strong">
                {step.emoji} {step.title}
              </s-text>
              <s-text color="subdued">{step.text}</s-text>
            </s-stack>
          </s-box>
        ))}
      </s-grid>

      <s-stack direction="inline" gap="small-200" alignItems="center">
        {number ? <s-badge tone="success">Confirmation #{number}</s-badge> : null}
        {firstOrder ? <s-badge tone="neutral">🥳 First order. Welcome to the family!</s-badge> : null}
      </s-stack>

      <s-text color="subdued">
        Thanks for shopping local 💜 Questions? Call us at (917) 265-8063 or stop by 705 2nd Ave.
      </s-text>
    </s-stack>
  );
}
