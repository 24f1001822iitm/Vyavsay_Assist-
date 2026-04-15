import type { SupabaseClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import { config } from '../config/environment.js';

/**
 * MultiTenantRagService
 *
 * Extends base RAG capability with per-tenant knowledge isolation,
 * domain-aware retrieval routing, and a hybrid search strategy
 * (pgvector cosine + full-text keyword fallback).
 *
 * Context (stakeholder requirement, sprint-1 + sprint-2):
 *   - Each branch has its own product catalogue, FAQ doc, and price sheet.
 *   - A question about a car at Pune East should NEVER surface inventory
 *     from Pune West or Nashik.
 *   - Floor manager: "If vector search returns nothing useful, fall back
 *     to a keyword search – I don't want the bot to say 'I don't know'
 *     when the answer is clearly in our FAQ."
 *
 * Hybrid retrieval design (sprint-2 iterative feedback):
 *   1. pgvector cosine search (primary) – semantic similarity, threshold 0.40
 *   2. If < MIN_VECTOR_HITS results, run Postgres full-text (tsvector) fallback
 *   3. Deduplicate by chunk hash, merge and re-rank by combined score
 *   4. Return top-5 chunks as plain strings for prompt injection
 *
 * Knowledge source routing:
 *   - domain='catalog': queries wb_catalog_items embeddings (product inventory)
 *   - domain='knowledge': queries wb_knowledge_base chunks (FAQ, policies)
 *   - domain='auto': runs both and returns union (used for general questions)
 */

const jinaClient = new OpenAI({
  baseURL: 'https://api.jina.ai/v1',
  apiKey: config.JINA_API_KEY,
});

const EMBEDDING_MODEL = 'jina-embeddings-v4';
const EMBEDDING_DIMENSIONS = 1536;
const SIMILARITY_THRESHOLD = 0.40;
const MIN_VECTOR_HITS = 2;
const MAX_RESULTS = 5;
const CHUNK_SIZE = 200;
const CHUNK_OVERLAP = 40;

export type RagDomain = 'catalog' | 'knowledge' | 'auto';

export interface RagResult {
  content: string;
  source: 'vector' | 'fulltext';
  score: number;
  chunkHash: string;
}

export class MultiTenantRagService {
  constructor(private supabase: SupabaseClient) {}

  /**
   * Primary retrieval entry point.
   * Routes by domain, runs hybrid search, returns plain strings for prompt.
   */
  async retrieve(
    userId: string,
    queryText: string,
    domain: RagDomain = 'auto',
    topK = MAX_RESULTS
  ): Promise<string[]> {
    const embedding = await this.embed(queryText);
    if (!embedding) return [];

    const results: RagResult[] = [];

    if (domain === 'catalog' || domain === 'auto') {
      const catalogResults = await this.vectorSearch('wb_match_catalog', userId, embedding, topK);
      results.push(...catalogResults);
    }

    if (domain === 'knowledge' || domain === 'auto') {
      const knowledgeResults = await this.vectorSearch('wb_match_knowledge', userId, embedding, topK);
      results.push(...knowledgeResults);
    }

    // Hybrid fallback: if primary vector search returns too few results
    if (results.length < MIN_VECTOR_HITS) {
      const ftResults = await this.fulltextSearch(userId, queryText, domain, topK);
      for (const ft of ftResults) {
        if (!results.some(r => r.chunkHash === ft.chunkHash)) {
          results.push(ft);
        }
      }
    }

    // Deduplicate + sort by score descending
    const seen = new Set<string>();
    const unique = results
      .filter(r => {
        if (seen.has(r.chunkHash)) return false;
        seen.add(r.chunkHash);
        return true;
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

    return unique.map(r => r.content);
  }

  /**
   * Embed text → 1536-dim Jina v4 vector.
   * Returns null on failure (callers treat null as empty context).
   */
  async embed(text: string): Promise<number[] | null> {
    try {
      const resp = await jinaClient.embeddings.create({
        model: EMBEDDING_MODEL,
        input: [text.slice(0, 2000)], // Jina has 8192 token limit; 2000 chars is safe
        dimensions: EMBEDDING_DIMENSIONS,
      } as any);
      return (resp as any).data?.[0]?.embedding ?? null;
    } catch (err: any) {
      console.error('[MultiTenantRAG] Embed error:', err.message);
      return null;
    }
  }

  /**
   * Chunk text and upsert all embeddings for a given userId.
   * Idempotent: existing chunks with the same hash are skipped.
   */
  async ingestDocument(
    userId: string,
    text: string,
    sourceFile?: string,
    table: 'wb_knowledge_base' | 'wb_catalog_items' = 'wb_knowledge_base'
  ): Promise<number> {
    const chunks = this.chunkText(text, CHUNK_SIZE, CHUNK_OVERLAP);
    if (!chunks.length) return 0;

    const embeddings = await this.batchEmbed(chunks);
    let inserted = 0;

    for (let i = 0; i < chunks.length; i++) {
      const hash = await this.hashChunk(chunks[i]);
      const { error } = await this.supabase.from(table).upsert(
        {
          user_id: userId,
          content: chunks[i],
          embedding: JSON.stringify(embeddings[i]),
          chunk_hash: hash,
          source_file: sourceFile ?? null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'user_id,chunk_hash', ignoreDuplicates: true }
      );
      if (!error) inserted++;
    }

    console.log([MultiTenantRAG] Ingested / chunks for user=);
    return inserted;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ──────────────────────────────────────────────────────────────────────────

  private async vectorSearch(
    rpc: string,
    userId: string,
    embedding: number[],
    topK: number
  ): Promise<RagResult[]> {
    const { data, error } = await this.supabase.rpc(rpc, {
      query_embedding: JSON.stringify(embedding),
      match_threshold: SIMILARITY_THRESHOLD,
      match_count: topK,
      p_user_id: userId,
    });

    if (error) {
      console.error([MultiTenantRAG] vectorSearch() error:, error);
      return [];
    }

    return (data || []).map((row: any) => ({
      content: row.content,
      source: 'vector' as const,
      score: row.similarity ?? 0,
      chunkHash: row.chunk_hash ?? this.simpleHash(row.content),
    }));
  }

  private async fulltextSearch(
    userId: string,
    queryText: string,
    domain: RagDomain,
    topK: number
  ): Promise<RagResult[]> {
    const table = domain === 'catalog' ? 'wb_catalog_items' : 'wb_knowledge_base';
    const tsQuery = queryText.trim().split(/\s+/).filter(Boolean).join(' & ');

    const { data, error } = await this.supabase
      .from(table)
      .select('content, chunk_hash')
      .eq('user_id', userId)
      .textSearch('content', tsQuery, { type: 'websearch' })
      .limit(topK);

    if (error) return [];

    return (data || []).map((row: any, i: number) => ({
      content: row.content,
      source: 'fulltext' as const,
      score: 1 - i * 0.05, // rank decays with position
      chunkHash: row.chunk_hash ?? this.simpleHash(row.content),
    }));
  }

  private async batchEmbed(chunks: string[]): Promise<number[][]> {
    const BATCH_SIZE = 10;
    const results: number[][] = [];

    for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
      const batch = chunks.slice(i, i + BATCH_SIZE);
      try {
        const resp = await jinaClient.embeddings.create({
          model: EMBEDDING_MODEL,
          input: batch,
          dimensions: EMBEDDING_DIMENSIONS,
        } as any);
        results.push(...(resp as any).data.map((d: any) => d.embedding));
      } catch (err: any) {
        console.error('[MultiTenantRAG] Batch embed error:', err.message);
        results.push(...batch.map(() => new Array(EMBEDDING_DIMENSIONS).fill(0)));
      }
    }

    return results;
  }

  private chunkText(text: string, chunkSize: number, overlap: number): string[] {
    const words = text.split(/\s+/);
    const chunks: string[] = [];
    let i = 0;
    while (i < words.length) {
      chunks.push(words.slice(i, i + chunkSize).join(' '));
      i += chunkSize - overlap;
    }
    return chunks.filter(c => c.trim().length > 10);
  }

  private async hashChunk(content: string): Promise<string> {
    const { createHash } = await import('node:crypto');
    return createHash('sha256').update(content).digest('hex').slice(0, 16);
  }

  private simpleHash(s: string): string {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
    return Math.abs(h).toString(16);
  }
}
