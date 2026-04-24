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

    const supabaseUrl = (process.env.SUPABASE_URL || 'https://fdlfwtlzphntfontwcfa.supabase.co').trim();
    const supabaseKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
    if (!supabaseUrl || !supabaseKey) throw new Error('Vercelの環境変数が読み込めていません');

    const supabase = createClient(supabaseUrl, supabaseKey);

    const tagsArray = data.newTags ? String(data.newTags).split(',').map(t => t.trim()).filter(Boolean) : [];

    const { data: updated, error } = await supabase
      .from('customers')
      .update({
        name: data.newName,
        tags: tagsArray,
        updated_at: new Date().toISOString()
      })
      .eq('user_id', userId)
      .eq('name', data.oldName)
      .select('id, name, tags')
      .single();

    if (error) throw new Error('Supabase更新エラー: ' + error.message);
    return sendJson(res, 200, {
      success: true,
      customer: {
        id: updated.id,
        name: updated.name,
        tags: (updated.tags || []).join(', ')
      }
    });
  } catch (err) {
    console.error('バックエンド処理エラー:', err);
    return sendJson(res, 500, { success: false, error: err.message });
  }
}
