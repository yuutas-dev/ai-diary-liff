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

    let uploadFileId = null;
    let photoUrl = null;

    // 画像処理ロジック (既存のまま)
    if (data.mode === 'photo' && data.image) {
      const base64Data = data.image.replace(/^data:image\/\w+;base64,/, '');
      const buffer = Buffer.from(base64Data, 'base64');

      const fileName = `${userId}/${Date.now()}.jpg`;
      const { error: storageError } = await supabase.storage
        .from('photos')
        .upload(fileName, buffer, { contentType: 'image/jpeg', upsert: false });

      if (!storageError) {
        const { data: publicUrlData } = supabase.storage.from('photos').getPublicUrl(fileName);
        photoUrl = publicUrlData.publicUrl;
      } else {
        console.error('Storage upload error:', storageError);
      }

      const blob = new Blob([buffer], { type: 'image/jpeg' });
      const formData = new FormData();
      formData.append('file', blob, 'image.jpg');
      formData.append('user', userId);

      const uploadRes = await fetch('https://api.dify.ai/v1/files/upload', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.DIFY_API_KEY}` },
        body: formData
      });

      const uploadJson = await uploadRes.json();
      if (uploadJson.id) uploadFileId = uploadJson.id;
    }

    // メモの保存ロジック (既存のまま)
    if (data.combinedMemoToSave && data.name) {
      const memoJson = JSON.parse(data.combinedMemoToSave);
      if (photoUrl && memoJson.length > 0) {
        memoJson[memoJson.length - 1].photoUrl = photoUrl;
      }

      const { error } = await supabase
        .from('customers')
        .update({ memo: memoJson, updated_at: new Date().toISOString() })
        .eq('user_id', userId)
        .eq('name', data.name);

      if (error) throw new Error('Supabaseメモ更新エラー: ' + error.message);
    }

    // Difyへのリクエスト (既存のまま)
    const difyPayload = {
      inputs: {
        name: data.name || '',
        episode: data.episode || '',
        pastMemo: data.pastMemo || '',
        customerTags: data.customerTags || '',
        customerRank: data.customerRank || '新規',
        episodeTags: data.episodeTags || '',
        style: data.style || 'cute',
        tension: data.tension || '3',
        emoji: data.emoji || '4',
        custom_text: data.customText || '',
        businessType: data.businessType || '',
        industryPrompt: data.industryPrompt || '',
        mode: data.mode || 'text'
      },
      response_mode: 'blocking',
      user: userId
    };

    if (uploadFileId) {
      difyPayload.files = [{ type: 'image', transfer_method: 'local_file', upload_file_id: uploadFileId }];
      difyPayload.inputs.image_file = { type: 'image', transfer_method: 'local_file', upload_file_id: uploadFileId };
    }

    const difyRes = await fetch(process.env.DIFY_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.DIFY_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(difyPayload)
    });

    const difyData = await difyRes.json();
    const aiText = difyData.data?.outputs?.text || difyData.data?.outputs?.answer || difyData.answer || '生成されましたがテキストが空です。';

    // ==========================================
    // 修正：ここの LINE Messaging API による
    // 自動Push送信ブロックを完全に削除しました。
    // ==========================================

    return sendJson(res, 200, { success: true, generatedText: aiText });
  } catch (err) {
    console.error('バックエンド処理エラー:', err);
    return sendJson(res, 500, { success: false, error: err.message });
  }
}
