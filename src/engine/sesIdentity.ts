import {
  SESv2Client,
  CreateEmailIdentityCommand,
  GetEmailIdentityCommand,
  DeleteEmailIdentityCommand,
  PutEmailIdentityMailFromAttributesCommand,
  CreateConfigurationSetCommand,
  CreateConfigurationSetEventDestinationCommand,
  CreateTenantCommand,
  CreateTenantResourceAssociationCommand,
  DeleteTenantCommand,
  GetAccountCommand,
  UpdateReputationEntityCustomerManagedStatusCommand,
} from "@aws-sdk/client-sesv2";

/**
 * Verifying a customer's domain with SES, and the DNS they have to publish for it.
 *
 * Deliberately not modelled on the Gmail connect flow, because the two prove different
 * things. OAuth proves someone can sign in to a mailbox, and finishes in one click. This
 * proves someone controls a domain, and finishes whenever a colleague with DNS access gets
 * round to it — which may be days, or never. Every function here is written to be called
 * again on a later tick rather than to complete in one request.
 */

const DNS_DEADLINE_HOURS = 72;

export interface SesEnv {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  eventTopicArn?: string;
}

/**
 * The deployment's own AWS credentials, not a tenant's.
 *
 * Every customer's domain lives in one AWS account, so there is nothing per-tenant to
 * store and nothing for the broker to refresh — which is why the SES branch of the adapter
 * resolver must run before it asks for a secret there is none of.
 */
export function sesEnv(): SesEnv {
  const region = process.env.AWS_REGION;
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  if (!region || !accessKeyId || !secretAccessKey) {
    throw new Error(
      "AWS_REGION, AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are not set — see docs/amazon-ses-setup.md",
    );
  }
  return { region, accessKeyId, secretAccessKey, eventTopicArn: process.env.SES_EVENT_TOPIC_ARN };
}

export function sesConfigured(): boolean {
  return Boolean(process.env.AWS_REGION && process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);
}

function client(env = sesEnv()): SESv2Client {
  return new SESv2Client({
    region: env.region,
    credentials: { accessKeyId: env.accessKeyId, secretAccessKey: env.secretAccessKey },
  });
}

/** One row of the table the customer copies into their DNS. */
export interface DnsRecord {
  kind: "CNAME" | "TXT" | "MX";
  name: string;
  value: string;
  priority?: number;
  /** Whether sending is blocked until this one is published. */
  required: boolean;
}

export interface SesIdentity {
  domain: string;
  status: "pending" | "verified" | "failed";
  dkimTokens: string[];
  records: DnsRecord[];
  configurationSetName: string;
  mailFromDomain?: string;
  /** After this, AWS stops re-checking and the identity has to be recreated. */
  checksUntil?: Date;
}

/**
 * Registers a domain with SES and returns what the customer has to publish.
 *
 * The MAIL FROM subdomain is set up in the same call. Without it SPF authenticates
 * `amazonses.com` rather than the customer's own domain, so DMARC passes on DKIM alone —
 * which is valid, and looks to a receiver like mail sent by a third party, because it is.
 * Two extra records buy a From and an envelope that agree.
 */
export async function createIdentity(domain: string, productId: string): Promise<SesIdentity> {
  const env = sesEnv();
  const ses = client(env);
  const configurationSetName = configSetNameFor(productId);

  await ensureConfigurationSet(ses, configurationSetName, env);

  // Adopted rather than refused when AWS already knows this domain.
  //
  // An identity can exist without a connection pointing at it: verified by hand in the
  // console, or left behind by a connection that was deleted while AWS still held it. In
  // both cases the domain genuinely is verified for this account, and the useful answer is
  // the DKIM tokens it already has — refusing with "AlreadyExistsException" would hand a
  // customer an AWS error for a domain that is ready to send.
  //
  // Safe because whose domain it is has already been settled: connectSesDomain refuses a
  // domain another org has claimed before it ever reaches here, so adopting an orphan is
  // never adopting someone else's.
  let created;
  try {
    created = await ses.send(
      new CreateEmailIdentityCommand({
        EmailIdentity: domain,
        ConfigurationSetName: configurationSetName,
        DkimSigningAttributes: { NextSigningKeyLength: "RSA_2048_BIT" },
      }),
    );
  } catch (err) {
    if ((err as { name?: string })?.name !== "AlreadyExistsException") throw err;
    const existing = await ses.send(new GetEmailIdentityCommand({ EmailIdentity: domain }));
    created = {
      DkimAttributes: existing.DkimAttributes,
      VerifiedForSendingStatus: existing.VerifiedForSendingStatus,
    };
  }

  const dkimTokens = created.DkimAttributes?.Tokens ?? [];
  // An adopted identity may already be through, in which case there is nothing for the
  // customer to publish and the channel should not sit in a pending state waiting for DNS
  // that is already live.
  const alreadyVerified =
    created.VerifiedForSendingStatus === true && created.DkimAttributes?.Status === "SUCCESS";
  const mailFromDomain = `mail.${domain}`;

  // Set after the identity exists, because SES has nothing to attach it to before that.
  // A failure here is not fatal: the identity still verifies and still sends, with SPF
  // aligned to amazonses.com instead. Blocking the whole connect flow on the optional half
  // would be the worse trade.
  let mailFromSet = true;
  try {
    await ses.send(
      new PutEmailIdentityMailFromAttributesCommand({
        EmailIdentity: domain,
        MailFromDomain: mailFromDomain,
        // If the subdomain's MX is missing or wrong, fall back to amazonses.com rather than
        // refusing to send. REJECT_MESSAGE here would turn one unpublished DNS record into
        // a silently dead channel.
        BehaviorOnMxFailure: "USE_DEFAULT_VALUE",
      }),
    );
  } catch {
    mailFromSet = false;
  }

  return {
    domain,
    status: alreadyVerified ? "verified" : "pending",
    dkimTokens,
    configurationSetName,
    mailFromDomain: mailFromSet ? mailFromDomain : undefined,
    records: recordsFor(domain, dkimTokens, mailFromSet ? mailFromDomain : undefined, env.region),
    checksUntil: new Date(Date.now() + DNS_DEADLINE_HOURS * 3600_000),
  };
}

/**
 * The DNS a customer publishes. Ordered required-first, because the ones that block sending
 * and the ones that merely improve it should not look alike on a page somebody is copying
 * from at speed.
 */
export function recordsFor(
  domain: string,
  dkimTokens: string[],
  mailFromDomain: string | undefined,
  region: string,
): DnsRecord[] {
  const records: DnsRecord[] = dkimTokens.map((token) => ({
    kind: "CNAME",
    name: `${token}._domainkey.${domain}`,
    value: `${token}.dkim.amazonses.com`,
    required: true,
  }));

  if (mailFromDomain) {
    records.push(
      {
        kind: "MX",
        name: mailFromDomain,
        value: `feedback-smtp.${region}.amazonses.com`,
        priority: 10,
        required: false,
      },
      {
        kind: "TXT",
        name: mailFromDomain,
        value: "v=spf1 include:amazonses.com ~all",
        required: false,
      },
    );
  }

  return records;
}

export interface IdentityStatus {
  status: "pending" | "verified" | "failed";
  dkim: string;
  mailFromReady: boolean;
  detail?: string;
}

/**
 * Where a pending identity has got to. Called from the tick, not from the page: DNS takes
 * long enough that nobody watches it land, and a customer who closed the tab still needs
 * their channel to come up.
 */
export async function identityStatus(domain: string): Promise<IdentityStatus> {
  const ses = client();
  const identity = await ses.send(new GetEmailIdentityCommand({ EmailIdentity: domain }));

  const dkim = identity.DkimAttributes?.Status ?? "NOT_STARTED";
  const mailFromReady = identity.MailFromAttributes?.MailFromDomainStatus === "SUCCESS";

  // VerifiedForSendingStatus is the one that decides, not the DKIM status on its own: an
  // identity can hold verified tokens and still be refused, and sending on the strength of
  // the wrong field means every message bounces at the API.
  if (identity.VerifiedForSendingStatus && dkim === "SUCCESS") {
    return { status: "verified", dkim, mailFromReady };
  }

  // FAILED is terminal. AWS re-checks for 72 hours and then gives up, and nothing about the
  // identity recovers on its own after that — it has to be deleted and created again, which
  // mints new DKIM tokens and means new DNS for the customer.
  if (dkim === "FAILED") {
    return {
      status: "failed",
      dkim,
      mailFromReady,
      detail: `AWS stopped checking after ${DNS_DEADLINE_HOURS} hours. The records have to be published and the domain added again.`,
    };
  }

  return { status: "pending", dkim, mailFromReady };
}

/** Starts the 72 hours over, with fresh tokens, for a domain whose DNS arrived too late. */
export async function recreateIdentity(domain: string, productId: string): Promise<SesIdentity> {
  await deleteIdentity(domain);
  return createIdentity(domain, productId);
}

export async function deleteIdentity(domain: string): Promise<void> {
  try {
    await client().send(new DeleteEmailIdentityCommand({ EmailIdentity: domain }));
  } catch {
    // Already gone is the outcome we wanted. Anything else still leaves the local rows to
    // clean up, and a stuck identity in AWS is a smaller problem than a channel that cannot
    // be removed from the UI.
  }
}

/**
 * Whether this account may send to addresses nobody has verified.
 *
 * Sandbox is the state every AWS account starts in, and its failure mode is the confusing
 * one: sending works, to the handful of verified addresses, and every real recipient is
 * rejected per-message. Reading it once and saying so on the channel is the difference
 * between that and a customer watching their campaign fail one message at a time.
 */
export async function productionAccess(): Promise<{ enabled: boolean; sendingEnabled: boolean; quota?: number }> {
  const account = await client().send(new GetAccountCommand({}));
  return {
    enabled: account.ProductionAccessEnabled ?? false,
    sendingEnabled: account.SendingEnabled ?? false,
    quota: account.SendQuota?.Max24HourSend,
  };
}

/** One per product, so a bounce arrives already attributed to whose sending caused it. */
export function configSetNameFor(productId: string): string {
  return `product-${productId}`;
}

/** Creates the configuration set for a product if it is not already there. Exposed because
 * a resource cannot be associated with a tenant before it exists, and the sandbox test
 * builds its own without going through createIdentity. */
export async function ensureConfigSet(productId: string): Promise<string> {
  const env = sesEnv();
  const name = configSetNameFor(productId);
  await ensureConfigurationSet(client(env), name, env);
  return name;
}

async function ensureConfigurationSet(ses: SESv2Client, name: string, env: SesEnv): Promise<void> {
  try {
    await ses.send(new CreateConfigurationSetCommand({ ConfigurationSetName: name }));
  } catch (err) {
    // Already there. Every later connect for this product lands here, which is the normal
    // path rather than an error worth surfacing.
    if ((err as { name?: string })?.name !== "AlreadyExistsException") throw err;
  }

  if (!env.eventTopicArn) return;
  try {
    await ses.send(
      new CreateConfigurationSetEventDestinationCommand({
        ConfigurationSetName: name,
        EventDestinationName: "engine-events",
        EventDestination: {
          Enabled: true,
          // Bounce and complaint are the two AWS suspends accounts over, so they are not
          // optional. Delivery is what makes a send answerable afterwards — it is the
          // confirmation Gmail never provides.
          MatchingEventTypes: ["BOUNCE", "COMPLAINT", "DELIVERY", "REJECT"],
          SnsDestination: { TopicArn: env.eventTopicArn },
        },
      }),
    );
  } catch (err) {
    if ((err as { name?: string })?.name !== "AlreadyExistsException") throw err;
  }
}


/**
 * A tenant per customer: the isolation this design otherwise does not have.
 *
 * Every customer's domain lives in one AWS account, which without tenants means one shared
 * reputation — a single customer mailing a bought list puts every other customer's sending
 * at risk, and AWS's enforcement is account-wide. A tenant scopes three things that matter:
 * its own suppression list, its own reputation entity, and a sending status that can be
 * turned off for one customer while everybody else keeps sending.
 *
 * The name is the product id rather than anything a person types. Tenant names cannot be
 * changed after creation, and a customer-chosen label is exactly the kind of thing that
 * gets renamed six months later — leaving a tenant whose name matches nothing.
 *
 * Best effort, deliberately. Tenants may not be available on every pricing plan, and a
 * connect flow that dies because of an entitlement is worse than one that sends without
 * per-tenant isolation: the fallback is the account-level behaviour that was the only
 * option before, plus our own per-channel governor and pause. What is lost is recorded on
 * the connection so the gap is visible rather than assumed away.
 */
export async function createTenant(
  productId: string,
): Promise<{ tenantName: string; tenantArn?: string } | null> {
  const ses = client();
  const tenantName = tenantNameFor(productId);

  try {
    const created = await ses.send(
      new CreateTenantCommand({
        TenantName: tenantName,
        SuppressionAttributes: {
          // Isolated rather than shared. An address one customer burned is not evidence
          // about anybody else's list, and a shared list makes it look like it is.
          SuppressionScope: "TENANT",
          SuppressedReasons: ["BOUNCE", "COMPLAINT"],
        },
      }),
    );
    return { tenantName, tenantArn: created.TenantArn };
  } catch (err) {
    const name = (err as { name?: string })?.name ?? "";
    // Already there is the normal path on a second connect for the same product.
    if (name === "AlreadyExistsException") return { tenantName };
    return null;
  }
}

/**
 * Binds a resource to a tenant. Both the identity and the configuration set have to be
 * associated, because SendEmail with a TenantName fails unless every resource it references
 * belongs to that tenant — a half-associated tenant is a channel that cannot send at all.
 */
export async function associateWithTenant(
  tenantName: string,
  resourceArn: string,
): Promise<{ ok: boolean; reason?: string }> {
  try {
    await client().send(
      new CreateTenantResourceAssociationCommand({ TenantName: tenantName, ResourceArn: resourceArn }),
    );
    return { ok: true };
  } catch (err) {
    // Already associated is success on a second connect for the same product.
    if ((err as { name?: string })?.name === "AlreadyExistsException") return { ok: true };
    // Returned rather than swallowed. A tenant that silently fails to bind leaves sending on
    // the account's shared reputation, which is the failure this whole feature exists to
    // avoid — and "associations failed" with no reason is not something anyone can act on.
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

export async function deleteTenant(tenantName: string): Promise<void> {
  try {
    await client().send(new DeleteTenantCommand({ TenantName: tenantName }));
  } catch {
    // Same reasoning as deleteIdentity: a tenant left behind in AWS is a smaller problem
    // than a channel that cannot be removed from the UI.
  }
}

/**
 * Stops or restarts sending for one customer, at AWS rather than only in our own code.
 *
 * Our channel status already keeps the engine from selecting a degraded channel, and that
 * is enough while the engine is the only thing sending. This is the layer under it: a
 * disabled reputation entity is refused by the API itself, so a pause survives a bug in our
 * own guard, a script run by hand, or anything else that reaches SES without going through
 * fireDue.
 *
 * Customer-managed status is a separate record from the one AWS keeps. Setting it does not
 * overwrite AWS's own verdict, and clearing it does not undo an AWS suspension.
 */
export async function setTenantSending(tenantArn: string, enabled: boolean): Promise<boolean> {
  try {
    await client().send(
      new UpdateReputationEntityCustomerManagedStatusCommand({
        ReputationEntityType: "RESOURCE",
        ReputationEntityReference: tenantArn,
        SendingStatus: enabled ? "ENABLED" : "DISABLED",
      }),
    );
    return true;
  } catch {
    return false;
  }
}

/** Stable, immutable, and never something a person typed. */
export function tenantNameFor(productId: string): string {
  return `product-${productId}`;
}


/**
 * The AWS account these resources live in, needed to name them.
 *
 * Tenant associations take an ARN, and neither CreateEmailIdentity nor
 * CreateConfigurationSet returns one — the ARN has to be built, and building it needs the
 * account id. Read from the environment, or parsed out of the SNS topic ARN that is already
 * configured, rather than pulled from STS: that would be another dependency and another IAM
 * action for one twelve-digit number the deployment already has.
 *
 * Returning undefined disables tenants rather than failing. Sending still works; what is
 * lost is the isolation, and that is recorded on the connection.
 */
export function accountId(): string | undefined {
  const explicit = process.env.AWS_ACCOUNT_ID?.trim();
  if (explicit) return explicit;
  const topic = process.env.SES_EVENT_TOPIC_ARN;
  // arn:aws:sns:<region>:<account>:<topic>
  return topic?.split(":")[4] || undefined;
}

export function identityArn(domain: string): string | undefined {
  const account = accountId();
  const region = process.env.AWS_REGION;
  return account && region ? `arn:aws:ses:${region}:${account}:identity/${domain}` : undefined;
}

export function configurationSetArn(name: string): string | undefined {
  const account = accountId();
  const region = process.env.AWS_REGION;
  return account && region ? `arn:aws:ses:${region}:${account}:configuration-set/${name}` : undefined;
}

export function tenantArnFor(tenantName: string): string | undefined {
  const account = accountId();
  const region = process.env.AWS_REGION;
  return account && region ? `arn:aws:ses:${region}:${account}:tenant/${tenantName}` : undefined;
}
