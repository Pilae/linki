import type { Page } from "playwright";

// URL/element identity works across UI languages. Unknown challenges must not
// be classified from translated titles or solved by clicking generic buttons.
export const CAPTCHA_SELECTOR =
  "iframe[src*='arkoselabs'], iframe[src*='funcaptcha'], iframe[src*='hcaptcha'], iframe[src*='recaptcha'], iframe[src*='captcha'], #captcha-internal";
export const INVALID_CREDENTIAL_SELECTOR =
  "input#username[aria-invalid='true'], input#password[aria-invalid='true'], input[type='email'][aria-invalid='true'], input[type='password'][aria-invalid='true']";

export async function hasCaptchaSignal(page: Page): Promise<boolean> {
  return await page.locator(CAPTCHA_SELECTOR).count().catch(() => 0) > 0;
}

export async function hasInvalidCredentialSignal(page: Page): Promise<boolean> {
  return await page.locator(INVALID_CREDENTIAL_SELECTOR).count().catch(() => 0) > 0;
}
