import type { SupabaseClient } from '@supabase/supabase-js';
import { cloudClient as baileysAdapter } from './whatsapp-cloud-client.js';
import { ConversationStateTracker } from './conversation-state-tracker.js';

/**
 * LeadQualificationEngine
 *
 * Translates AI-inferred lead scores (A / B / C) into structured qualification
 * records, drives stage progression, and schedules context-aware follow-ups.
 *
 * Stakeholder requirement (sprint-1 on-site visit):
 *  - "Hot lead" was previously defined by rep gut-feel; needed objective,
 *    auditable scoring tied to actual conversation signals.
 *  - Follow-up frequency should reflect urgency: A-leads get a 4-hour nudge,
 *    B-leads get next-day, C-leads get 3-day re-engagement.
 *
 * Called from pipeline-service.ts after analyzeMessage() returns analysis.
 */

export type LeadScore = 'A' | 'B' | 'C';
export type LeadStage = 'new' | 'engaged' | 'qualified' | 'negotiating' | 'closed' | 'lost';

export interface QualificationResult {
  leadId: string;
  score: LeadScore;
  stage: LeadStage;
  followUpScheduledAt: string | null;
  isNewLead: boolean;
}

/** Hours until automatic follow-up, keyed by lead score */
const FOLLOW_UP_HOURS: Record<LeadScore, number> = {
  A: 4,   // hot lead – quick nudge
  B: 24,  // warm lead – next day
  C: 72,  // cold lead – 3-day re-engagement
};

/** Follow-up message templates (English + Hindi variants) */
const FOLLOW_UP_TEMPLATES: Record<LeadScore, { en: string; hi: string }> = {
  A: {
    en: "Hi {name}! Just checking in – are you still interested in {product}? We'd love to help you get the best deal. 🚗",
    hi: "Namaste {name}! Kya aap abhi bhi {product} mein interested hain? Hum aapko best deal dene mein khushi honge! 🚗",
  },
  B: {
    en: "Hello {name}! We have some great options for you. When would be a good time to discuss? 😊",
    hi: "Hello {name}! Hamare paas aapke liye kuch acche options hain. Kab baat karna theek rahega?",
  },
  C: {
    en: "Hi {name}! Just a quick note – we have new arrivals that might interest you. Feel free to reach out anytime!",
    hi: "Hi {name}! Hamare paas kuch nayi gaadiyaan aayi hain jo aapko pasand aa sakti hain. Kabhi bhi contact karein!",
  },
};

export class LeadQualificationEngine {
  private stateTracker: ConversationStateTracker;

  constructor(private supabase: SupabaseClient) {
    this.stateTracker = new ConversationStateTracker(supabase);
  }

  /**
   * Upsert lead record, advance conversation stage, and schedule follow-up.
   * Returns qualification result for pipeline audit log.
   */
  async qualify(params: {
    userId: string;
    conversationId: string;
    customerJid: string;
    customerName: string;
    score: LeadScore;
    intent: string;
    productInterest: string | null;
    languageDetected: string;
    sentimentPolarity?: number;
  }): Promise<QualificationResult> {
    const {
      userId, conversationId, customerJid, customerName,
      score, intent, productInterest, languageDetected, sentimentPolarity = 0,
    } = params;

    // 1. Upsert the lead record
    const { data: existing } = await this.supabase
      .from('wb_leads')
      .select('id, score, stage')
      .eq('conversation_id', conversationId)
      .eq('user_id', userId)
      .maybeSingle();

    let leadId: string;
    let isNewLead = false;

    if (existing) {
      // Only upgrade score, never downgrade (sprint-1 stakeholder feedback)
      const upgradeMap: Record<LeadScore, number> = { A: 3, B: 2, C: 1 };
      const shouldUpgrade = upgradeMap[score] > upgradeMap[existing.score as LeadScore];

      const { data: updated } = await this.supabase
        .from('wb_leads')
        .update({
          ...(shouldUpgrade ? { score } : {}),
          last_intent: intent,
          product_interest: productInterest,
          updated_at: new Date().toISOString(),
        })
        .eq('id', existing.id)
        .select('id')
        .single();

      leadId = updated?.id ?? existing.id;
    } else {
      const { data: inserted } = await this.supabase
        .from('wb_leads')
        .insert({
          user_id: userId,
          conversation_id: conversationId,
          customer_jid: customerJid,
          customer_name: customerName,
          score,
          stage: 'new',
          last_intent: intent,
          product_interest: productInterest,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .select('id')
        .single();

      leadId = inserted?.id ?? '';
      isNewLead = true;
    }

    // 2. Advance conversation stage via state tracker
    await this.stateTracker.advanceStage(conversationId, userId, score, 'ai', qualify: score=);

    // 3. Update rolling sentiment
    if (sentimentPolarity !== 0) {
      await this.stateTracker.updateSentiment(conversationId, userId, sentimentPolarity);
    }

    // 4. Schedule follow-up (overwrite if score improved)
    const followUpHours = FOLLOW_UP_HOURS[score];
    const followUpAt = new Date(Date.now() + followUpHours * 60 * 60 * 1000);
    await this.stateTracker.scheduleFollowUp(
      conversationId, userId, followUpAt,
      score- follow-up
    );

    console.log(
      [LeadQualEngine]  | score= | follow-up in h | newLead=
    );

    return {
      leadId,
      score,
      stage: existing?.stage ?? 'new',
      followUpScheduledAt: followUpAt.toISOString(),
      isNewLead,
    };
  }

  /**
   * Execute scheduled follow-ups for a given user.
   * Called by cron-service.ts – sends templated WhatsApp message and
   * clears follow_up_at so the same conversation isn't triggered again
   * until the next qualification cycle.
   */
  async runDueFollowUps(userId: string): Promise<number> {
    const due = await this.stateTracker.getDueFollowUps(userId);
    let sent = 0;

    for (const conv of due) {
      try {
        const { data: lead } = await this.supabase
          .from('wb_leads')
          .select('score, product_interest')
          .eq('conversation_id', conv.id)
          .eq('user_id', userId)
          .maybeSingle();

        if (!lead) continue;

        const score = (lead.score ?? 'C') as LeadScore;
        const isHindi = conv.customer_jid.includes('91') &&
          (conv.summary ?? '').match(/\b(hai|hain|mujhe|kya|nahi)\b/i);

        const template = FOLLOW_UP_TEMPLATES[score][isHindi ? 'hi' : 'en'];
        const message = template
          .replace('{name}', conv.customer_name || 'there')
          .replace('{product}', lead.product_interest || 'the vehicle');

        await baileysAdapter.sendMessage(userId, conv.customer_jid, message);
        sent++;

        // Clear follow_up_at so this won't re-trigger until next qualify()
        await this.supabase
          .from('wb_conversations')
          .update({ follow_up_at: null, updated_at: new Date().toISOString() })
          .eq('id', conv.id)
          .eq('user_id', userId);

        console.log([LeadQualEngine] Follow-up sent to  (score=));
      } catch (err: any) {
        console.error([LeadQualEngine] Follow-up failed for :, err.message);
      }
    }

    return sent;
  }
}
