import {
  accountId,
  configurationSetArn,
  createIdentity,
  createTenant,
  associateWithTenant,
  identityArn,
  deleteTenant,
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

  // Before the domain, and without needing one. Whether this account may create tenants is
  // the question that decides how much isolation the design gets, and it is answerable with
  // credentials alone — waiting for somebody to own a domain before finding out would be a
  // day lost to nothing.
  console.log("\n── tenants ──");
  const probe = await createTenant("probe");
  if (!probe) {
    line("tenants", "REFUSED");
    line("", "every customer would send on the account's shared reputation:");
    line("", "one bad list could suspend sending for all of them.");
    line("", "check whether your pricing plan includes tenants.");
  } else {
    line("tenants", `available — created ${probe.tenantName}`);
    line("suppression", "per tenant, on bounce and complaint");
    // Removed again straight away. A probe that leaves a tenant behind is a tenant whose
    // name matches no product, and the next person to read the console has to work out
    // whether it matters.
    await deleteTenant(probe.tenantName);
    line("cleanup", "probe tenant removed");
  }

  if (!domain) {
    console.log("\nEverything above needs no domain. To register one and print its DNS:");
    console.log("  npm run ses:check -- example.com\n");
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

  // The tenant this domain would actually send as, and the associations that make it
  // usable. Separate from the probe above: that one answered "are tenants allowed", this
  // one answers "can this domain be bound to one".
  console.log("\n── tenant association ──");
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
      const identityBound = await associateWithTenant(tenant.tenantName, domainArn);
      const configBound = identityBound.ok
        ? await associateWithTenant(tenant.tenantName, configArn)
        : identityBound;
      line(
        "associations",
        configBound.ok ? "identity and configuration set associated" : "FAILED — sending stays account-level",
      );
      if (!configBound.ok) line("why", configBound.reason ?? "no reason given");
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
