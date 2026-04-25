import { createClient } from '@supabase/supabase-js';

function sendJson(res, status, payload) {
  return res.status(status).json(payload);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { success: false, error: 'Method Not Allowed' });

  try {
    let data = req.body;
    if (typeof req.body === 'string') data = JSON.parse(req.body);

    const userId = data?.userId || 'test-user';
    const entryId = data?.entryId;
    const customerId = data?.customerId || null;
    const customerName = (data?.customerName || '').trim() || null;

    if (!entryId) return sendJson(res, 400, { success: false, error: 'entryId is required' });

    const supabaseUrl = (process.env.SUPABASE_URL || '').trim();
    const supabaseKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
    if (!supabaseUrl || !supabaseKey) throw new Error('Vercelの環境変数が読み込めていません');

    const supabase = createClient(supabaseUrl, supabaseKey);

    const { data: entry, error: entryError } = await supabase
      .from('customer_entries')
      .select('id, user_id, customer_id, ai_generated_text, final_sent_text')
      .eq('id', entryId)
      .eq('user_id', userId)
      .maybeSingle();

    if (entryError) throw new Error('履歴確認エラー: ' + entryError.message);
    if (!entry?.id) return sendJson(res, 404, { success: false, error: '対象の履歴が見つかりません' });

    const sampleText = (entry.final_sent_text || entry.ai_generated_text || '').trim();
    if (!sampleText) return sendJson(res, 400, { success: false, error: '登録できる本文がありません' });

    const payload = {
      user_id: userId,
      source_entry_id: entry.id,
      source_customer_id: entry.customer_id || customerId,
      source_customer_name: customerName,
      sample_text: sampleText,
      updated_at: new Date().toISOString()
    };

    const { error: upsertError } = await supabase
      .from('favorite_writing_samples')
      .upsert(payload, { onConflict: 'user_id,source_entry_id' });

    if (upsertError) throw new Error('お手本登録エラー: ' + upsertError.message);

    return sendJson(res, 200, { success: true, entryId: entry.id });
  } catch (err) {
    console.error('favorites/create error:', err);
    return sendJson(res, 500, { success: false, error: err.message });
  }
}
