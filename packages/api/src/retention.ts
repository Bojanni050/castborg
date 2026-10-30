import type { PoolClient } from "pg";
import type { Actor, Db } from "./db/tenant.js";
import { withTenant } from "./db/tenant.js";
import { logEvent } from "./log.js";

/**
 * Het verwijderpad.
 *
 * Twee dingen zijn hier bewust zo:
 *
 * 1. Verwijderen gebeurt altijd binnen een tenant-transactie. Er is geen pad dat over sites heen
 *    wist, ook niet voor de beheerder: de sitelijst is een leesfunctie, geen schrijffunctie.
 * 2. Elke verwijdering laat een regel achter in `deletion_log` met aantallen en geen inhoud. Dat
 *    is wat je een klant kunt laten zien als hij vraagt of je je bewaartermijn uitvoert.
 *
 * Wat er met de rest gebeurt als een gesprek verdwijnt, is geen toeval maar het schema:
 * berichten cascaden mee, een lead blijft bestaan maar raakt zijn gesprek kwijt
 * (`ON DELETE SET NULL`), en `usage_events` houdt de kosten met een lege `conversation_id`. Zo
 * verdwijnt de inhoud terwijl de administratie blijft kloppen.
 */

export interface DeletionCounts {
  conversations: number;
  messages: number;
  leads: number;
}

export interface ConversationDeletion extends DeletionCounts {
  /** Leads die niet zijn verwijderd maar hun gesprek kwijt zijn. */
  leadsDetached: number;
}

export interface RetentionOutcome extends DeletionCounts {
  conversationRetentionDays: number;
  leadRetentionDays: number;
}

async function logDeletion(
  q: PoolClient,
  siteId: string,
  source: "manual" | "retention",
  subject: "conversation" | "lead",
  counts: DeletionCounts,
  actor: Actor,
): Promise<void> {
  await q.query(
    `INSERT INTO deletion_log (site_id, source, subject, conversations, messages, leads, actor_type, actor_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [siteId, source, subject, counts.conversations, counts.messages, counts.leads, actor.type, actor.id],
  );
}

/**
 * Verwijdert één gesprek met alle berichten. Geeft `null` als het gesprek niet bestaat (of van een
 * andere site is: RLS maakt dat hetzelfde antwoord, en dat is de bedoeling).
 */
export async function deleteConversation(
  db: Db,
  siteId: string,
  conversationId: string,
  actor: Actor,
): Promise<ConversationDeletion | null> {
  return withTenant(
    db,
    siteId,
    async (q) => {
      const exists = await q.query("SELECT 1 FROM conversations WHERE id = $1", [conversationId]);
      if (exists.rowCount === 0) return null;

      const messages = (
        await q.query<{ n: string }>("SELECT count(*)::text AS n FROM messages WHERE conversation_id = $1", [conversationId])
      ).rows[0]!.n;
      const leads = (
        await q.query<{ n: string }>("SELECT count(*)::text AS n FROM leads WHERE conversation_id = $1", [conversationId])
      ).rows[0]!.n;

      await q.query("DELETE FROM messages WHERE conversation_id = $1", [conversationId]);
      await q.query("DELETE FROM conversations WHERE id = $1", [conversationId]);

      const counts: DeletionCounts = { conversations: 1, messages: Number(messages), leads: 0 };
      await logDeletion(q, siteId, "manual", "conversation", counts, actor);

      logEvent("info", "conversation_deleted", {
        siteId,
        conversationId,
        messages: counts.messages,
        leadsDetached: Number(leads),
        actor: actor.id,
      });

      return { ...counts, leadsDetached: Number(leads) };
    },
    actor,
  );
}

/** Verwijdert één lead (de contactgegevens). Het gesprek blijft staan. */
export async function deleteLead(db: Db, siteId: string, leadId: string, actor: Actor): Promise<boolean> {
  return withTenant(
    db,
    siteId,
    async (q) => {
      const deleted = await q.query("DELETE FROM leads WHERE id = $1 RETURNING id", [leadId]);
      if (deleted.rowCount === 0) return false;
      await logDeletion(q, siteId, "manual", "lead", { conversations: 0, messages: 0, leads: 1 }, actor);
      logEvent("info", "lead_deleted", { siteId, leadId, actor: actor.id });
      return true;
    },
    actor,
  );
}

/**
 * Past de bewaartermijnen van één site toe. Termijn 0 betekent: niets doen. Een gesprek is te oud
 * op basis van `updated_at` (laatste activiteit), een lead op basis van `created_at`.
 */
export async function runRetention(db: Db, siteId: string, actor: Actor): Promise<RetentionOutcome> {
  return withTenant(
    db,
    siteId,
    async (q) => {
      const settings = (
        await q.query<{ conversation_retention_days: number; lead_retention_days: number }>(
          "SELECT conversation_retention_days, lead_retention_days FROM site_settings WHERE site_id = $1",
          [siteId],
        )
      ).rows[0];

      if (!settings) {
        return { conversations: 0, messages: 0, leads: 0, conversationRetentionDays: 0, leadRetentionDays: 0 };
      }

      const outcome: RetentionOutcome = {
        conversations: 0,
        messages: 0,
        leads: 0,
        conversationRetentionDays: settings.conversation_retention_days,
        leadRetentionDays: settings.lead_retention_days,
      };

      if (settings.conversation_retention_days > 0) {
        // Eén statement met twee CTE's: dezelfde snapshot, dus de telling hoort bij wat er weg gaat.
        const swept = (
          await q.query<{ conversations: number; messages: number }>(
            `WITH doomed AS (
               SELECT id FROM conversations
                WHERE updated_at < now() - make_interval(days => $1)
             ),
             gone_messages AS (
               DELETE FROM messages WHERE conversation_id IN (SELECT id FROM doomed) RETURNING 1
             ),
             gone AS (
               DELETE FROM conversations WHERE id IN (SELECT id FROM doomed) RETURNING 1
             )
             SELECT (SELECT count(*)::int FROM gone) AS conversations,
                    (SELECT count(*)::int FROM gone_messages) AS messages`,
            [settings.conversation_retention_days],
          )
        ).rows[0]!;

        outcome.conversations = swept.conversations;
        outcome.messages = swept.messages;
        await logDeletion(q, siteId, "retention", "conversation", {
          conversations: swept.conversations,
          messages: swept.messages,
          leads: 0,
        }, actor);
      }

      if (settings.lead_retention_days > 0) {
        const gone = (
          await q.query<{ leads: number }>(
            `WITH gone AS (
               DELETE FROM leads WHERE created_at < now() - make_interval(days => $1) RETURNING 1
             )
             SELECT count(*)::int AS leads FROM gone`,
            [settings.lead_retention_days],
          )
        ).rows[0]!;
        outcome.leads = gone.leads;
        await logDeletion(q, siteId, "retention", "lead", { conversations: 0, messages: 0, leads: gone.leads }, actor);
      }

      logEvent("info", "retention_run", {
        siteId,
        conversations: outcome.conversations,
        messages: outcome.messages,
        leads: outcome.leads,
        actor: actor.id,
      });

      return outcome;
    },
    actor,
  );
}
