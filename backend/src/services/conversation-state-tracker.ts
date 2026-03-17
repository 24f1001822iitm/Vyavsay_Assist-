import { SupabaseClient } from '@supabase/supabase-js';

/**
 * ConversationStateTracker
 *
 * Tracks per-conversation state for the agentic follow-up workflow:
 *   - Stage progression: new → engaged → qualified → negotiating → closed | lost
 *   - AI pause flag (human takeover)
 *   - Follow-up scheduling metadata
 *   - Sentiment trend (rolling 5-message window)
 *
 * This class was introduced after on-site stakeholder visits revealed that
 * sales reps lost 30 % of leads due to missed follow-ups and lacked a unified
 * view of where each customer was in the buying journey.
 *
 * Design decisions (from sprint-2 review with floor manager):
 *  - Stage transitions are one-directional and logged for audit
 *  - ai_paused is sticky until manually cleared from dashboard
 *  - Sentiment trend drives cron re-engagement priority
 */

export type ConversationStage =
  | 'new'
  | 'engaged'
  | 'qualified'
  | 'negotiating'
  | 'closed'
  | 'lost';

export interface ConversationSnapshot {
  id: string;
  user_id: string;
  customer_jid: string;
  customer_name: string;
  stage: ConversationStage;
  ai_paused: boolean;
  last_message_at: string;
  summary: string | null;
  follow_up_at: string | null;
  sentiment_polarity: number | null; // rolling avg, -1 to 1
}

export interface StageTransitionEvent {
  conversation_id: string;
  from_stage: ConversationStage;
  to_stage: ConversationStage;
  triggered_by: 'ai' | 'human';
  reason: string;
  timestamp: string;
}

/** Lead score returned by ai-router, mapped from letter to priority weight */
const SCORE_TO_STAGE_HINT: Record<string, ConversationStage> = {
  A: 'qualified',
  B: 'engaged',
  C: 'new',
};

export class ConversationStateTracker {
  constructor(private supabase: SupabaseClient) {}

  /**
   * Advance the conversation stage based on AI-inferred lead score.
   * Never demotes a stage (new→engaged is fine; engaged→new is not).
   */
  async advanceStage(
    conversationId: string,
    userId: string,
    leadScore: string,
    triggeredBy: 'ai' | 'human' = 'ai',
    reason = 'lead score update'
  ): Promise<void> {
    const { data: conv } = await this.supabase
      .from('wb_conversations')
      .select('id, stage')
      .eq('id', conversationId)
      .eq('user_id', userId)
      .single();

    if (!conv) return;

    const current = conv.stage as ConversationStage;
    const suggested = SCORE_TO_STAGE_HINT[leadScore] ?? 'new';

    const STAGE_ORDER: ConversationStage[] = [
      'new', 'engaged', 'qualified', 'negotiating', 'closed', 'lost',
    ];

    const currentIdx = STAGE_ORDER.indexOf(current);
    const suggestedIdx = STAGE_ORDER.indexOf(suggested);

    // Only advance, never demote (stakeholder requirement: reps found
    // unexpected demotions confusing during sprint-1 review)
    if (suggestedIdx <= currentIdx) return;

    const event: StageTransitionEvent = {
      conversation_id: conversationId,
      from_stage: current,
      to_stage: suggested,
      triggered_by: triggeredBy,
      reason,
      timestamp: new Date().toISOString(),
    };

    await Promise.all([
      this.supabase
        .from('wb_conversations')
        .update({ stage: suggested, updated_at: new Date().toISOString() })
        .eq('id', conversationId)
        .eq('user_id', userId),

      // Persist transition event for audit trail
      this.supabase.from('wb_conversation_events').insert(event).select(),
    ]);

    console.log(
      [ConvStateTracker]  stage:  →  ()
    );
  }

  /**
   * Schedule an automatic follow-up for a conversation.
   * Overwrites any existing follow_up_at so the latest intent wins.
   */
  async scheduleFollowUp(
    conversationId: string,
    userId: string,
    followUpAt: Date,
    reason: string
  ): Promise<void> {
    await this.supabase
      .from('wb_conversations')
      .update({
        follow_up_at: followUpAt.toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', conversationId)
      .eq('user_id', userId);

    console.log(
      [ConvStateTracker] Follow-up scheduled for  at  ()
    );
  }

  /**
   * Update rolling sentiment polarity (simple exponential moving average,
   * α = 0.3 so recent messages weigh more).
   */
  async updateSentiment(
    conversationId: string,
    userId: string,
    newPolarity: number
  ): Promise<void> {
    const { data: conv } = await this.supabase
      .from('wb_conversations')
      .select('sentiment_polarity')
      .eq('id', conversationId)
      .eq('user_id', userId)
      .single();

    const prev = conv?.sentiment_polarity ?? 0;
    const alpha = 0.3;
    const updated = alpha * newPolarity + (1 - alpha) * prev;

    await this.supabase
      .from('wb_conversations')
      .update({ sentiment_polarity: updated, updated_at: new Date().toISOString() })
      .eq('id', conversationId)
      .eq('user_id', userId);
  }

  /**
   * Fetch all conversations due for follow-up (follow_up_at <= now)
   * that are not ai_paused and not in terminal stage.
   * Called by cron-service.ts daily sweep.
   */
  async getDueFollowUps(userId: string): Promise<ConversationSnapshot[]> {
    const { data, error } = await this.supabase
      .from('wb_conversations')
      .select('*')
      .eq('user_id', userId)
      .lte('follow_up_at', new Date().toISOString())
      .eq('ai_paused', false)
      .not('stage', 'in', '("closed","lost")')
      .order('follow_up_at', { ascending: true });

    if (error) {
      console.error('[ConvStateTracker] getDueFollowUps error:', error);
      return [];
    }

    return (data || []) as ConversationSnapshot[];
  }
}
