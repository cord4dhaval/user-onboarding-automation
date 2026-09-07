# Amazon SES: AWS account to first send, from scratch

One AWS account serves the whole deployment. Every customer who sends from their own domain
is a verified identity inside it, so this is done once by whoever runs the app — not per
tenant.

Do step 6 first if you are in a hurry. It is the only step with a wait, and everything else
can be finished while AWS decides.

---

## 1. Create the AWS account

<https://portal.aws.amazon.com/billing/signup>

| Field | What to put |
| --- | --- |
| Account name | The company, not your name — it appears on invoices |
| Email | A shared address you will still control in two years, not a personal one |
| Account type | Business, if you have a registered company |
| Card | Required even on the free tier. SES is not free; expect single-digit dollars |
| Support plan | Basic. Free, and enough |

Verification is a card charge of about $1, refunded, plus a phone code.

## 2. Lock the root account down before anything else

The root user can close the account and move money. It should never be used again after
this step.

1. Sign in as root → top-right menu → **Security credentials**
2. **Multi-factor authentication → Assign MFA device** — authenticator app is fine
3. Confirm there are **no root access keys**. If any exist, delete them.

Then create yourself a normal admin user to work as:

**IAM → Users → Create user** → console access → attach `AdministratorAccess` → sign in as
that from now on.

## 3. Pick one region and stay in it

SES identities are per-region. A domain verified in `us-east-1` does not exist in
`eu-west-1`, and the mistake is invisible until a send fails.

```
us-east-1        default choice, every feature ships here first
eu-west-1        if your customers' data must stay in the EU
```

Set it in the console's region picker and use the same value for `AWS_REGION`.

## 4. IAM user for the app

**IAM → Users → Create user**

- Name: `conversion-engine-ses`
- **Do not** give it console access — it is for the app, not a person
- **Attach policies directly → Create policy → JSON**, paste:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Sid": "Identities", "Effect": "Allow", "Action": [
        "ses:CreateEmailIdentity", "ses:GetEmailIdentity",
        "ses:DeleteEmailIdentity", "ses:ListEmailIdentities",
        "ses:PutEmailIdentityMailFromAttributes"
      ], "Resource": "*" },
    { "Sid": "ConfigSets", "Effect": "Allow", "Action": [
        "ses:CreateConfigurationSet", "ses:GetConfigurationSet",
        "ses:DeleteConfigurationSet",
        "ses:CreateConfigurationSetEventDestination",
        "ses:UpdateConfigurationSetEventDestination"
      ], "Resource": "*" },
    { "Sid": "Send", "Effect": "Allow", "Action": ["ses:SendEmail"], "Resource": "*" },
    { "Sid": "Account", "Effect": "Allow", "Action": ["ses:GetAccount"], "Resource": "*" }
  ]
}
```

Name it `conversion-engine-ses-policy`, attach it, create the user.

Then **the user → Security credentials → Create access key → Application running outside
AWS**. Copy both values now; the secret is shown once and never again.

## 5. SNS topic for bounces and complaints

AWS suspends accounts that ignore bounces, and this is also the delivery confirmation Gmail
never gives you.

**SNS → Topics → Create topic → Standard**, name `ses-events`. Copy the **Topic ARN**.

Leave the subscription until the app is deployed — the endpoint is
`https://your-app/api/ses/events`, and the app answers SNS's confirmation handshake by
itself.

The topic also needs to accept messages from SES. **Topic → Edit → Access policy**, add:

```json
{
  "Sid": "AllowSES",
  "Effect": "Allow",
  "Principal": { "Service": "ses.amazonaws.com" },
  "Action": "sns:Publish",
  "Resource": "<your topic ARN>"
}
```

## 6. Request production access — do this first

Every new account starts in the sandbox: 200 messages a day, one per second, and it will
only send to addresses you have verified. Useless for real leads.

**SES → Account dashboard → Request production access**

| Field | Answer |
| --- | --- |
| Mail type | Transactional |
| Website URL | Your deployed app, reachable, describing the product |
| Use case | See below |
| Compliance | Yes to all of it, and mean it |

Use case, which is what this deployment actually does:

> A platform that sends onboarding and lifecycle email on behalf of our customers, from
> domains they own and verify by publishing DKIM records to their own DNS. Per-customer
> sending caps are enforced in our engine before every send. Anyone who replies asking to
> stop is suppressed permanently across the whole account. Bounce and complaint events go
> to an SNS topic and are applied to the suppression list automatically, and any single
> customer's sending can be disabled without affecting the others.

Be honest here. "Cold outreach to purchased lists" is refused, and a first refusal costs
another day per attempt.

Expect an answer in about 24 hours. Approved accounts typically start at 50,000 a day and
14 per second; both are raised later on request, with sending history behind you.

## 7. Environment

```
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=...
SES_EVENT_TOPIC_ARN=arn:aws:sns:us-east-1:123456789012:ses-events
```

In `.env` locally, and in the Vercel project settings for the deployment. The Channels page
offers "your own domain" the moment the three AWS variables are set; the topic ARN is
optional and only wires up event reporting.

## 8. Prove it works

Domain verification runs in the sandbox, so all of this can be tested before AWS answers.

```bash
npm run ses:check                    # account state, region, sandbox or production
npm run ses:check -- yourdomain.com  # create the identity and print the DNS records
```

---

## What a customer does

Nothing in this file. They enter their domain, copy three CNAME records into their DNS, and
wait — the app polls until AWS confirms it, and turns their channel on by itself.

They also connect Gmail, which is not optional: SES sends and never receives, so replies
arrive in their normal mailbox and are read from there. A channel with a verified domain and
no mailbox stays degraded rather than sending mail whose answers nobody would ever see.

## Limits you are now living inside

| | Sandbox | Production, initially |
| --- | --- | --- |
| Per 24 hours | 200 | 50,000 |
| Per second | 1 | 14 |
| Recipients | Verified addresses only | Anyone |

| Rate | Consequence |
| --- | --- |
| Bounces over 5% | AWS reviews the account |
| Bounces over 10% | Sending suspended |
| Complaints over 0.1% | AWS reviews the account |
| Complaints over 0.5% | Sending suspended |

Those thresholds are account-wide. One customer's bad list is everybody's problem, which is
why the engine pauses a tenant's channel on its own complaint rate rather than waiting for
AWS to notice.

Cost is $0.10 per thousand messages, plus $0.12 per GB of attachments.
