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
  if (req.method !== 'POST') {
    return sendJson(res, 405, { success: false, error: 'Method Not Allowed' });
  }

  try {
    if (!req.body) {
      return sendJson(res, 400, { success: false, error: 'Request body is empty' });
    }

    let data;
    try {
      data = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    } catch (parseError) {
      return sendJson(res, 400, { success: false, error: 'Invalid JSON body' });
    }

    const action = data?.action;
    const userId = data?.userId || 'test-user';

    if (!action) {
      return sendJson(res, 400, { success: false, error: 'action is required' });
    }

    const supabaseUrl = (process.env.SUPABASE_URL || 'https://fdlfwtlzphntfontwcfa.supabase.co').trim();
    const supabaseKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();

    if (!supabaseUrl || !supabaseKey) {
      throw new Error('【致命的エラー】Vercelの環境変数が読み込めていません！(URLまたは鍵が空です)');
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    // 1. 顧客リスト取得
    if (action === 'getCustomers') {
      const { data: rows, error } = await supabase.from('customers').select('*');
      if (error) throw new Error('Supabase取得エラー: ' + error.message);

      const customers = (rows || [])
        .filter(r => r.user_id === userId || normalizeTags(r.tags).includes('ダミー'))
        .map(r => ({
          name: r.name,
          memo: typeof r.memo === 'string' ? r.memo : JSON.stringify(r.memo || []),
          tags: normalizeTags(r.tags).join(', ')
        }));

      return sendJson(res, 200, { success: true, customers });
    }

    // 2. 新規顧客作成
    if (action === 'createCustomer') {
      const tagsArray = data.newTags
        ? String(data.newTags).split(',').map(t => t.trim()).filter(Boolean)
        : [];
      const memoJson =
        typeof data.newMemo === 'string'
          ? JSON.parse(data.newMemo)
          : (data.newMemo || []);

      const { error } = await supabase.from('customers').insert({
        user_id: userId,
        name: data.newName,
        memo: memoJson,
        tags: tagsArray
      });

      if (error) throw new Error('Supabase保存エラー: ' + error.message);
      return sendJson(res, 200, { success: true });
    }

    // 3. 顧客情報の更新
    if (action === 'updateCustomer') {
      const tagsArray = data.newTags
        ? String(data.newTags).split(',').map(t => t.trim()).filter(Boolean)
        : [];
      const memoJson =
        typeof data.newMemo === 'string'
          ? JSON.parse(data.newMemo)
          : (data.newMemo || []);

      const { error } = await supabase
        .from('customers')
        .update({
          name: data.newName,
          memo: memoJson,
          tags: tagsArray,
          updated_at: new Date().toISOString()
        })
        .eq('user_id', userId)
        .eq('name', data.oldName);

      if (error) throw new Error('Supabase更新エラー: ' + error.message);
      return sendJson(res, 200, { success: true });
    }

    // 4. 顧客削除
    if (action === 'deleteCustomer') {
      const { error } = await supabase
        .from('customers')
        .delete()
        .eq('user_id', userId)
        .eq('name', data.targetName);

      if (error) throw new Error('Supabase削除エラー: ' + error.message);
      return sendJson(res, 200, { success: true });
    }

    // 5. AI日記生成
    if (action === 'generate') {
      let uploadFileId = null;
      let photoUrl = null;

      if (data.mode === 'photo' && data.image) {
        const base64Data = data.image.replace(/^data:image\/\w+;base64,/, '');
        const buffer = Buffer.from(base64Data, 'base64');

        const fileName = `${userId}/${Date.now()}.jpg`;
        const { error: storageError } = await supabase.storage
          .from('photos')
          .upload(fileName, buffer, {
            contentType: 'image/jpeg',
            upsert: false
          });

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
          headers: {
            Authorization: `Bearer ${process.env.DIFY_API_KEY}`
          },
          body: formData
        });

        const uploadJson = await uploadRes.json();
        if (uploadJson.id) uploadFileId = uploadJson.id;
      }

      if (data.combinedMemoToSave && data.name) {
        const memoJson = JSON.parse(data.combinedMemoToSave);

        if (photoUrl && memoJson.length > 0) {
          memoJson[memoJson.length - 1].photoUrl = photoUrl;
        }

        const { error } = await supabase
          .from('customers')
          .update({
            memo: memoJson,
            updated_at: new Date().toISOString()
          })
          .eq('user_id', userId)
          .eq('name', data.name);

        if (error) throw new Error('Supabaseメモ更新エラー: ' + error.message);
      }

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
        difyPayload.files = [
          {
            type: 'image',
            transfer_method: 'local_file',
            upload_file_id: uploadFileId
          }
        ];
        difyPayload.inputs.image_file = {
          type: 'image',
          transfer_method: 'local_file',
          upload_file_id: uploadFileId
        };
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
      const aiText =
        difyData.data?.outputs?.text ||
        difyData.data?.outputs?.answer ||
        difyData.answer ||
        '生成されましたがテキストが空です。';

      if (userId !== 'test-user' && process.env.LINE_ACCESS_TOKEN) {
        try {
          await fetch('https://api.line.me/v2/bot/message/push', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${process.env.LINE_ACCESS_TOKEN}`
            },
            body: JSON.stringify({
              to: userId,
              messages: [{ type: 'text', text: aiText }]
            })
          });
        } catch (e) {
          console.error('LINE Push Error:', e);
        }
      }

      return sendJson(res, 200, { success: true, generatedText: aiText });
    }

    return sendJson(res, 400, { success: false, error: `Unknown action: ${action}` });
  } catch (err) {
    console.error('バックエンド処理エラー:', err);
    return sendJson(res, 500, { success: false, error: err.message || 'Internal Server Error' });
  }
}
