import '@shopify/ui-extensions/preact';
import {render} from 'preact';

/*
  705 BRBR order celebration (Thank you page block, placed at the top of the Main area).
  An animated confetti "HOORAY!" banner, then the order-on-the-way message and a 3-step tracker.
  The banner is customer-account-app/assets/brbr-hooray.svg, served from the public repo through jsDelivr.
*/

export const BANNER_URL =
  'https://cdn.jsdelivr.net/gh/alwyn-munatsi/nrs-shopify-sync@main/customer-account-app/assets/brbr-hooray.svg';

export const STEPS = [
  {emoji: '✅', title: 'Order confirmed', text: 'Payment received. You are all set!'},
  {emoji: '📦', title: 'Packing it up', text: 'Our team is getting your goodies ready.'},
  {emoji: '🚚', title: 'On the way', text: 'Heading to you. Tracking comes by email.'},
];

export default async () => {
  render(<Celebration />, document.body);
};

function Celebration() {
  const confirmation = shopify.orderConfirmation && shopify.orderConfirmation.value;
  const number = confirmation && confirmation.number;
  const firstOrder = confirmation && confirmation.isFirstOrder;

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
        <s-text>
          Woohoo! Your order is on the way 🚚💨 The 705 BRBR crew is packing it up right now, and we'll email you
          the moment it heads out the door.
        </s-text>
      </s-stack>

      <s-grid gridTemplateColumns="@container (inline-size > 420px) 1fr 1fr 1fr, 1fr" gap="small">
        {STEPS.map((step, i) => (
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
