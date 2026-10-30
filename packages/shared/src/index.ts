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

/** Vorm van de beheervelden; gedeeld door aanmaken, wijzigen en terugdraaien. */
const systemPromptSchema = z.string().min(1).max(4000);
const greetingSchema = z.string().min(1).max(500);
const openingQuestionSchema = z.string().max(300).nullable();
const widgetPositionSchema = z.enum(["bottom-right", "bottom-left"]);
const primaryColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const modelSchema = z.string().min(1).max(120);
const dailyBudgetSchema = z.number().min(0).max(10000);
const maxMessagesSchema = z.number().int().min(2).max(200);
const timezoneSchema = z.string().min(1).max(64);
/** 0 = nooit automatisch opruimen; 10 jaar is de bovengrens, verder is het geen termijn meer. */
const retentionDaysSchema = z.number().int().min(0).max(3650);

export const createSiteInput = z.object({
  name: z.string().min(1).max(120),
  domains: z.array(z.string().min(3).max(253)).min(1),
  systemPrompt: systemPromptSchema.optional(),
  greeting: greetingSchema.optional(),
  openingQuestion: openingQuestionSchema.optional(),
  widgetPosition: widgetPositionSchema.optional(),
  primaryColor: primaryColorSchema.optional(),
  model: modelSchema.optional(),
  dailyBudgetEur: dailyBudgetSchema.optional(),
  maxMessagesPerConversation: maxMessagesSchema.optional(),
  timezone: timezoneSchema.optional(),
  conversationRetentionDays: retentionDaysSchema.optional(),
  leadRetentionDays: retentionDaysSchema.optional(),
});
export type CreateSiteInput = z.infer<typeof createSiteInput>;

/**
 * PATCH: alleen wat meegaat wordt gewijzigd. Een lege body is een fout, geen no-op.
 * `domains` vervangt de hele lijst; dat is bewust, want samenvoegen laat je nooit domeinen
 * verwijderen zonder de hele lijst te sturen.
 */
export const updateSiteSettingsInput = z
  .object({
    name: z.string().min(1).max(120),
    domains: z.array(z.string().min(3).max(253)).min(1),
    systemPrompt: systemPromptSchema,
    greeting: greetingSchema,
    openingQuestion: openingQuestionSchema,
    widgetPosition: widgetPositionSchema,
    primaryColor: primaryColorSchema,
    model: modelSchema,
    dailyBudgetEur: dailyBudgetSchema,
    maxMessagesPerConversation: maxMessagesSchema,
    timezone: timezoneSchema,
    conversationRetentionDays: retentionDaysSchema,
    leadRetentionDays: retentionDaysSchema,
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: "minstens één veld" });
export type UpdateSiteSettingsInput = z.infer<typeof updateSiteSettingsInput>;

export const siteSettingsHistoryQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

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

/**
 * Wat de bezoeker zelf achterlaat. Minstens één contactweg, anders kan de sitehouder er niets mee.
 * Lege velden horen weggelaten te worden door de client; de API doet dat ook nog eens zelf.
 */
export const submitLeadInput = leadInput
  // Honeypot: onzichtbaar veld dat een mens nooit invult. Een bot die alle inputs vult, verraadt zich.
  .extend({ website: z.string().max(200).optional() })
  .strict()
  .refine((v) => Boolean(v.email || v.phone), { message: "minstens e-mail of telefoon" });
export type SubmitLeadInput = z.infer<typeof submitLeadInput>;

export const leadsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const conversationsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const deletionsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/** Inloggen op het dashboard. Eén operator, één wachtwoord uit de omgeving. */
export const dashboardLoginInput = z
  .object({
    password: z.string().min(1).max(200),
  })
  .strict();
export type DashboardLoginInput = z.infer<typeof dashboardLoginInput>;
