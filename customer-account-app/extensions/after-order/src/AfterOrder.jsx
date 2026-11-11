import '@shopify/ui-extensions/preact';
import {render} from 'preact';

/*
  705 BRBR after-order block (Thank you page, below the Hooray celebration).
  1. "Review us on Google": opens the write-a-review box on the 705 BRBR Google listing. No reward is offered,
     because Google's policy bans incentivised reviews.
  2. "Get 10% off": invites shoppers who aren't signed in to join with email + mobile (homepage #welcome-offer form),
     which emails them the WELCOME10 code. Hidden when Shopify tells us the buyer is signed in to an account.
*/

export const GOOGLE_REVIEW_URL =
  'https://www.google.com/search?q=705+BRBR+Inc.+705+2nd+Ave+New+York#lrd=0x89c25904f40f28d9:0x52fdb5cffff0aeb,3,,,';
export const WELCOME_URL = 'https://705brbr.org/#welcome-offer';

/** True when the buyer is signed in to a customer account (if Shopify shares that with the app). */
export function isSignedIn(api) {
  try {
    const customer = api && api.buyerIdentity && api.buyerIdentity.customer && api.buyerIdentity.customer.value;
    return Boolean(customer && customer.id);
  } catch {
    return false;
  }
}

export default async () => {
  render(<AfterOrder />, document.body);
};

function AfterOrder() {
  const signedIn = isSignedIn(shopify);
  return (
    <s-grid gridTemplateColumns={signedIn ? '1fr' : '@container (inline-size > 480px) 1fr 1fr, 1fr'} gap="base">
      <s-box padding="base" borderRadius="large" border="base" background="subdued">
        <s-stack direction="block" gap="small-200">
          <s-text type="strong">⭐⭐⭐⭐⭐ Loved your order?</s-text>
          <s-text color="subdued">
            Tell your neighbors! A quick Google review helps a local shop like ours more than you know 💜
          </s-text>
          <s-button href={GOOGLE_REVIEW_URL} target="_blank" variant="secondary">
            Review us on Google
          </s-button>
        </s-stack>
      </s-box>

      {signedIn ? null : (
        <s-box padding="base" borderRadius="large" border="base">
          <s-stack direction="block" gap="small-200">
            <s-text type="strong">🎁 Get 10% off your next order</s-text>
            <s-text color="subdued">
              Haven't joined yet? Sign up with your email and mobile number and we'll email you a 10% off code.
            </s-text>
            <s-button href={WELCOME_URL} target="_blank" variant="primary">
              Get my 10% code
            </s-button>
          </s-stack>
        </s-box>
      )}
    </s-grid>
  );
}
