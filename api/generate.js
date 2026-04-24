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

  console.log("[DEBUG] API /generate called");

  try {
    let data = req.body;
    if (typeof req.body === 'string') data = JSON.parse(req.body);
    const userId = data?.userId || 'test-user';

    console.log("[DEBUG] Payload received:", { userId, name: data.name, mode: data.mode });

    const supabaseUrl = (process.env.SUPABASE_URL || '').trim();
    const supabaseKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
    if (!supabaseUrl || !supabaseKey) {
      console.error("[DEBUG] Missing Supabase Env Vars");
      throw new Error('Vercelの環境変数が読み込めていません');
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    let uploadFileId = null;
    let photoUrl = null;

    if (data.mode === 'photo' && data.image) {
      console.log("[DEBUG] Processing photo mode...");
      const base64Data = data.image.replace(/^data:image\/\w+;base64,/, '');
      const buffer = Buffer.from(base64Data, 'base64');

      const fileName = `${userId}/${Date.now()}.jpg`;
      const { error: storageError } = await supabase.storage
        .from('photos')
        .upload(fileName, buffer, { contentType: 'image/jpeg', upsert: false });

      if (!storageError) {
        const { data: publicUrlData } = supabase.storage.from('photos').getPublicUrl(fileName);
        photoUrl = publicUrlData.publicUrl;
        console.log("[DEBUG] Photo uploaded to Supabase:", photoUrl);
      } else {
        console.error('[DEBUG] Storage upload error:', storageError);
      }

      const blob = new Blob([buffer], { type: 'image/jpeg' });
      const formData = new FormData();
      formData.append('file', blob, 'image.jpg');
      formData.append('user', userId);

      console.log("[DEBUG] Uploading file to Dify...");
      const uploadRes = await fetch('https://api.dify.ai/v1/files/upload', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.DIFY_API_KEY}` },
        body: formData
      });

      const uploadJson = await uploadRes.json();
      if (uploadJson.id) {
        uploadFileId = uploadJson.id;
        console.log("[DEBUG] Dify uploadFileId:", uploadFileId);
      } else {
        console.error("[DEBUG] Dify file upload failed:", uploadJson);
      }
    }

    let customerId = null;
    
    console.log("[DEBUG] Processing Customer DB...");
    if (data.combinedMemoToSave && data.name) {
      const memoJson = JSON.parse(data.combinedMemoToSave);
      if (photoUrl && memoJson.length > 0) {
        memoJson[memoJson.length - 1].photoUrl = photoUrl;
      }

      console.log("[DEBUG] Updating existing customer memo...");
      const { data: updatedCustomer, error } = await supabase
        .from('customers')
        .update({ memo: memoJson, updated_at: new Date().toISOString() })
        .eq('user_id', userId)
        .eq('name', data.name)
        .select('id')
        .maybeSingle(); // 変更箇所

      if (error) {
        console.error('[DEBUG] Supabaseメモ更新エラー:', error);
      } else if (updatedCustomer) {
        customerId = updatedCustomer.id;
        console.log("[DEBUG] Updated customerId:", customerId);
      }
    } else if (data.name) {
      console.log("[DEBUG] Fetching customer ID for draft...");
      const { data: custData, error } = await supabase
        .from('customers')
        .select('id')
        .eq('user_id', userId)
        .eq('name', data.name)
        .maybeSingle(); // 変更箇所

      if (error) {
        console.error('[DEBUG] Supabase customer selectエラー:', error);
      } else if (custData) {
        customerId = custData.id;
        console.log("[DEBUG] Fetched customerId:", customerId);
      }
    }

    console.log("[DEBUG] Preparing Dify Payload...");
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
        mode: data.mode || 'text' ,
        entry_type: (data.combinedMemoToSave && data.name) ? 'visit' : 'sales'
      },
      response_mode: 'blocking',
      user: userId
    };

    if (uploadFileId) {
      difyPayload.files = [{ type: 'image', transfer_method: 'local_file', upload_file_id: uploadFileId }];
      difyPayload.inputs.image_file = { type: 'image', transfer_method: 'local_file', upload_file_id: uploadFileId };
    }

    const difyUrl = process.env.DIFY_API_URL;
    const difyKey = process.env.DIFY_API_KEY;

    console.log("[DEBUG] Dify API URL check:", difyUrl ? "EXISTS" : "MISSING");
    console.log("[DEBUG] Dify API KEY check:", difyKey ? "EXISTS" : "MISSING");
    console.log("[DEBUG] Dify Payload String:", JSON.stringify(difyPayload));

    if (!difyUrl || !difyKey) {
      throw new Error("DifyのAPI URLまたはKEYが環境変数に設定されていません");
    }

    console.log("[DEBUG] Fetching Dify API...");
    const difyRes = await fetch(difyUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${difyKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(difyPayload)
    });

    console.log("[DEBUG] Dify Response Status:", difyRes.status, difyRes.statusText);
    const difyRawText = await difyRes.text();
    console.log("[DEBUG] Dify Raw Response:", difyRawText);

    let difyData;
    try {
      difyData = JSON.parse(difyRawText);
    } catch(e) {
      throw new Error("DifyからJSON形式の応答が得られませんでした: " + difyRawText);
    }

    if (!difyRes.ok) {
      throw new Error(`Dify APIエラー: ${difyRes.status} ${JSON.stringify(difyData)}`);
    }

    const aiText = difyData.data?.outputs?.text || difyData.data?.outputs?.answer || difyData.answer || '生成されましたがテキストが空です。';

    let entryId = null;
    if (data.mode !== 'photo' && customerId) {
      console.log("[DEBUG] Saving draft to customer_entries...");
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
        .maybeSingle();
        
      if (entryError) {
        console.error('[DEBUG] Customer entries insert error:', entryError);
      } else if (newEntry) {
        entryId = newEntry.id;
        console.log("[DEBUG] Draft saved successfully. EntryID:", entryId);
      }
    }

    console.log("[DEBUG] Execution finished properly. Returning response.");
    return sendJson(res, 200, { success: true, generatedText: aiText, entry_id: entryId });

  } catch (err) {
    console.error('[DEBUG] バックエンド処理エラー (Catch):', err);
    return sendJson(res, 500, { success: false, error: err.message, stack: err.stack });
  }
}
