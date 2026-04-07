import type { SupabaseClient } from '@supabase/supabase-js';
import { LeadQualificationEngine } from './lead-qualification-engine.js';
import { cloudClient as baileysAdapter } from './whatsapp-cloud-client.js';

/**
 * CronOrchestrator
 *
 * Central scheduler for all time-driven agentic tasks:
 *   1. Lead follow-up sweep (every 30 min) – fires templated WA message to
 *      all conversations where follow_up_at <= now
 *   2. Stale lead re-engagement (daily 09:00) – pushes C-score leads
 *      dormant > 7 days back into the pipeline with a soft nudge
 *   3. Conversation summary digest (daily 18:00) – posts day's lead
 *      activity summary to each user's dashboard (stored in wb_digests)
 *
 * Requirement origin (on-site client visit + stakeholder sign-off, sprint-3):
 *   - 30 % lead loss due to missed follow-ups → automated scheduling
 *   - Floor manager wanted end-of-day digest to replace manual WhatsApp
 *     group status updates
 *
 * Architecture: pure in-process setInterval timers, consistent with existing
 * reminder-service.ts pattern. For production scale (> 1000 conversations),
 * migrate to pg_cron + queue (noted in MASTER_PLAN.md Phase 5).
 */

export class CronOrchestrator {
  private timers: NodeJS.Timeout[] = [];
  private leadEngine: LeadQualificationEngine;

  constructor(private supabase: SupabaseClient) {
    this.leadEngine = new LeadQualificationEngine(supabase);
  }

  /** Start all scheduled jobs. Call once at server startup. */
  start(): void {
    console.log('[CronOrchestrator] Starting scheduled jobs...');

    // Job 1: Follow-up sweep every 30 minutes
    this.timers.push(
      setInterval(() => this.runFollowUpSweep(), 30 * 60 * 1000)
    );

    // Job 2: Stale lead re-engagement – daily at 09:00 local (approx)
    this.scheduleDaily(9, 0, () => this.runStaleLeadReengagement());

    // Job 3: End-of-day digest – daily at 18:00 local
    this.scheduleDaily(18, 0, () => this.runDailyDigest());

    console.log('[CronOrchestrator] 3 jobs scheduled (follow-up sweep, stale re-engagement, daily digest)');
  }

  /** Stop all jobs cleanly (e.g. on graceful shutdown). */
  stop(): void {
    this.timers.forEach(t => clearTimeout(t));
    this.timers = [];
    console.log('[CronOrchestrator] All scheduled jobs stopped');
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Job implementations
  // ──────────────────────────────────────────────────────────────────────────

  /** Job 1: Run follow-up messages for all due conversations across all users */
  private async runFollowUpSweep(): Promise<void> {
    console.log('[CronOrchestrator] Running follow-up sweep...');
    try {
      const { data: users } = await this.supabase
        .from('wb_users')
        .select('id')
        .eq('auto_reply_enabled', true);

      let totalSent = 0;
      for (const user of users || []) {
        const sent = await this.leadEngine.runDueFollowUps(user.id);
        totalSent += sent;
      }

      if (totalSent > 0) {
        console.log([CronOrchestrator] Follow-up sweep complete:  message(s) sent);
      }
    } catch (err: any) {
      console.error('[CronOrchestrator] Follow-up sweep error:', err.message);
    }
  }

  /**
   * Job 2: Re-engage C-score leads dormant for > 7 days with a low-pressure
   * outreach. Prevents cold leads from fully dropping off without any touchpoint.
   * Agreed with floor manager (sprint-3): one re-engagement attempt max per
   * lead per week (rate_limited_at column).
   */
  private async runStaleLeadReengagement(): Promise<void> {
    console.log('[CronOrchestrator] Running stale lead re-engagement...');
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    try {
      const { data: staleLeads } = await this.supabase
        .from('wb_leads')
        .select('id, user_id, customer_jid, customer_name, product_interest, score')
        .eq('score', 'C')
        .lt('updated_at', sevenDaysAgo)
        .is('rate_limited_at', null) // not already re-engaged this week
        .limit(50); // process in batches

      for (const lead of staleLeads || []) {
        try {
          const msg = Hi ! We noticed you were looking at  with us a while back. We have fresh inventory you might love – feel free to reach out! 🚗;

          await baileysAdapter.sendMessage(lead.user_id, lead.customer_jid, msg);

          // Mark re-engagement time to avoid repeat within same week
          await this.supabase
            .from('wb_leads')
            .update({ rate_limited_at: new Date().toISOString() })
            .eq('id', lead.id);

          console.log([CronOrchestrator] Re-engagement sent to );
        } catch (err: any) {
          console.error([CronOrchestrator] Re-engagement failed for :, err.message);
        }
      }
    } catch (err: any) {
      console.error('[CronOrchestrator] Stale lead job error:', err.message);
    }
  }

  /**
   * Job 3: Build end-of-day digest per user and store in wb_digests.
   * Floor manager requested this in sprint-3 to replace manual WhatsApp
   * group status updates with an automated summary.
   */
  private async runDailyDigest(): Promise<void> {
    console.log('[CronOrchestrator] Generating daily digests...');
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    try {
      const { data: users } = await this.supabase.from('wb_users').select('id, business_name');

      for (const user of users || []) {
        const { data: stats } = await this.supabase
          .from('wb_leads')
          .select('score, stage')
          .eq('user_id', user.id)
          .gte('updated_at', today.toISOString());

        const summary = {
          user_id: user.id,
          date: today.toISOString().split('T')[0],
          new_leads: (stats || []).filter(l => l.stage === 'new').length,
          hot_leads: (stats || []).filter(l => l.score === 'A').length,
          warm_leads: (stats || []).filter(l => l.score === 'B').length,
          cold_leads: (stats || []).filter(l => l.score === 'C').length,
          generated_at: new Date().toISOString(),
        };

        await this.supabase.from('wb_digests').upsert(summary, { onConflict: 'user_id,date' });
        console.log(
          [CronOrchestrator] Digest for : A / B / C
        );
      }
    } catch (err: any) {
      console.error('[CronOrchestrator] Daily digest error:', err.message);
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Helpers
  // ──────────────────────────────────────────────────────────────────────────

  /** Schedule a job to run at a specific hour:minute local time every day */
  private scheduleDaily(hour: number, minute: number, job: () => void): void {
    const now = new Date();
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);

    const delay = next.getTime() - now.getTime();

    const timer = setTimeout(() => {
      job();
      // Re-schedule for next day (24 h interval)
      this.timers.push(setInterval(job, 24 * 60 * 60 * 1000));
    }, delay);

    this.timers.push(timer);
  }
}
