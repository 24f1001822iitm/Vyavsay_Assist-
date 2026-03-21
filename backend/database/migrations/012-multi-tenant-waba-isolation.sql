-- Migration: 012-multi-tenant-waba-isolation.sql
--
-- Context (from on-site stakeholder visit, 2026-01-28):
-- The dealership operates 3 branches (Pune East, Pune West, Nashik), each
-- needing its own WhatsApp Business Account (WABA) and isolated catalogue +
-- conversation data. Row-Level Security on user_id was already in place
-- (001-schema.sql) but we needed explicit per-branch WABA routing and a
-- cross-branch analytics view for the group owner.
--
-- These DDL changes were reviewed and approved by the floor manager and
-- accounts team during the sprint-3 stakeholder sign-off.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Conversation events table (audit trail for stage transitions)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wb_conversation_events (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id  UUID NOT NULL REFERENCES wb_conversations(id) ON DELETE CASCADE,
  from_stage       TEXT,
  to_stage         TEXT NOT NULL,
  triggered_by     TEXT NOT NULL CHECK (triggered_by IN ('ai', 'human')),
  reason           TEXT,
  timestamp        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_conv_events_conversation
  ON wb_conversation_events(conversation_id);

CREATE INDEX IF NOT EXISTS idx_conv_events_timestamp
  ON wb_conversation_events(timestamp DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Follow-up scheduling column on wb_conversations
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE wb_conversations
  ADD COLUMN IF NOT EXISTS follow_up_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sentiment_polarity DOUBLE PRECISION;

CREATE INDEX IF NOT EXISTS idx_conv_follow_up_at
  ON wb_conversations(follow_up_at ASC)
  WHERE follow_up_at IS NOT NULL AND ai_paused = false;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Cross-branch analytics view (group owner requirement from visit-2)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW wb_branch_lead_summary AS
SELECT
  u.id                          AS branch_user_id,
  u.business_name               AS branch_name,
  wa.phone_number               AS waba_phone,
  COUNT(DISTINCT c.id)          AS total_conversations,
  COUNT(DISTINCT l.id)          AS total_leads,
  COUNT(DISTINCT l.id) FILTER (WHERE l.score = 'A') AS hot_leads,
  COUNT(DISTINCT l.id) FILTER (WHERE l.score = 'B') AS warm_leads,
  COUNT(DISTINCT l.id) FILTER (WHERE l.score = 'C') AS cold_leads,
  COUNT(DISTINCT c.id) FILTER (WHERE c.ai_paused = true) AS human_takeovers,
  ROUND(AVG(c.sentiment_polarity)::numeric, 3)       AS avg_sentiment,
  MAX(c.last_message_at)                             AS last_activity_at
FROM wb_users u
LEFT JOIN wb_waba_accounts wa ON wa.user_id = u.id AND wa.active = true
LEFT JOIN wb_conversations c  ON c.user_id  = u.id
LEFT JOIN wb_leads l          ON l.conversation_id = c.id
GROUP BY u.id, u.business_name, wa.phone_number;

COMMENT ON VIEW wb_branch_lead_summary IS
  'Cross-branch analytics: aggregated lead and sentiment stats per WABA branch. '
  'Requested by accounts team during 2026-01-28 on-site visit to avoid '
  'manual consolidation of three branch spreadsheets.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. RLS policies for conversation_events
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE wb_conversation_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY conv_events_user_isolation ON wb_conversation_events
  USING (
    EXISTS (
      SELECT 1 FROM wb_conversations wc
      WHERE wc.id = wb_conversation_events.conversation_id
        AND wc.user_id = auth.uid()::text
    )
  );
