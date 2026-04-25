import { createClient } from '@supabase/supabase-js';

function sendJson(res, status, payload) {
  return res.status(status).json(payload);
}

function normalizeTags(tags) {
  if (Array.isArray(tags)) return tags.map(t => String(t || '').trim()).filter(Boolean);
  if (typeof tags === 'string' && tags.trim()) {
    return tags.split(',').map(t => t.trim()).filter(Boolean);
  }
  return [];
}

function normalizeDate(input) {
  const normalized = String(input || '').replace(/\//g, '-').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return normalized;
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { success: false, error: 'Method Not Allowed' });

  try {
    let data = req.body;
    if (typeof req.body === 'string') data = JSON.parse(req.body);

    const userId = data?.userId || 'test-user';
    const sourceEntryId = data?.sourceEntryId || null;
    const customerId = data?.customerId || null;
    const entryDate = normalizeDate(data?.entryDate);
    const episodeText = typeof data?.episodeText === 'string' ? data.episodeText.trim() : '';
    const factTags = normalizeTags(data?.factTags);

    if (!customerId) return sendJson(res, 400, { success: false, error: 'customerId is required' });

    const hasEnoughContent = episodeText.length >= 12 || factTags.length >= 1;
    if (!hasEnoughContent) {
      return sendJson(res, 400, { success: false, error: '内容が不足しているため保存できません' });
    }

    const supabaseUrl = (process.env.SUPABASE_URL || '').trim();
    const supabaseKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
    if (!supabaseUrl || !supabaseKey) throw new Error('Vercelの環境変数が読み込めていません');
    const supabase = createClient(supabaseUrl, supabaseKey);

    const { data: customer, error: customerError } = await supabase
      .from('customers')
      .select('id')
      .eq('id', customerId)
      .eq('user_id', userId)
      .maybeSingle();
    if (customerError || !customer) return sendJson(res, 404, { success: false, error: '対象顧客が見つかりません' });

    let sourceEntry = null;
    if (sourceEntryId) {
      const { data: source, error: sourceError } = await supabase
        .from('customer_entries')
        .select('id, customer_id, entry_type, entry_date, input_memo, input_tags, photo_url')
        .eq('id', sourceEntryId)
        .eq('user_id', userId)
        .maybeSingle();
      if (sourceError) throw new Error('元エントリ取得エラー: ' + sourceError.message);
      if (source && source.customer_id !== customerId) {
        return sendJson(res, 400, { success: false, error: '顧客が一致しません' });
      }
      if (source && source.entry_type !== 'visit') {
        return sendJson(res, 400, { success: false, error: '来店エントリのみ保存対象です' });
      }
      sourceEntry = source || null;
    }

    const saveMemo = episodeText || sourceEntry?.input_memo || '';
    const saveTags = factTags.length > 0 ? factTags : normalizeTags(sourceEntry?.input_tags);
    const saveDate = entryDate || normalizeDate(sourceEntry?.entry_date);
    const savePhoto = sourceEntry?.photo_url || null;

    const { data: inserted, error: insertError } = await supabase
      .from('customer_entries')
      .insert({
        user_id: userId,
        customer_id: customerId,
        entry_type: 'visit',
        entry_date: saveDate,
        input_memo: saveMemo,
        input_tags: saveTags,
        photo_url: savePhoto,
        ai_generated_text: null,
        final_sent_text: null,
        delivery_status: 'manual'
      })
      .select('id')
      .single();
    if (insertError) throw new Error('エピソード保存エラー: ' + insertError.message);

    return sendJson(res, 200, { success: true, entryId: inserted?.id || null });
  } catch (err) {
    console.error('entries/save-episode error:', err);
    return sendJson(res, 500, { success: false, error: err.message });
  }
}
