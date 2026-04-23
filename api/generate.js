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

function getTodayFormatted() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
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

    let uploadFileId = null;
    let photoUrl = null;

    // 画像処理ロジック (既存維持)
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

    let customerId = null;
    
    // 【ダブルライト旧側】旧memoの更新ロジック
    // data.combinedMemoToSave が存在すれば「来店あり(visit)」と判定
    if (data.combinedMemoToSave && data.name) {
      const memoJson = JSON.parse(data.combinedMemoToSave);
      if (photoUrl && memoJson.length > 0) {
        memoJson[memoJson.length - 1].photoUrl = photoUrl;
      }

      const { data: updatedCustomer, error } = await supabase
        .from('customers')
        .update({ memo: memoJson, updated_at: new Date().toISOString() })
        .eq('user_id', userId)
        .eq('name', data.name)
        .select('id')
        .single();

      if (error) throw new Error('Supabaseメモ更新エラー: ' + error.message);
      if (updatedCustomer) customerId = updatedCustomer.id;
    } else if (data.name) {
      // 来店なし(sales)等でも、後で新テーブルに入れるために customer_id を取得
      const { data: custData } = await supabase
        .from('customers')
        .select('id')
        .eq('user_id', userId)
        .eq('name', data.name)
        .single();
      if (custData) customerId = custData.id;
    }

    // Difyリクエスト (既存維持)
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

    // 【ダブルライト新側】新構造 customer_entries への draft 保存
    let entryId = null;
    if (data.mode !== 'photo' && customerId) {
      // combinedMemoToSave の有無で entry_type を自動判定
      const isVisit = !!data.combinedMemoToSave;
      const entryType = isVisit ? 'visit' : 'sales';
      const inputTags = normalizeTags(data.episodeTags);

      const { data: newEntry, error: entryError } = await supabase
        .from('customer_entries')
        .insert({
          user_id: userId,
          customer_id: customerId,
          entry_type: entryType,
          entry_date: getTodayFormatted(),
          input_memo: data.episode || '',
          input_tags: inputTags,
          photo_url: photoUrl,
          ai_generated_text: aiText,
          final_sent_text: null,
          delivery_status: 'draft'
        })
        .select('id')
        .single();
        
      if (entryError) {
        console.error('Customer entries insert error:', entryError);
        // エントリ作成失敗でも生成テキストは返すのでスローはしない
      } else if (newEntry) {
        entryId = newEntry.id;
      }
    }

    // 生成テキストと共に entry_id をフロントへ返す
    return sendJson(res, 200, { success: true, generatedText: aiText, entry_id: entryId });
  } catch (err) {
    console.error('バックエンド処理エラー:', err);
    return sendJson(res, 500, { success: false, error: err.message });
  }
}
