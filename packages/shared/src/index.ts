import { z } from "zod";

export const conversationStage = z.enum([
  "discovery",
  "qualification",
  "conversion",
  "completed",
]);
export type ConversationStage = z.infer<typeof conversationStage>;

export const leadStatus = z.enum(["new", "contacted", "qualified", "won", "lost"]);
export type LeadStatus = z.infer<typeof leadStatus>;

/** Publieke widget-sleutel: identificeert een site, geeft GEEN toegang tot privégegevens. */
export const publicSiteKey = z.string().regex(/^pk_[a-z0-9]{24}$/);

export const widgetConfigResponse = z.object({
  siteKey: publicSiteKey,
  greeting: z.string().max(500),
  openingQuestion: z.string().max(300).nullable(),
  position: z.enum(["bottom-right", "bottom-left"]),
  primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
});
export type WidgetConfigResponse = z.infer<typeof widgetConfigResponse>;

export const createSiteInput = z.object({
  name: z.string().min(1).max(120),
  domains: z.array(z.string().min(3).max(253)).min(1),
});
export type CreateSiteInput = z.infer<typeof createSiteInput>;

export const sendMessageInput = z.object({
  conversationId: z.string().uuid().optional(),
  text: z.string().min(1).max(2000),
  pageUrl: z.string().url().max(2048).optional(),
});
export type SendMessageInput = z.infer<typeof sendMessageInput>;

export const leadInput = z.object({
  name: z.string().min(1).max(200).optional(),
  email: z.string().email().max(320).optional(),
  phone: z.string().max(40).optional(),
  message: z.string().max(4000).optional(),
});
export type LeadInput = z.infer<typeof leadInput>;
