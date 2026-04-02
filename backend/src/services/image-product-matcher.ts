import type { SupabaseClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import { config } from '../config/environment.js';

/**
 * ImageProductMatcher
 *
 * Identifies a product from a customer-sent WhatsApp image and finds the
 * closest matching catalogue item using pgvector cosine similarity.
 *
 * Background (on-site visit, sprint-1):
 *   Customers frequently send photos of cars they have seen on the road or
 *   in showrooms and ask "do you have something like this?". Reps were
 *   manually scrolling inventory photos to find a match — slow, error-prone,
 *   and impossible at scale across 3 branches.
 *
 * Sprint-2 stakeholder reprioritisation:
 *   Feature upgraded from 'Should Have' to 'Must Have' after demo showed
 *   floor manager how close the Gemini Flash match was (≈82% top-1 accuracy
 *   on test set of 30 customer images). Target latency agreed: ≤ 3 s end-to-end.
 *
 * Architecture:
 *   1. Gemini Flash vision extracts structured metadata from image
 *      (make, model, year range, colour, body type)
 *   2. Metadata is serialised to a natural-language query string
 *   3. Jina v4 embeds the query string → 1536-dim vector
 *   4. pgvector RPC (wb_match_catalog) runs cosine search against
 *      pre-embedded catalogue items
 *   5. Top-K results returned with similarity scores for reply generation
 */

const geminiClient = new OpenAI({
  baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
  apiKey: config.GEMINI_API_KEY,
});

const jinaClient = new OpenAI({
  baseURL: 'https://api.jina.ai/v1',
  apiKey: config.JINA_API_KEY,
});

const VISION_MODEL = 'gemini-2.0-flash';
const EMBEDDING_MODEL = 'jina-embeddings-v4';
const EMBEDDING_DIMENSIONS = 1536;
const IMAGE_MATCH_TIMEOUT_MS = 8000;
const SIMILARITY_THRESHOLD = 0.45;
const TOP_K = 3;

export interface ImageMetadata {
  make: string | null;
  model: string | null;
  yearMin: number | null;
  yearMax: number | null;
  colour: string | null;
  bodyType: string | null; // sedan, SUV, hatchback, etc.
  confidence: number;      // 0-1, model self-reported
}

export interface CatalogMatch {
  itemId: string;
  title: string;
  price: number | null;
  similarity: number;
  imageUrl: string | null;
}

export class ImageProductMatcher {
  constructor(private supabase: SupabaseClient) {}

  /**
   * Full pipeline: base64 image → catalogue matches.
   * Returns empty array on any failure (non-blocking – reply generation
   * continues without image context rather than erroring).
   */
  async matchFromImage(
    userId: string,
    imageBase64: string,
    mimeType = 'image/jpeg'
  ): Promise<{ metadata: ImageMetadata; matches: CatalogMatch[] }> {
    try {
      const metadata = await this.extractMetadata(imageBase64, mimeType);
      if (metadata.confidence < 0.4) {
        console.log('[ImageMatcher] Low-confidence extraction – skipping catalogue search');
        return { metadata, matches: [] };
      }

      const queryString = this.metadataToQuery(metadata);
      const matches = await this.searchCatalogue(userId, queryString);

      console.log(
        [ImageMatcher]   →  match(es)
      );
      return { metadata, matches };
    } catch (err: any) {
      console.error('[ImageMatcher] Pipeline error:', err.message);
      return {
        metadata: { make: null, model: null, yearMin: null, yearMax: null, colour: null, bodyType: null, confidence: 0 },
        matches: [],
      };
    }
  }

  /** Step 1: Call Gemini Flash vision to extract structured car metadata from image */
  private async extractMetadata(imageBase64: string, mimeType: string): Promise<ImageMetadata> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), IMAGE_MATCH_TIMEOUT_MS);

    try {
      const response = await geminiClient.chat.completions.create(
        {
          model: VISION_MODEL,
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'image_url',
                  image_url: { url: data:;base64, },
                },
                {
                  type: 'text',
                  text: Identify the car in this image. Return ONLY valid JSON with keys:
{
  "make": string or null,
  "model": string or null,
  "yearMin": number or null,
  "yearMax": number or null,
  "colour": string or null,
  "bodyType": "sedan"|"SUV"|"hatchback"|"MPV"|"pickup"|"coupe"|"convertible"|null,
  "confidence": number between 0 and 1
}
If you cannot identify the car with >40% confidence, set confidence to 0 and all other fields to null.,
                },
              ],
            },
          ],
          response_format: { type: 'json_object' },
          max_tokens: 200,
        },
        { signal: controller.signal }
      );

      const raw = response.choices[0]?.message?.content ?? '{}';
      const parsed = JSON.parse(raw);
      return {
        make: parsed.make ?? null,
        model: parsed.model ?? null,
        yearMin: parsed.yearMin ?? null,
        yearMax: parsed.yearMax ?? null,
        colour: parsed.colour ?? null,
        bodyType: parsed.bodyType ?? null,
        confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Step 2: Serialise metadata to a natural-language query for embedding */
  private metadataToQuery(m: ImageMetadata): string {
    const parts: string[] = [];
    if (m.make) parts.push(m.make);
    if (m.model) parts.push(m.model);
    if (m.yearMin && m.yearMax && m.yearMin !== m.yearMax)
      parts.push(${m.yearMin}-);
    else if (m.yearMin) parts.push(String(m.yearMin));
    if (m.colour) parts.push(m.colour);
    if (m.bodyType) parts.push(m.bodyType);
    return parts.join(' ') || 'used car';
  }

  /** Step 3 + 4: Embed query → pgvector cosine search */
  private async searchCatalogue(userId: string, query: string): Promise<CatalogMatch[]> {
    const embResp = await jinaClient.embeddings.create({
      model: EMBEDDING_MODEL,
      input: [query],
      dimensions: EMBEDDING_DIMENSIONS,
    } as any);

    const vector = (embResp as any).data?.[0]?.embedding;
    if (!vector || !Array.isArray(vector)) return [];

    const { data, error } = await this.supabase.rpc('wb_match_catalog', {
      query_embedding: JSON.stringify(vector),
      match_threshold: SIMILARITY_THRESHOLD,
      match_count: TOP_K,
      p_user_id: userId,
    });

    if (error) {
      console.error('[ImageMatcher] pgvector search error:', error);
      return [];
    }

    return (data || []).map((row: any) => ({
      itemId: row.id,
      title: row.title,
      price: row.price ?? null,
      similarity: row.similarity,
      imageUrl: row.image_url ?? null,
    }));
  }
}
