import axios from "axios";
import { DialixaConfig, DialixaCallLock, DialixaRateBucket } from "../models/DialixaConfig.js";
import { CallLog } from "../models/CallLog.js";
import { User } from "../models/User.js";
import { Lead } from "../models/Lead.js";
import type { AuthenticatedUser } from "../types/auth.js";
import { operationsScope } from "../validators/operations.validator.js";
import { dialixaCallInput, normalizeDialixaNumber, validateDialixaBaseUrl } from "../validators/dialixa.validator.js";
import { decryptSecret } from "../utils/crypto.js";
import { AppError } from "../utils/AppError.js";

export const CALL_COOLDOWN_SECONDS = 20;
const duplicateKey = (error: unknown) => (error as { code?: number })?.code === 11000;

export async function getDialixaSession(userId: string) {
  const [config, agent] = await Promise.all([
    DialixaConfig.findById("dialixa").lean(),
    User.findById(userId).select("dialixaExtension dialerEnabled isActive").lean(),
  ]);
  const configured = !!(config?.apiBaseUrl && config?.keyConfigured);
  const enabled = !!config?.enabled;
  const extension = agent?.dialixaExtension || null;
  const canCall = !!(configured && enabled && agent?.isActive && agent.dialerEnabled && extension);
  return { provider: "dialixa", configured, enabled, extension, canCall, cooldownSeconds: CALL_COOLDOWN_SECONDS };
}

function replay(log: { callStatus: string; requestErrorCode?: string; toNumber: string }) {
  if (log.callStatus === "requested") return {
    accepted: true, status: "requested", number: log.toNumber,
    message: "Call request sent. Answer your Dialixa softphone to dial the customer.",
    cooldownSeconds: CALL_COOLDOWN_SECONDS,
  };
  throw new AppError(
    log.callStatus === "failed"
      ? "This call request was rejected. Check the previous error before submitting a new request."
      : "This request may already have reached Dialixa. Check your softphone before making another request.",
    409, log.requestErrorCode || "CALL_REQUEST_ALREADY_SUBMITTED",
  );
}

async function acquireAgentLock(userId: string) {
  const now = new Date();
  try {
    await DialixaCallLock.findOneAndUpdate(
      { _id: userId, expiresAt: { $lte: now } },
      { $set: { expiresAt: new Date(now.getTime() + CALL_COOLDOWN_SECONDS * 1000) } },
      { upsert: true, returnDocument: "after" },
    );
  } catch (error) {
    if (!duplicateKey(error)) throw error;
    throw new AppError("A call was just requested. Wait 20 seconds and check your softphone.", 429, "CALL_COOLDOWN");
  }
}

async function reserveRateSlot() {
  const minute = Math.floor(Date.now() / 60000);
  try {
    await DialixaRateBucket.findOneAndUpdate(
      { _id: String(minute), count: { $lt: 60 } },
      { $inc: { count: 1 }, $setOnInsert: { expiresAt: new Date((minute + 2) * 60000) } },
      { upsert: true, returnDocument: "after" },
    );
  } catch (error) {
    if (!duplicateKey(error)) throw error;
    throw new AppError("Dialixa's 60 requests per minute limit has been reached. Try again shortly.", 429, "DIALIXA_RATE_LIMIT");
  }
}

const upstreamErrors: Record<number, [number, string, string]> = {
  400: [400, "DIALIXA_CALL_REJECTED", "Dialixa could not start the call. Check that the number is allowed and your agent is not already on a call."],
  401: [502, "DIALIXA_INVALID_API_KEY", "Dialixa rejected the API key. Ask Head to update the Dialixa settings."],
  403: [403, "DIALIXA_ACCESS_DISABLED", "Dialixa API access is disabled, or the account or agent is inactive. Check the Dialixa panel."],
  404: [400, "DIALIXA_EXTENSION_NOT_FOUND", "This extension was not found in the Dialixa account. Ask Head or Admin to check your extension."],
  429: [429, "DIALIXA_RATE_LIMIT", "Dialixa's request limit has been reached. Wait a minute before trying again."],
};

export async function startDialixaCall(user: AuthenticatedUser, body: unknown) {
  const input = dialixaCallInput.parse(body);
  if (user.role === "employee" && !input.leadId) {
    throw new AppError("Employees can only call their assigned CRM leads.", 403, "ASSIGNED_LEAD_REQUIRED");
  }
  if (user.role !== "head" && !user.branches.length) {
    throw new AppError("Your account is not assigned to a branch.", 403, "BRANCH_NOT_ASSIGNED");
  }
  const lead = input.leadId ? await Lead.findOne({
    _id: input.leadId, isDeleted: false, ...operationsScope(user),
  }).lean() : null;
  if (input.leadId && !lead) throw new AppError("Lead not found or not assigned to you.", 404, "LEAD_NOT_FOUND");

  let number: string;
  try {
    // Lead phone fields are stored as country code + national number in the CRM.
    number = normalizeDialixaNumber(lead ? `${lead.phoneCountryCode}${lead.phone}` : input.number!);
    if (lead && input.number && normalizeDialixaNumber(input.number) !== number) {
      throw new Error("The phone number does not match the selected lead");
    }
  } catch (error) { throw new AppError((error as Error).message, 400, "INVALID_PHONE_NUMBER"); }

  const callId = `dialixa:${user.id}:${input.requestId}`;
  const existing = await CallLog.findOne({ callId }).lean();
  if (existing) {
    if (existing.toNumber !== number || String(existing.lead || "") !== (input.leadId || "")) {
      throw new AppError("Use a new request ID for a different call.", 409, "REQUEST_ID_CONFLICT");
    }
    return replay(existing);
  }

  const [config, agent] = await Promise.all([
    DialixaConfig.findById("dialixa").select("+apiKeyEncrypted").lean(),
    User.findById(user.id).select("dialixaExtension dialerEnabled isActive").lean(),
  ]);
  if (!config?.enabled || !config.apiBaseUrl || !config.apiKeyEncrypted) {
    throw new AppError("Dialixa has not been enabled by Head. Complete Dialer setup first.", 503, "DIALIXA_NOT_CONFIGURED");
  }
  if (!agent?.isActive || !agent.dialerEnabled || !agent.dialixaExtension) {
    throw new AppError("Your Dialixa extension is not enabled. Contact Head or Admin.", 403, "DIALIXA_AGENT_DISABLED");
  }

  let apiKey: string;
  let apiBaseUrl: string;
  try {
    apiBaseUrl = validateDialixaBaseUrl(config.apiBaseUrl);
    apiKey = decryptSecret(config.apiKeyEncrypted);
  } catch {
    throw new AppError("The saved Dialixa configuration cannot be used. Ask Head to save the API settings again.", 503, "DIALIXA_CONFIG_ERROR");
  }

  await acquireAgentLock(user.id);
  try {
    await CallLog.create({
      callId, caller: user.id, lead: lead?._id,
      branch: lead?.branch || user.branches[0],
      provider: "dialixa", fromNumber: agent.dialixaExtension,
      toNumber: number, callStatus: "requesting", duration: 0,
    });
  } catch (error) {
    await DialixaCallLock.deleteOne({ _id: user.id });
    if (duplicateKey(error)) throw new AppError("This call request has already been submitted.", 409, "CALL_REQUEST_ALREADY_SUBMITTED");
    throw error;
  }

  try { await reserveRateSlot(); }
  catch (error) {
    await CallLog.updateOne({ callId }, { $set: { callStatus: "failed", requestErrorCode: "DIALIXA_RATE_LIMIT" } });
    await DialixaCallLock.deleteOne({ _id: user.id });
    throw error;
  }

  let upstreamStatus: number | undefined;
  try {
    const response = await axios.post(`${apiBaseUrl}/api/v1/public/click-to-call`, {
      extension: agent.dialixaExtension, number,
      ...((lead?.name || input.contactName) ? { contactName: lead?.name || input.contactName } : {}),
    }, {
      headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
      timeout: 15000,
      maxRedirects: 0,
      maxContentLength: 65536,
      validateStatus: () => true,
    });
    upstreamStatus = response.status;
  } catch {
    // Do not log/return Axios errors: they contain the secret request header.
    // A timeout is ambiguous, so this request ID must never be retried upstream.
  }

  if (upstreamStatus !== 200) {
    const known = upstreamStatus ? upstreamErrors[upstreamStatus] : undefined;
    const [httpStatus, code, message] = known || [
      504, "DIALIXA_OUTCOME_UNKNOWN",
      "Dialixa did not confirm the request. It may still ring your softphone. Check Dialixa before placing another call.",
    ];
    await CallLog.updateOne({ callId }, { $set: {
      callStatus: known ? "failed" : "unknown", requestErrorCode: code,
    } });
    if (known) await DialixaCallLock.deleteOne({ _id: user.id });
    throw new AppError(message, httpStatus, code);
  }

  // Acceptance only: no invented answer state, duration, recording or provider call ID.
  // If this DB write fails, the existing "requesting" row still prevents a duplicate.
  await CallLog.updateOne({ callId }, { $set: { callStatus: "requested" } });
  return replay({ callStatus: "requested", toNumber: number });
}
