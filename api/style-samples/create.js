import { createClient } from '@supabase/supabase-js';

function sendJson(res, status, payload) {
  return res.status(status).json(payload);
}

function parseRequestBody(body) {
  if (!body) return {};
  if (typeof body === 'string') return JSON.parse(body);
  return body;
}

function normalizeSourceType(sourceType) {
  return sourceType === 'generated' ? 'generated' : 'manual';
}

function trimText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

async function insertIntoWritingStyleSamples(supabase, payload) {
  const { data, error } = await supabase
    .from('writing_style_samples')
    .insert(payload)
    .select('id, text, source_type, created_at')
    .single();

  if (error) throw error;
  return data;
}

async function insertIntoFavoriteWritingSamples(supabase, payload) {
  const fallbackPayload = {
    user_id: payload.user_id,
    text: payload.text,
    source_type: payload.source_type,
    source_entry_id: payload.source_entry_id || null,
    is_active: true
  };

  const { data, error } = await supabase
    .from('favorite_writing_samples')
    .insert(fallbackPayload)
    .select('id, text, source_type, created_at')
    .single();

  if (error) throw error;
  return data;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return sendJson(res, 405, { success: false, error: 'Method Not Allowed' });
  }

  try {
    const body = parseRequestBody(req.body);
    const userId = trimText(body.userId) || 'test-user';
    const text = trimText(body.text);
    const sourceType = normalizeSourceType(body.sourceType);
    const sourceEntryId = trimText(body.sourceEntryId) || null;

    if (!text) {
      return sendJson(res, 400, {
        success: false,
        error: 'text is required'
      });
    }

    const supabaseUrl = (process.env.SUPABASE_URL || '').trim();
    const supabaseKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();

    if (!supabaseUrl || !supabaseKey) {
      throw new Error('Vercelの環境変数が読み込めていません');
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    const primaryPayload = {
      user_id: userId,
      text,
      source_type: sourceType,
      source_entry_id: sourceEntryId,
      is_active: true
    };

    let sample = null;
    let tableName = '';

    try {
      sample = await insertIntoWritingStyleSamples(supabase, primaryPayload);
      tableName = 'writing_style_samples';
    } catch (primaryError) {
      console.error('writing_style_samples insert error:', primaryError);

      sample = await insertIntoFavoriteWritingSamples(supabase, primaryPayload);
      tableName = 'favorite_writing_samples';
    }

    return sendJson(res, 200, {
      success: true,
      sample: {
        id: sample.id,
        text: sample.text,
        source_type: sample.source_type || sourceType,
        created_at: sample.created_at || null
      },
      table: tableName
    });
  } catch (err) {
    console.error('Style sample create error:', err);
    return sendJson(res, 500, {
      success: false,
      error: err.message || 'Internal Server Error'
    });
  }
}
