import { createClient } from '@supabase/supabase-js';

function sendJson(res, status, payload) {
  return res.status(status).json(payload);
}

function normalizeTags(tags) {
  if (Array.isArray(tags)) return tags;
  if (typeof tags === 'string' && tags.trim()) {
    return tags.split(',').map(t => t.trim()).filter(Boolean);
  }
  return [];
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

    // 1. customers 取得 (自身 + ダミー)
    const customerColumns = 'id, user_id, name, tags, updated_at, created_at';
    const [userCustRes, dummyCustRes] = await Promise.all([
      supabase.from('customers').select(customerColumns).eq('user_id', userId),
      supabase.from('customers').select(customerColumns).contains('tags', ['ダミー'])
    ]);

    if (userCustRes.error) throw new Error('Supabaseユーザーデータ取得エラー: ' + userCustRes.error.message);

    let dummyCustomers = dummyCustRes.data || [];
    if (dummyCustRes.error) {
      // jsonb非対応フォールバック
      const fallbackRes = await supabase.from('customers').select(customerColumns).ilike('tags', '%ダミー%');
      if (!fallbackRes.error) dummyCustomers = fallbackRes.data || [];
    }

    const userData = userCustRes.data || [];
    const combinedCustMap = new Map();

    dummyCustomers.forEach(c => {
      if (normalizeTags(c.tags).includes('ダミー')) combinedCustMap.set(c.id, c);
    });
    userData.forEach(c => combinedCustMap.set(c.id, c));
    const finalCustomers = Array.from(combinedCustMap.values());

    const customerIds = finalCustomers.map(c => c.id);
    if (customerIds.length === 0) return sendJson(res, 200, { success: true, customers: [] });

    // 2. customer_entries 取得
    const { data: entriesData, error: entriesError } = await supabase
      .from('customer_entries')
      .select('*')
      .in('customer_id', customerIds)
      .order('entry_date', { ascending: true })
      .order('created_at', { ascending: true });

    if (entriesError) throw new Error('エントリ取得エラー: ' + entriesError.message);

    const entriesMap = {};
    (entriesData || []).forEach(e => {
      if (!entriesMap[e.customer_id]) entriesMap[e.customer_id] = [];
      entriesMap[e.customer_id].push(e);
    });

    // 3. マッピング (customer_entries から互換memoを再構築)
    const customers = finalCustomers.map(c => {
      const entries = entriesMap[c.id] || [];
      const memoArr = entries.map(e => ({
        id: e.id,
        date: e.entry_date,
        text: e.input_memo || '',
        tags: e.input_tags || [],
        photoUrl: e.photo_url || undefined,
        type: e.entry_type,
        status: e.delivery_status
      }));

      return {
        id: c.id,
        name: c.name,
        memo: JSON.stringify(memoArr),
        tags: normalizeTags(c.tags).join(', '),
        entries: memoArr
      };
    });

    return sendJson(res, 200, { success: true, customers });
  } catch (err) {
    console.error('バックエンド処理エラー:', err);
    return sendJson(res, 500, { success: false, error: err.message });
  }
}
