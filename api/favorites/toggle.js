import { createClient } from '@supabase/supabase-js';

function sendJson(res, status, payload) {
  return res.status(status).json(payload);
}

function sanitizeId(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized ? normalized : null;
}

function safeApiError(message = 'お気に入り登録に失敗しました') {
  return { success: false, error: message };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { success: false, error: 'Method Not Allowed' });

  try {
    let data = req.body;
    if (typeof req.body === 'string') data = JSON.parse(req.body);

    const userId = data?.userId || 'test-user';
    const entryId = sanitizeId(data?.entryId);
    const customerId = sanitizeId(data?.customerId);
    const customerName = (data?.customerName || '').trim() || null;

    if (!entryId) return sendJson(res, 400, safeApiError('お気に入り登録に失敗しました'));

    const supabaseUrl = (process.env.SUPABASE_URL || '').trim();
    const supabaseKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
    if (!supabaseUrl || !supabaseKey) throw new Error('Vercelの環境変数が読み込めていません');

    const supabase = createClient(supabaseUrl, supabaseKey);

    const { data: existingFavorite, error: existingFavoriteError } = await supabase
      .from('favorite_writing_samples')
      .select('id')
      .eq('user_id', userId)
      .eq('source_entry_id', String(entryId))
      .maybeSingle();
    if (existingFavoriteError) throw new Error('お気に入り確認に失敗しました');

    if (existingFavorite?.id) {
      const { error: deleteError } = await supabase
        .from('favorite_writing_samples')
        .delete()
        .eq('id', existingFavorite.id)
        .eq('user_id', userId);
      if (deleteError) throw new Error('お気に入り解除に失敗しました');
      return sendJson(res, 200, { success: true, isFavorited: false });
    }

    const { count: favoriteCount, error: countError } = await supabase
      .from('favorite_writing_samples')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId);
    if (countError) throw new Error('お気に入り件数の確認に失敗しました');

    if ((favoriteCount || 0) >= 5) {
      return sendJson(res, 200, { success: true, isFavorited: false, limitReached: true });
    }

    const { data: entry, error: entryError } = await supabase
      .from('customer_entries')
      .select('id, user_id, customer_id, ai_generated_text, final_sent_text')
      .eq('id', String(entryId))
      .eq('user_id', userId)
      .maybeSingle();
    if (entryError) throw new Error('履歴の確認に失敗しました');
    if (!entry?.id) return sendJson(res, 404, safeApiError('お気に入り登録に失敗しました'));

    const sampleText = (entry.final_sent_text || entry.ai_generated_text || '').trim();
    if (!sampleText) return sendJson(res, 400, safeApiError('お気に入り登録に失敗しました'));

    const payload = {
      user_id: userId,
      source_entry_id: String(entry.id),
      source_customer_id: sanitizeId(entry.customer_id) || customerId,
      source_customer_name: customerName,
      sample_text: sampleText,
      updated_at: new Date().toISOString()
    };

    const { error: insertError } = await supabase.from('favorite_writing_samples').insert(payload);
    if (insertError) throw new Error('お気に入り登録に失敗しました');

    return sendJson(res, 200, { success: true, isFavorited: true });
  } catch (err) {
    console.error('favorites/toggle error:', err);
    return sendJson(res, 500, safeApiError('お気に入り登録に失敗しました'));
  }
}
