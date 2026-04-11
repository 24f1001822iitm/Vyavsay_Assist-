import type { FastifyInstance, FastifyPluginAsync } from 'fastify';

/**
 * Analytics Routes – /api/analytics
 *
 * Exposes aggregated metrics that feed the dashboard's "Sales Pulse" panel.
 * Introduced after sprint-2 stakeholder visit: floor manager + accounts team
 * were pulling numbers from 3 separate branch spreadsheets daily; this API
 * replaces that manual consolidation.
 *
 * All queries respect row-level security (user_id filter) – each branch sees
 * only its own data unless the caller holds a group-owner JWT (not yet
 * implemented; tracked in MASTER_PLAN.md §6.3).
 */

export const analyticsRoutes: FastifyPluginAsync = async (server: FastifyInstance) => {

  /**
   * GET /api/analytics/lead-funnel
   * Returns lead counts by score (A/B/C) and stage for the authenticated user.
   * Used by dashboard LeadFunnel widget.
   */
  server.get('/lead-funnel', async (request, reply) => {
    const { from, to } = request.query as { from?: string; to?: string };
    const userId = request.userId;

    try {
      let query = server.supabase
        .from('wb_leads')
        .select('score, stage, created_at')
        .eq('user_id', userId);

      if (from) query = query.gte('created_at', from);
      if (to)   query = query.lte('created_at', to);

      const { data, error } = await query;
      if (error) return reply.status(500).send({ error: 'Failed to fetch lead funnel' });

      const leads = data || [];
      const funnel = {
        total: leads.length,
        byScore: {
          A: leads.filter(l => l.score === 'A').length,
          B: leads.filter(l => l.score === 'B').length,
          C: leads.filter(l => l.score === 'C').length,
        },
        byStage: {
          new:         leads.filter(l => l.stage === 'new').length,
          engaged:     leads.filter(l => l.stage === 'engaged').length,
          qualified:   leads.filter(l => l.stage === 'qualified').length,
          negotiating: leads.filter(l => l.stage === 'negotiating').length,
          closed:      leads.filter(l => l.stage === 'closed').length,
          lost:        leads.filter(l => l.stage === 'lost').length,
        },
      };

      return reply.send({ funnel });
    } catch (err: any) {
      return reply.status(500).send({ error: err.message });
    }
  });

  /**
   * GET /api/analytics/response-sla
   * Returns SLA compliance: % of conversations where first auto-reply was
   * sent within 90 seconds of first customer message.
   * KPI co-defined with floor manager during on-site visit (target ≥ 90 %).
   */
  server.get('/response-sla', async (request, reply) => {
    const userId = request.userId;
    const { from } = request.query as { from?: string };
    const since = from ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    try {
      const { data, error } = await server.supabase
        .from('wb_messages')
        .select('conversation_id, sender, created_at')
        .eq('user_id', userId)
        .gte('created_at', since)
        .order('created_at', { ascending: true });

      if (error) return reply.status(500).send({ error: 'Failed to fetch messages' });

      const messages = data || [];

      // Group by conversation, find first customer msg and first bot reply
      type MsgRow = typeof messages[0];
      const convMap = new Map<string, { firstCustomer: MsgRow; firstBot: MsgRow | null }>();

      for (const msg of messages) {
        const cid = msg.conversation_id;
        if (!convMap.has(cid)) {
          convMap.set(cid, { firstCustomer: msg, firstBot: null });
          continue;
        }
        const entry = convMap.get(cid)!;
        if (!entry.firstBot && msg.sender === 'bot') {
          entry.firstBot = msg;
        }
      }

      const entries = [...convMap.values()].filter(e => e.firstBot !== null);
      const withinSla = entries.filter(e => {
        const customerTime = new Date(e.firstCustomer.created_at).getTime();
        const botTime = new Date(e.firstBot!.created_at).getTime();
        return botTime - customerTime <= 90_000; // 90 seconds
      });

      return reply.send({
        sla: {
          total: entries.length,
          withinSla: withinSla.length,
          compliancePct: entries.length > 0
            ? Math.round((withinSla.length / entries.length) * 100)
            : null,
          targetPct: 90,
          since,
        },
      });
    } catch (err: any) {
      return reply.status(500).send({ error: err.message });
    }
  });

  /**
   * GET /api/analytics/sentiment-trend
   * Returns daily average sentiment polarity for the last N days.
   * Added after floor manager asked for "mood of the sales floor" metric
   * during sprint-3 sign-off.
   */
  server.get('/sentiment-trend', async (request, reply) => {
    const userId = request.userId;
    const { days = '14' } = request.query as { days?: string };
    const numDays = Math.min(parseInt(days, 10) || 14, 90);
    const since = new Date(Date.now() - numDays * 24 * 60 * 60 * 1000).toISOString();

    try {
      const { data, error } = await server.supabase
        .from('wb_conversations')
        .select('last_message_at, sentiment_polarity')
        .eq('user_id', userId)
        .gte('last_message_at', since)
        .not('sentiment_polarity', 'is', null);

      if (error) return reply.status(500).send({ error: 'Failed to fetch sentiment' });

      // Bucket by day
      const buckets: Record<string, number[]> = {};
      for (const row of data || []) {
        const day = row.last_message_at.slice(0, 10);
        (buckets[day] ||= []).push(row.sentiment_polarity);
      }

      const trend = Object.entries(buckets)
        .map(([date, values]) => ({
          date,
          avg: Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 1000) / 1000,
          count: values.length,
        }))
        .sort((a, b) => a.date.localeCompare(b.date));

      return reply.send({ trend });
    } catch (err: any) {
      return reply.status(500).send({ error: err.message });
    }
  });

  /**
   * GET /api/analytics/branch-summary
   * Returns the wb_branch_lead_summary view for the authenticated user.
   * Placeholder for group-owner cross-branch view (single-user for now).
   */
  server.get('/branch-summary', async (request, reply) => {
    const userId = request.userId;

    try {
      const { data, error } = await server.supabase
        .from('wb_branch_lead_summary')
        .select('*')
        .eq('branch_user_id', userId);

      if (error) return reply.status(500).send({ error: 'Failed to fetch branch summary' });
      return reply.send({ branches: data || [] });
    } catch (err: any) {
      return reply.status(500).send({ error: err.message });
    }
  });
};
