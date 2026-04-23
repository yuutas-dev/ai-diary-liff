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

    const supabaseUrl = (process.env.SUPABASE_URL || 'https://fdlfwtlzphntfontwcfa.supabase.co').trim();
    const supabaseKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
    if (!supabaseUrl || !supabaseKey) throw new Error('Vercelの環境変数が読み込めていません');

    const supabase = createClient(supabaseUrl, supabaseKey);

    const [userRes, dummyRes] = await Promise.all([
      supabase.from('customers').select('name, memo, tags').eq('user_id', userId),
      supabase.from('customers').select('name, memo, tags').contains('tags', ['ダミー'])
    ]);

    if (userRes.error) throw new Error('Supabaseユーザーデータ取得エラー: ' + userRes.error.message);

    let dummyData = [];
    if (dummyRes.error) {
      const fallbackRes = await supabase.from('customers').select('name, memo, tags').ilike('tags', '%ダミー%');
      if (!fallbackRes.error) dummyData = fallbackRes.data || [];
    } else {
      dummyData = dummyRes.data || [];
    }

    const userData = userRes.data || [];
    const combinedMap = new Map();

    dummyData.forEach(r => {
      const tagsArray = normalizeTags(r.tags);
      if (tagsArray.includes('ダミー')) combinedMap.set(r.name, r);
    });

    userData.forEach(r => combinedMap.set(r.name, r));

    const customers = Array.from(combinedMap.values()).map(r => ({
      name: r.name,
      memo: typeof r.memo === 'string' ? r.memo : JSON.stringify(r.memo || []),
      tags: normalizeTags(r.tags).join(', ')
    }));

    return sendJson(res, 200, { success: true, customers });
  } catch (err) {
    console.error('バックエンド処理エラー:', err);
    return sendJson(res, 500, { success: false, error: err.message });
  }
}
