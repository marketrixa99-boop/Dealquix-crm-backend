import { z } from "zod";
import { objectId } from "./operations.validator.js";

export function validateDialixaBaseUrl(value: string) {
  const url = new URL(value);
  const extraHosts = (process.env.DIALIXA_ALLOWED_API_HOSTS || "")
    .split(",").map((host) => host.trim().toLowerCase()).filter(Boolean);
  const trustedHost = url.hostname === "voxentroconsulting.com" ||
    url.hostname.endsWith(".voxentroconsulting.com") || extraHosts.includes(url.hostname);
  if (url.protocol !== "https:" || !trustedHost || url.username || url.password ||
      url.search || url.hash || (url.port && url.port !== "443") ||
      (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error("Use the HTTPS API base URL from Dialixa. Additional provider hosts must be allowed by the server administrator.");
  }
  return url.origin;
}

export const dialixaSettingsInput = z.object({
  enabled: z.boolean(),
  apiBaseUrl: z.string().trim().url().transform((value, ctx) => {
    try { return validateDialixaBaseUrl(value); }
    catch (error) {
      ctx.addIssue({ code: "custom", message: (error as Error).message });
      return z.NEVER;
    }
  }),
  apiKey: z.string().trim().min(1).max(4096).regex(/^[^\r\n]+$/).optional(),
}).strict();

export const dialixaAgentInput = z.object({
  extension: z.string().trim().regex(/^\d{2,20}$/, "Extension must contain 2 to 20 digits").nullable(),
  enabled: z.boolean(),
}).strict().refine((value) => !value.enabled || !!value.extension,
  "Assign an extension before enabling calling");

export const dialixaCallInput = z.object({
  requestId: z.string().uuid(),
  leadId: objectId.optional(),
  number: z.string().trim().max(32).optional(),
  contactName: z.string().trim().max(150).optional(),
}).strict().refine((value) => !!(value.leadId || value.number), "Choose a lead or enter a phone number");

export function normalizeDialixaNumber(raw: string) {
  if (!/^\+?[\d\s().-]+$/.test(raw)) throw new Error("Enter a valid phone number");
  const number = raw.replace(/\D/g, "");
  if (!/^[1-9]\d{6,14}$/.test(number)) throw new Error("Phone number must contain 7 to 15 digits");
  return number;
}
