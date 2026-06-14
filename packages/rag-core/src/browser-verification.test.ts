import { describe, expect, it } from 'vitest';

import { isBrowserVerificationText } from './browser-verification.js';

describe('isBrowserVerificationText', () => {
  it('recognizes Cloudflare verifying-you-are-human challenge copy', () => {
    expect(isBrowserVerificationText('Verifying you are human. This may take a few seconds.')).toBe(
      true,
    );
  });

  it('recognizes generic verify-your-browser challenge copy', () => {
    expect(isBrowserVerificationText('Please wait while we verify your browser')).toBe(true);
  });

  it('recognizes generic security-check challenge copy', () => {
    expect(
      isBrowserVerificationText('Please complete the security check to access solscan.io'),
    ).toBe(true);
  });

  it('recognizes press-and-hold human verification copy', () => {
    expect(isBrowserVerificationText('Press & Hold to confirm you are a human')).toBe(true);
    expect(isBrowserVerificationText('Please prove you are human before continuing')).toBe(true);
  });

  it('recognizes cookie and JavaScript enablement challenge copy', () => {
    expect(isBrowserVerificationText('Please enable cookies to continue')).toBe(true);
    expect(isBrowserVerificationText('Please enable JavaScript and refresh the page')).toBe(true);
  });

  it('recognizes blocked security challenge copy', () => {
    expect(
      isBrowserVerificationText(
        'Sorry, you have been blocked. You are unable to access etherscan.io',
      ),
    ).toBe(true);
    expect(
      isBrowserVerificationText(
        'This website is using a security service to protect itself from online attacks. The action you just performed triggered the security solution.',
      ),
    ).toBe(true);
  });

  it('recognizes Cloudflare challenge markers from rendered markup', () => {
    expect(isBrowserVerificationText('cf-mitigated: challenge')).toBe(true);
    expect(isBrowserVerificationText('/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page')).toBe(
      true,
    );
    expect(isBrowserVerificationText('window._cf_chl_opt = {"cType":"managed"};')).toBe(true);
  });

  it('recognizes common bot-check and challenge-running copy from explorer pages', () => {
    expect(isBrowserVerificationText('Human verification required before continuing')).toBe(true);
    expect(isBrowserVerificationText('Please verify you are not a bot to continue')).toBe(true);
    expect(isBrowserVerificationText('<html class="no-js" id="cf-challenge-running">')).toBe(true);
    expect(isBrowserVerificationText('Cloudflare Ray ID: 8f1234567890abcd')).toBe(true);
  });

  it('recognizes browser verification markers from challenge form markup', () => {
    expect(isBrowserVerificationText('Set-Cookie: cf_clearance=abc123')).toBe(true);
    expect(isBrowserVerificationText('<input name="cf-turnstile-response" value="">')).toBe(true);
    expect(isBrowserVerificationText('<div class="g-recaptcha" data-sitekey="key"></div>')).toBe(
      true,
    );
    expect(isBrowserVerificationText('<div class="h-captcha" data-sitekey="key"></div>')).toBe(
      true,
    );
  });

  it('recognizes non-Cloudflare WAF challenge markers from explorer pages', () => {
    expect(isBrowserVerificationText('DataDome protected page. cid=abc123')).toBe(true);
    expect(isBrowserVerificationText('Akamai Bot Manager challenge _abck=bm_sz')).toBe(true);
    expect(isBrowserVerificationText('PerimeterX challenge token _px3')).toBe(true);
    expect(isBrowserVerificationText('Kasada challenge x-kpsdk-ct')).toBe(true);
  });

  it('does not treat normal Blockscout transaction pages as verification because of a reCAPTCHA footer', () => {
    expect(
      isBrowserVerificationText(`
        Transaction details
        Transaction hash
        0x42a2030a39950aa611a2308c9bc77296a97e44fd75449777340df3e097eaf0ba
        Status and method
        Success
        From
        0xF9b6a1EB0190bf76274B0876957Ee9F4f508Af41
        This site is protected by reCAPTCHA and the Google Privacy Policy and Terms of Service apply.
      `),
    ).toBe(false);
  });
});
