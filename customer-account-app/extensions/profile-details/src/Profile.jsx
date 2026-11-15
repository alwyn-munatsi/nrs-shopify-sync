import '@shopify/ui-extensions/preact';
import {render} from 'preact';
import {useEffect, useState} from 'preact/hooks';
import {api, prettyPhone, prettyDate} from './api.js';

/*
  "Your 705 details" on the customer account Profile page.
  - Mobile number (Shopify's own profile has no phone field)
  - Gender
  - Date of birth + "Age verified (21+)": once verified, the website's age check is skipped for this account on
    every device. The date has to match the one given at sign-up; if none is on file it can be added once.
  Data is read and saved through the 705 BRBR Worker (/account/*), authenticated with Shopify's session token.
*/

const GENDERS = ['Female', 'Male', 'Non-binary', 'Prefer not to say'];

export default async () => {
  render(<Details />, document.body);
};

function Details() {
  const [me, setMe] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [phone, setPhone] = useState('');
  const [gender, setGender] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState(null); // {tone, text}
  const [phoneError, setPhoneError] = useState('');

  const [dob, setDob] = useState('');
  const [dobError, setDobError] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [ageMsg, setAgeMsg] = useState(null);

  function apply(data) {
    setMe(data);
    setPhone(prettyPhone(data.phone));
    setGender(data.gender || '');
  }

  useEffect(() => {
    api('/account/me')
      .then(apply)
      .catch((e) => setLoadError(e.status === 503 ? 'Your 705 details will appear here soon.' : "We couldn't load your details right now. Please refresh the page."));
  }, []);

  async function save() {
    setSaveMsg(null);
    setPhoneError('');
    const body = {};
    const digits = phone.replace(/\D/g, '');
    if (digits !== String(me.phone || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '')) body.phone = digits ? phone : '';
    if (gender && gender !== me.gender) body.gender = gender;
    if (!Object.keys(body).length) {
      setSaveMsg({tone: 'info', text: 'Nothing to change.'});
      return;
    }
    setSaving(true);
    try {
      apply(await api('/account/update', body));
      setSaveMsg({tone: 'success', text: 'Saved. Thanks for keeping your details up to date.'});
    } catch (e) {
      if (e.data && e.data.field === 'phone') setPhoneError(e.message);
      else setSaveMsg({tone: 'critical', text: e.message});
    } finally {
      setSaving(false);
    }
  }

  async function verify() {
    setAgeMsg(null);
    setDobError('');
    if (!dob) {
      setDobError('Please enter your date of birth.');
      return;
    }
    setVerifying(true);
    try {
      const data = await api('/account/verify-age', {dob});
      apply(data);
      setDob('');
      setAgeMsg(
        data.status === 'verified'
          ? {tone: 'success', text: "You're verified. You won't be asked to confirm your age again while signed in."}
          : {tone: 'warning', text: "Thanks. Your date of birth is saved. 21+ items can be bought once you're 21."},
      );
    } catch (e) {
      if (e.data && e.data.status === 'mismatch') {
        const left = e.data.triesLeft;
        setDobError(`${e.message} Please check it and try again.${left != null ? ` (${left} ${left === 1 ? 'try' : 'tries'} left)` : ''}`);
      } else if (e.data && e.data.field === 'dob') setDobError(e.message);
      else setAgeMsg({tone: 'critical', text: e.message});
    } finally {
      setVerifying(false);
    }
  }

  if (loadError) {
    return (
      <s-section heading="Your 705 details">
        <s-text color="subdued">{loadError}</s-text>
      </s-section>
    );
  }
  if (!me) {
    return (
      <s-section heading="Your 705 details">
        <s-skeleton-paragraph />
      </s-section>
    );
  }

  return (
    <s-section heading="Your 705 details">
      <s-query-container>
      <s-stack direction="block" gap="large-100">
        {/* Contact + about you */}
        <s-stack direction="block" gap="base">
          <s-grid gridTemplateColumns="@container (inline-size > 480px) 1fr 1fr, 1fr" gap="base">
            <s-phone-field
              label="Mobile number"
              autocomplete="tel"
              value={phone}
              error={phoneError}
              onInput={(e) => setPhone(e.currentTarget.value)}
            />
            <s-select label="Gender" value={gender} onChange={(e) => setGender(e.currentTarget.value)}>
              <s-option value="">Choose…</s-option>
              {GENDERS.map((g) => (
                <s-option key={g} value={g}>
                  {g}
                </s-option>
              ))}
            </s-select>
          </s-grid>
          <s-text color="subdued">We only use your number to reach you about your orders.</s-text>
          {saveMsg && <s-banner tone={saveMsg.tone}>{saveMsg.text}</s-banner>}
          <s-stack direction="inline">
            <s-button variant="primary" loading={saving} onClick={save}>
              Save changes
            </s-button>
          </s-stack>
        </s-stack>

        <s-divider />

        {/* Date of birth + age verification */}
        <s-stack direction="block" gap="base">
          <s-grid gridTemplateColumns="1fr auto" alignItems="center" gap="base">
            <s-stack direction="block" gap="small-300">
              <s-heading>Date of birth &amp; age</s-heading>
              <s-text color="subdued">
                {me.birthDate ? `On file: ${prettyDate(me.birthDate)}` : 'Not added yet'}
              </s-text>
            </s-stack>
            {me.ageVerified ? (
              <s-badge icon="check-circle">Age verified (21+)</s-badge>
            ) : (
              <s-badge tone="neutral">Not verified</s-badge>
            )}
          </s-grid>

          {me.ageVerified ? (
            <s-text>
              You're all set. When you're signed in, you won't be asked for your date of birth when buying beer, wine or other 21+
              items. Please still bring photo ID for pickup or delivery.
            </s-text>
          ) : (
            <s-stack direction="block" gap="base">
              <s-text>
                {me.birthDate
                  ? 'Confirm your date of birth once to skip the age check every time you shop signed in.'
                  : "Add your date of birth to skip the age check when you shop signed in. It can only be added once, so please make sure it's right."}
              </s-text>
              <s-grid gridTemplateColumns="1fr auto" alignItems="end" gap="base">
                <s-date-field
                  label="Date of birth"
                  value={dob}
                  error={dobError}
                  defaultView="2000-01"
                  onChange={(e) => setDob(e.currentTarget.value)}
                />
                <s-button loading={verifying} onClick={verify}>
                  {me.birthDate ? 'Verify' : 'Add & verify'}
                </s-button>
              </s-grid>
            </s-stack>
          )}
          {ageMsg && <s-banner tone={ageMsg.tone}>{ageMsg.text}</s-banner>}
          {me.birthDate && (
            <s-text color="subdued">Date of birth wrong? Call us at (917) 265-8063 and we'll fix it.</s-text>
          )}
        </s-stack>
      </s-stack>
      </s-query-container>
    </s-section>
  );
}
