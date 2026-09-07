import {
  accountId,
  configurationSetArn,
  createIdentity,
  createTenant,
  associateWithTenant,
  identityArn,
  identityStatus,
  productionAccess,
  sesConfigured,
  sesEnv,
} from "../engine/sesIdentity.js";

/**
 * Proves the AWS side works before a customer is ever asked to touch their DNS.
 *
 * Everything here runs in the sandbox, so it is worth running the hour the credentials are
 * created rather than after production access comes through — the two waits are
 * independent, and finding a wrong region or a missing IAM action on day two is cheaper
 * than finding it on day three.
 *
 *   npm run ses:check                    # account, region, sandbox or production
 *   npm run ses:check -- example.com     # also registers a domain and prints its DNS
 */

const domain = process.argv.slice(2).find((a) => a.includes(".") && !a.startsWith("-"));
const line = (label: string, value: string) => console.log(`  ${label.padEnd(20)} ${value}`);

async function main() {
  if (!sesConfigured()) {
    console.log("\nAWS_REGION, AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are not set.");
    console.log("See docs/amazon-ses-setup.md — steps 4 and 7.\n");
    return;
  }

  const env = sesEnv();
  console.log("\n── account ──");
  line("region", env.region);
  line("event topic", env.eventTopicArn ?? "not set — bounces will not be reported");
  // Needed to name resources when associating them with a tenant. Read from
  // AWS_ACCOUNT_ID, or parsed out of the topic ARN when that is set.
  line("account", accountId() ?? "unknown — tenants will be skipped, set AWS_ACCOUNT_ID");

  const account = await productionAccess();
  line("sending", account.sendingEnabled ? "enabled" : "PAUSED — check the SES dashboard");
  line("production access", account.enabled ? "granted" : "SANDBOX — verified recipients only, 200/day");
  line("24h quota", String(account.quota ?? "?"));

  if (!account.enabled) {
    console.log("\n  Sandbox is expected on a new account. Domain verification below still works;");
    console.log("  only sending to unverified recipients is blocked. See step 6 of the setup doc.");
  }

  if (!domain) {
    console.log("\nPass a domain to register one: npm run ses:check -- example.com\n");
    return;
  }

  console.log(`\n── ${domain} ──`);
  const identity = await createIdentity(domain, "ses-check");
  line("status", identity.status);
  line("configuration set", identity.configurationSetName);
  line("mail from", identity.mailFromDomain ?? "not set — SPF will align to amazonses.com");
  line("checks until", identity.checksUntil?.toISOString() ?? "?");

  console.log("\n  Publish these:\n");
  for (const record of identity.records) {
    const priority = record.priority ? ` (priority ${record.priority})` : "";
    console.log(`    ${record.required ? "required" : "optional"}  ${record.kind.padEnd(5)} ${record.name}`);
    console.log(`              ${" ".repeat(5)} ${record.value}${priority}\n`);
  }

  // The tenant this product would send as. Exercised here because a plan that does not
  // include tenants fails at exactly this call, and finding that out now is worth more than
  // finding it out when a customer connects a domain.
  console.log("\n── tenant ──");
  const tenant = await createTenant("ses-check");
  if (!tenant) {
    line("tenant", "REFUSED — sending would fall back to the account's shared reputation");
    line("", "check whether your pricing plan includes tenants");
  } else {
    line("tenant", tenant.tenantName);
    const domainArn = identityArn(domain);
    const configArn = configurationSetArn(identity.configurationSetName);
    if (!domainArn || !configArn) {
      line("associations", "SKIPPED — no account id, so ARNs cannot be built");
    } else {
      const both =
        (await associateWithTenant(tenant.tenantName, domainArn)) &&
        (await associateWithTenant(tenant.tenantName, configArn));
      line("associations", both ? "identity and configuration set associated" : "FAILED — sending stays account-level");
    }
  }

  const status = await identityStatus(domain);
  console.log("\n── verification ──");
  line("dkim now", status.dkim);
  console.log("\n  DNS takes minutes to hours. The tick polls this and brings the channel up on its own.\n");
}

main().catch((err) => {
  console.error(`\n  FAILED — ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
