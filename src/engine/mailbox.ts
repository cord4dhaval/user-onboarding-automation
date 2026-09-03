/**
 * Free mailbox providers, as they appear in lead data.
 *
 * The domain of one of these addresses is the mail host, not an employer. Splitting it off
 * the address and storing it as the company tells the planner that a lead works at Gmail,
 * and every message written from that belief is wrong in a way nobody catches — the copy
 * reads fine, it is just about the wrong company.
 *
 * The list only has to cover what actually turns up. An unrecognised domain is treated as
 * a company, which is the right default for a work address.
 */
const FREE_PROVIDERS = new Set([
  "gmail.com", "googlemail.com",
  "yahoo.com", "yahoo.co.in", "yahoo.co.uk", "yahoo.fr", "ymail.com", "rocketmail.com",
  "hotmail.com", "hotmail.co.uk", "outlook.com", "live.com", "msn.com",
  "aol.com", "icloud.com", "me.com", "mac.com",
  "proton.me", "protonmail.com", "pm.me",
  "gmx.com", "gmx.net", "gmx.de", "web.de", "mail.com",
  "zoho.com", "yandex.com", "yandex.ru", "mail.ru",
  "tutanota.com", "tuta.io", "fastmail.com", "hey.com",
  "rediffmail.com", "qq.com", "163.com", "126.com", "naver.com",
  // Disposable mailboxes. They behave like personal addresses for planning purposes; that
  // they are also throwaway is a separate judgement nothing acts on yet.
  "yopmail.com", "mailinator.com", "guerrillamail.com", "10minutemail.com",
]);

export type MailboxKind = "work" | "personal" | "unknown";

export interface MailboxFields {
  emailKind: MailboxKind;
  companyDomain?: string;
}

/**
 * What an address says about where someone works — which for a free mailbox is nothing.
 *
 * The two facts are independent and are kept that way. `emailKind` describes the address
 * alone: a founder writing from Gmail has a personal address whether or not the sheet also
 * named their company. `companyDomain` describes the company, and a value the source
 * supplied always wins over one inferred from the address, because whoever built the sheet
 * knew something the address cannot say.
 *
 * `companyDomain` is left off entirely rather than set to an empty string, so a reader can
 * tell "no company to find" from "company we have not looked up yet".
 */
export function mailboxFields(email: string, declaredDomain?: string): MailboxFields {
  const declared = declaredDomain?.trim().toLowerCase();
  const domain = email.split("@")[1]?.trim().toLowerCase();
  if (!domain) return declared ? { emailKind: "unknown", companyDomain: declared } : { emailKind: "unknown" };

  const emailKind: MailboxKind = FREE_PROVIDERS.has(domain) ? "personal" : "work";
  if (declared) return { emailKind, companyDomain: declared };
  return emailKind === "personal" ? { emailKind } : { emailKind, companyDomain: domain };
}

/** True for the addresses where web research has nothing to work with. */
export function isFreeProvider(domain: string): boolean {
  return FREE_PROVIDERS.has(domain.trim().toLowerCase());
}
