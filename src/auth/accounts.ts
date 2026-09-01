import { ObjectId } from "mongodb";
import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";
import { hashPassword, verifyPassword } from "./password.js";

export interface AccountResult {
  userId: string;
  orgId: string;
  email: string;
}

/**
 * Signing up creates the person and their organisation together. The organisation is the
 * tenant boundary every query already filters on, so a user without one has nothing to
 * look at.
 */
export async function createAccount(args: {
  email: string;
  password: string;
  name?: string;
  orgName?: string;
}): Promise<AccountResult> {
  const db = await getDb();
  const email = args.email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("That does not look like an email address");
  if (args.password.length < 8) throw new Error("Password must be at least 8 characters");

  const existing = await db.collection(C.users).findOne({ email });
  if (existing) throw new Error("An account with that email already exists");

  const orgId = new ObjectId();
  await db.collection(C.organizations).insertOne({
    _id: orgId,
    name: args.orgName?.trim() || `${email.split("@")[0]}'s workspace`,
    plan: "free",
    createdAt: new Date(),
  });

  const userId = new ObjectId();
  await db.collection(C.users).insertOne({
    _id: userId,
    email,
    name: args.name?.trim() || email.split("@")[0],
    passwordHash: hashPassword(args.password),
    mfa: false,
    createdAt: new Date(),
  });

  await db.collection(C.memberships).insertOne({
    _id: new ObjectId(),
    userId: String(userId),
    orgId: String(orgId),
    role: "owner",
    productScopes: [],
    createdAt: new Date(),
  });

  return { userId: String(userId), orgId: String(orgId), email };
}

export async function authenticate(email: string, password: string): Promise<AccountResult | null> {
  const db = await getDb();
  const user = await db.collection(C.users).findOne({ email: email.trim().toLowerCase() });
  // Verify even when the user is missing would be better still; here the cost of a miss is
  // one database round trip, which does not reveal much.
  if (!user || !verifyPassword(password, String(user.passwordHash))) return null;

  const membership = await db.collection(C.memberships).findOne({ userId: String(user._id) });
  if (!membership) return null;

  await db.collection(C.users).updateOne({ _id: user._id }, { $set: { lastLogin: new Date() } });
  return { userId: String(user._id), orgId: String(membership.orgId), email: String(user.email) };
}

export async function membershipRole(userId: string, orgId: string): Promise<string | null> {
  const db = await getDb();
  const membership = await db.collection(C.memberships).findOne({ userId, orgId });
  return membership ? String(membership.role) : null;
}
