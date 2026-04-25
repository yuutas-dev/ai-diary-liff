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

    const supabaseUrl = (process.env.SUPABASE_URL || '').trim();
    const supabaseKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
    if (!supabaseUrl || !supabaseKey) throw new Error('Vercelの環境変数が読み込めていません');

    const supabase = createClient(supabaseUrl, supabaseKey);

    const { data: entries, error: entriesError } = await supabase
      .from('customer_entries')
      .select('id, customer_id, entry_type, entry_date, delivery_status, ai_generated_text, final_sent_text, created_at')
      .eq('user_id', userId)
      .in('delivery_status', ['draft', 'copied', 'line_sent'])
      .order('entry_date', { ascending: false })
      .order('created_at', { ascending: false });

    if (entriesError) throw new Error('履歴取得エラー: ' + entriesError.message);

    const filteredEntries = (entries || []).filter(entry => {
      const aiText = (entry.ai_generated_text || '').trim();
      const finalText = (entry.final_sent_text || '').trim();
      return Boolean(aiText || finalText);
    });

    const customerIds = [...new Set(filteredEntries.map(e => e.customer_id).filter(Boolean))];
    let customerNameMap = new Map();

    if (customerIds.length > 0) {
      const { data: customers, error: customersError } = await supabase
        .from('customers')
        .select('id, name')
        .in('id', customerIds);

      if (customersError) throw new Error('顧客名取得エラー: ' + customersError.message);
      customerNameMap = new Map((customers || []).map(c => [c.id, c.name]));
    }

    const entryIds = filteredEntries.map(e => e.id).filter(Boolean);
    let favoriteEntryIdSet = new Set();
    if (entryIds.length > 0) {
      const { data: favorites, error: favoritesError } = await supabase
        .from('favorite_writing_samples')
        .select('source_entry_id')
        .eq('user_id', userId)
        .in('source_entry_id', entryIds);
      if (favoritesError && favoritesError.code !== 'PGRST116') {
        throw new Error('お気に入り状態取得エラー: ' + favoritesError.message);
      }
      favoriteEntryIdSet = new Set((favorites || []).map(f => f.source_entry_id));
    }

    const items = filteredEntries.map(entry => ({
      entryId: entry.id,
      customerId: entry.customer_id,
      customerName: customerNameMap.get(entry.customer_id) || '不明な顧客',
      entryType: entry.entry_type,
      entryDate: entry.entry_date,
      deliveryStatus: entry.delivery_status,
      aiGeneratedText: entry.ai_generated_text || '',
      finalSentText: entry.final_sent_text || '',
      isFavorited: favoriteEntryIdSet.has(entry.id)
    }));

    return sendJson(res, 200, { success: true, items });
  } catch (err) {
    console.error('entries/history error:', err);
    return sendJson(res, 500, { success: false, error: err.message });
  }
}
