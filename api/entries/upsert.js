import { createClient } from '@supabase/supabase-js';

function sendJson(res, status, payload) {
  return res.status(status).json(payload);
}

function normalizeTags(tags) {
  if (Array.isArray(tags)) return tags.map(t => String(t).trim()).filter(Boolean);
  if (typeof tags === 'string' && tags.trim()) return tags.split(',').map(t => t.trim()).filter(Boolean);
  return [];
}

function normalizeDate(input) {
  if (!input) return null;
  const normalized = String(input).replace(/\//g, '-').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { success: false, error: 'Method Not Allowed' });

  try {
    let data = req.body;
    if (typeof req.body === 'string') data = JSON.parse(req.body);

    const userId = data?.userId || 'test-user';
    const customerId = data?.customerId || null;
    const entries = Array.isArray(data?.entries) ? data.entries : [];

    if (!customerId) return sendJson(res, 400, { success: false, error: 'customerId is required' });

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

    if (customerError || !customer) {
      return sendJson(res, 404, { success: false, error: '対象顧客が見つかりません' });
    }

    const sanitizedEntries = entries
      .map((entry) => ({
        id: entry?.id || null,
        date: normalizeDate(entry?.date),
        text: typeof entry?.text === 'string' ? entry.text.trim() : '',
        tags: normalizeTags(entry?.tags),
        photoUrl: typeof entry?.photoUrl === 'string' ? entry.photoUrl : null,
        type: entry?.type === 'sales' ? 'sales' : 'visit'
      }))
      .filter(entry => entry.date && (entry.text || entry.tags.length > 0 || entry.photoUrl));

    const { data: existingEntries, error: existingError } = await supabase
      .from('customer_entries')
      .select('id, delivery_status, entry_type')
      .eq('user_id', userId)
      .eq('customer_id', customerId);

    if (existingError) throw new Error('既存エントリ取得エラー: ' + existingError.message);

    const existingById = new Map((existingEntries || []).map(e => [e.id, e]));
    const keepIds = new Set();

    for (const entry of sanitizedEntries) {
      const payload = {
        user_id: userId,
        customer_id: customerId,
        entry_type: entry.type,
        entry_date: entry.date,
        input_memo: entry.text,
        input_tags: entry.tags,
        photo_url: entry.photoUrl,
        delivery_status: 'manual',
        updated_at: new Date().toISOString()
      };

      if (entry.id && existingById.has(entry.id)) {
        const { data: updated, error: updateError } = await supabase
          .from('customer_entries')
          .update(payload)
          .eq('id', entry.id)
          .eq('user_id', userId)
          .eq('customer_id', customerId)
          .select('id')
          .maybeSingle();
        if (updateError) throw new Error('エントリ更新エラー: ' + updateError.message);
        if (!updated?.id) throw new Error('エントリ更新対象が見つかりません');
        keepIds.add(updated.id);
      } else {
        const { data: inserted, error: insertError } = await supabase
          .from('customer_entries')
          .insert(payload)
          .select('id')
          .single();
        if (insertError) throw new Error('エントリ作成エラー: ' + insertError.message);
        keepIds.add(inserted.id);
      }
    }

    const manualEntryIdsToDelete = (existingEntries || [])
      .filter(e => (e.entry_type === 'visit' || e.entry_type === 'sales') && e.delivery_status === 'manual' && !keepIds.has(e.id))
      .map(e => e.id);

    if (manualEntryIdsToDelete.length > 0) {
      const { error: deleteError } = await supabase
        .from('customer_entries')
        .delete()
        .eq('user_id', userId)
        .eq('customer_id', customerId)
        .in('id', manualEntryIdsToDelete);
      if (deleteError) throw new Error('不要エントリ削除エラー: ' + deleteError.message);
    }

    return sendJson(res, 200, { success: true });
  } catch (err) {
    console.error('Entries Upsert Error:', err);
    return sendJson(res, 500, { success: false, error: err.message });
  }
}
