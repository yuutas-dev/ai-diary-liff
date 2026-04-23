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
    const finalSentText = data?.finalSentText || '';
    const newStatus = data?.deliveryStatus || 'copied';

    if (!entryId) {
       return sendJson(res, 400, { success: false, error: 'entryId is required' });
    }

    const supabaseUrl = (process.env.SUPABASE_URL || '').trim();
    const supabaseKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
    if (!supabaseUrl || !supabaseKey) throw new Error('Vercelの環境変数が読み込めていません');

    const supabase = createClient(supabaseUrl, supabaseKey);

    // 1. 既存のレコードを取得して現在のステータスを確認
    const { data: existingEntry, error: fetchError } = await supabase
      .from('customer_entries')
      .select('delivery_status')
      .eq('id', entryId)
      .eq('user_id', userId)
      .single();

    if (fetchError || !existingEntry) {
      throw new Error('対象のエントリが見つからないか、アクセス権限がありません');
    }

    // 2. ステータスの強さ判定 (ダウングレード防止)
    const statusPriority = { draft: 0, copied: 1, line_sent: 2, legacy: 0, manual: 0 };
    const currentPriority = statusPriority[existingEntry.delivery_status] ?? 0;
    const newPriority = statusPriority[newStatus] ?? 0;

    // 新状態が既存以上の強さなら更新、それ以外（line_sent後にコピー等）は既存状態を維持
    const statusToSave = newPriority >= currentPriority ? newStatus : existingEntry.delivery_status;

    // 3. 最終テキストとステータスを更新
    const { error: updateError } = await supabase
      .from('customer_entries')
      .update({
        final_sent_text: finalSentText,
        delivery_status: statusToSave,
        updated_at: new Date().toISOString()
      })
      .eq('id', entryId)
      .eq('user_id', userId);

    if (updateError) throw new Error('エントリの更新に失敗しました: ' + updateError.message);

    return sendJson(res, 200, { success: true, delivery_status: statusToSave });
  } catch (err) {
    console.error('API Complete Error:', err);
    return sendJson(res, 500, { success: false, error: err.message });
  }
}
