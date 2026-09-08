import {
  SESv2Client,
  CreateEmailIdentityCommand,
  GetEmailIdentityCommand,
  DeleteEmailIdentityCommand,
} from "@aws-sdk/client-sesv2";
import { SesAdapter } from "../adapters/channel/ses.js";
import {
  associateWithTenant,
  configurationSetArn,
  createTenant,
  ensureConfigSet,
  identityArn,
  sesConfigured,
  sesEnv,
} from "../engine/sesIdentity.js";

/**
 * Sends one real message through SES without anybody owning a domain.
 *
 * A domain identity is the right thing for a customer and the wrong thing for a first test:
 * it needs DNS access, a colleague, and a wait measured in hours. SES also verifies a single
 * address, by mailing it a link — which proves exactly the same send path, in about a minute,
 * with nothing to publish.
 *
 * What this actually exercises is everything between the engine and the recipient: the MIME
 * the adapter builds, the tenant the message is attributed to, the configuration set the
 * events will arrive on, and the Message-ID that later replies thread against. What it does
 * not exercise is DKIM alignment, which only a domain can prove.
 *
 *   npm run ses:sandbox -- you@example.com              # verify the address
 *   npm run ses:sandbox -- you@example.com --send       # then send to itself
 *   npm run ses:sandbox -- you@example.com --cleanup    # remove the identity again
 */

const args = process.argv.slice(2);
const address = args.find((a) => a.includes("@"));
const doSend = args.includes("--send");
const doCleanup = args.includes("--cleanup");
const line = (label: string, value: string) => console.log(`  ${label.padEnd(18)} ${value}`);

function client() {
  const env = sesEnv();
  return new SESv2Client({
    region: env.region,
    credentials: { accessKeyId: env.accessKeyId, secretAccessKey: env.secretAccessKey },
  });
}

async function main() {
  if (!sesConfigured()) throw new Error("AWS credentials are not set — see docs/amazon-ses-setup.md");
  if (!address) throw new Error("Pass an address: npm run ses:sandbox -- you@example.com");

  const ses = client();

  if (doCleanup) {
    await ses.send(new DeleteEmailIdentityCommand({ EmailIdentity: address }));
    console.log(`\n  ${address} removed from SES.\n`);
    return;
  }

  console.log(`\n── ${address} ──`);

  let verified = false;
  try {
    const existing = await ses.send(new GetEmailIdentityCommand({ EmailIdentity: address }));
    verified = existing.VerifiedForSendingStatus ?? false;
    line("identity", verified ? "already verified" : "already added, not verified yet");
  } catch (err) {
    if ((err as { name?: string })?.name !== "NotFoundException") throw err;
    await ses.send(new CreateEmailIdentityCommand({ EmailIdentity: address }));
    line("identity", "created");
    line("next", `Amazon has emailed ${address} a verification link. Click it.`);
  }

  if (!verified) {
    console.log("\n  Not verified yet. Click the link, then run the same command again.");
    console.log(`  Once it says verified:  npm run ses:sandbox -- ${address} --send\n`);
    return;
  }

  if (!doSend) {
    console.log("\n  Verified and ready. To send one real message to it:");
    console.log(`    npm run ses:sandbox -- ${address} --send\n`);
    return;
  }

  // In the sandbox both ends have to be verified, so the address mails itself. That is also
  // the most useful shape for a first test: whatever arrives can be inspected in full.
  console.log("\n── sending ──");
  const env = sesEnv();
  // Created, not just named. A configuration set that does not exist cannot be associated
  // with a tenant, and the association failing is what silently drops sending back to the
  // account's shared reputation.
  const configurationSetName = await ensureConfigSet("sandbox-test");

  // The same tenant path a real customer gets, so a failure here is found now rather than
  // on the first domain that matters.
  const tenant = await createTenant("sandbox-test");
  let tenantName: string | undefined;
  if (tenant) {
    const idArn = identityArn(address);
    const cfgArn = configurationSetArn(configurationSetName);
    if (idArn && cfgArn) {
      const identityBound = await associateWithTenant(tenant.tenantName, idArn);
      const configBound = identityBound.ok
        ? await associateWithTenant(tenant.tenantName, cfgArn)
        : identityBound;
      // Only claimed when both associations hold: SendEmail with a TenantName is refused
      // unless every resource it references belongs to that tenant.
      tenantName = configBound.ok ? tenant.tenantName : undefined;
      line("tenant", configBound.ok ? tenant.tenantName : "associations failed — sending account-level");
      if (!configBound.ok) line("why", configBound.reason ?? "no reason given");
    }
  } else {
    line("tenant", "unavailable — sending account-level");
  }

  const adapter = new SesAdapter(
    "email",
    { region: env.region, accessKeyId: env.accessKeyId, secretAccessKey: env.secretAccessKey, tenantName },
    address,
  );

  const result = await adapter.send({
    to: address,
    subject: "SES sandbox test",
    bodyText:
      "Sent through Amazon SES by the conversion engine.\n\n" +
      "If this arrived, the adapter, the MIME builder and the tenant path all work.",
  });

  line("accepted", String(result.accepted));
  line("provider id", String(result.providerMessageId));
  // The header id, known without a second call — this is what a follow-up references to
  // stay in the same conversation.
  line("message id", String(result.messageId));
  console.log(`\n  Check ${address}. Reply headers are what threading will hang off.\n`);
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`\n  FAILED — ${message}\n`);
  // Sandbox rejects an unverified recipient per message, which reads like a broken send and
  // is really the account still waiting on production access.
  if (/not verified/i.test(message)) {
    console.error("  Both sender and recipient must be verified while the account is in the sandbox.\n");
  }
  process.exit(1);
});
