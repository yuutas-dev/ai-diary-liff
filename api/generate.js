import { createClient } from '@supabase/supabase-js';

function sendJson(res, status, payload) {
  return res.status(status).json(payload);
}

function normalizeTags(tags) {
  if (Array.isArray(tags)) {
    return tags.map(tag => String(tag).trim()).filter(Boolean);
  }

  if (typeof tags === 'string' && tags.trim()) {
    return tags
      .split(',')
      .map(tag => tag.trim())
      .filter(Boolean);
  }

  return [];
}

function getTodayFormatted() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const date = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${date}`;
}

function safeTrimText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function buildStyleReferenceTexts(samples) {
  return (samples || [])
    .map(sample => safeTrimText(sample?.text))
    .filter(Boolean)
    .slice(0, 5);
}

async function uploadPhotoIfNeeded({ supabase, userId, image, mode }) {
  if (mode !== 'photo' || !image) {
    return {
      uploadFileId: null,
      photoUrl: null
    };
  }

  const base64Data = String(image).replace(/^data:image\/\w+;base64,/, '');
  const buffer = Buffer.from(base64Data, 'base64');

  const fileName = `${userId}/${Date.now()}.jpg`;
  let photoUrl = null;

  const { error: storageError } = await supabase.storage
    .from('photos')
    .upload(fileName, buffer, {
      contentType: 'image/jpeg',
      upsert: false
    });

  if (!storageError) {
    const { data: publicUrlData } = supabase.storage.from('photos').getPublicUrl(fileName);
    photoUrl = publicUrlData?.publicUrl || null;
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

  if (!uploadRes.ok) {
    const errorText = await uploadRes.text().catch(() => '');
    throw new Error(`Dify画像アップロード失敗: ${uploadRes.status} ${errorText}`);
  }

  const uploadJson = await uploadRes.json();
  return {
    uploadFileId: uploadJson?.id || null,
    photoUrl
  };
}

async function findCustomerIdByName({ supabase, userId, name }) {
  const trimmedName = safeTrimText(name);
  if (!trimmedName) return null;

  const { data, error } = await supabase
    .from('customers')
    .select('id')
    .eq('user_id', userId)
    .eq('name', trimmedName)
    .maybeSingle();

  if (error) {
    throw new Error(`顧客取得エラー: ${error.message}`);
  }

  return data?.id || null;
}

async function fetchStyleSamples({ supabase, userId }) {
  const candidateTables = [
    'writing_style_samples',
    'favorite_writing_samples'
  ];

  for (const tableName of candidateTables) {
    const { data, error } = await supabase
      .from(tableName)
      .select('id, text, created_at, is_active')
      .eq('user_id', userId)
      .or('is_active.is.null,is_active.eq.true')
      .order('created_at', { ascending: false })
      .limit(10);

    if (!error) {
      return buildStyleReferenceTexts(data);
    }

    const message = String(error.message || '');
    const isMissingTable =
      message.includes('relation') ||
      message.includes('does not exist') ||
      message.includes('schema cache') ||
      message.includes('Could not find');

    if (!isMissingTable) {
      console.error(`${tableName} fetch error:`, error);
    }
  }

  return [];
}

async function createDraftEntry({
  supabase,
  userId,
  customerId,
  visitStatus,
  episodeText,
  factTags,
  moodTags,
  photoUrl,
  aiText,
  mode
}) {
  if (mode === 'photo' || !customerId) {
    return null;
  }

  const entryType = visitStatus === 'visit' ? 'visit' : 'sales';
  const inputTags = [...factTags, ...moodTags];

  const { data, error } = await supabase
    .from('customer_entries')
    .insert({
      user_id: userId,
      customer_id: customerId,
      entry_type: entryType,
      entry_date: getTodayFormatted(),
      input_memo: episodeText,
      input_tags: inputTags,
      photo_url: photoUrl,
      ai_generated_text: aiText,
      final_sent_text: null,
      delivery_status: 'draft'
    })
    .select('id')
    .single();

  if (error) {
    console.error('Customer entries insert error:', error);
    return null;
  }

  return data?.id || null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return sendJson(res, 405, { success: false, error: 'Method Not Allowed' });
  }

  try {
    let data = req.body;
    if (typeof req.body === 'string') {
      data = JSON.parse(req.body);
    }

    const userId = data?.userId || 'test-user';

    const supabaseUrl = (process.env.SUPABASE_URL || '').trim();
    const supabaseKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
    const difyApiUrl = (process.env.DIFY_API_URL || '').trim();
    const difyApiKey = (process.env.DIFY_API_KEY || '').trim();

    if (!supabaseUrl || !supabaseKey) {
      throw new Error('Vercelの環境変数が読み込めていません');
    }

    if (!difyApiUrl || !difyApiKey) {
      throw new Error('Difyの環境変数が読み込めていません');
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    const mode = data?.mode === 'photo' ? 'photo' : 'text';
    const visitStatus = data?.visitStatus === 'visit' ? 'visit' : 'sales';
    const episodeText =
      typeof data?.episodeText === 'string'
        ? data.episodeText
        : (typeof data?.episode === 'string' ? data.episode : '');

    const factTags = normalizeTags(data?.factTags || data?.episodeTags);
    const moodTags = normalizeTags(data?.moodTags);
    const customerTags = normalizeTags(data?.customerTags);
    const customText = safeTrimText(data?.customText);

    const [styleReferenceTexts, customerId, uploadResult] = await Promise.all([
      fetchStyleSamples({ supabase, userId }),
      findCustomerIdByName({ supabase, userId, name: data?.name }),
      uploadPhotoIfNeeded({
        supabase,
        userId,
        image: data?.image,
        mode
      })
    ]);

    const difyInputs = {
      // 👤 基本情報と文体
      name: data?.name || '',
      style: data?.style || 'cute',
      tension: data?.tension || '3',
      emoji: data?.emoji || '4',
      custom_text: customText,
      // ※ image_file は下部の処理で追加されるためここには不要です

      // 🏢 業態・モード・ルーティング系（Difyの分岐で必須）
      business_type: data?.businessType || 'cabaret',
      visit_status: visitStatus,
      message_mode: mode,
      is_photo_diary: mode === 'photo' ? 'yes' : 'no',

      // 📝 今日の情報
      episode_text: episodeText,
      fact_tags: factTags.join(', '),
      mood_tags: moodTags.join(', '),
      has_episode_text: episodeText.trim() ? 'yes' : 'no',
      has_fact_tags: factTags.length > 0 ? 'yes' : 'no',
      
      // 🗂️ 顧客情報（以前は customerRank などになっていたのを修正）
      customer_rank: data?.customerRank || '新規',
      customer_tags: customerTags.join(', '),
      past_memo: data?.pastMemo || '',
      
      // 🤖 AIへの指示ルール
      grounding_priority: 'episodeText > factTags > moodTags > pastMemo',
      past_memo_usage_rule: 'Use pastMemo as tone/context only. Do not treat it as evidence of today.',
      photo_caption_hint: '', // 拡張用
      photo_tags: '',         // 拡張用
      
      // ✨ Supabaseから取得した過去の文章サンプル（Dify側に追加推奨）
      style_reference_texts: styleReferenceTexts.join('\n\n---\n\n')
    };

    const difyPayload = {
      inputs: difyInputs,
      response_mode: 'blocking',
      user: userId
    };

    if (uploadResult.uploadFileId) {
      const imageFilePayload = {
        type: 'image',
        transfer_method: 'local_file',
        upload_file_id: uploadResult.uploadFileId
      };

      difyPayload.files = [imageFilePayload];
      difyPayload.inputs.image_file = imageFilePayload;
    }

    const difyRes = await fetch(difyApiUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${difyApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(difyPayload)
    });

    if (!difyRes.ok) {
      const errorText = await difyRes.text().catch(() => '');
      throw new Error(`Dify生成エラー: ${difyRes.status} ${errorText}`);
    }

    const difyData = await difyRes.json();
    const aiText =
      difyData?.data?.outputs?.text ||
      difyData?.data?.outputs?.answer ||
      difyData?.answer ||
      '生成されましたがテキストが空です。';

    const entryId = await createDraftEntry({
      supabase,
      userId,
      customerId,
      visitStatus,
      episodeText,
      factTags,
      moodTags,
      photoUrl: uploadResult.photoUrl,
      aiText,
      mode
    });

    return sendJson(res, 200, {
      success: true,
      generatedText: aiText,
      entry_id: entryId,
      learned_style_count: styleReferenceTexts.length
    });
  } catch (err) {
    console.error('バックエンド処理エラー:', err);
    return sendJson(res, 500, {
      success: false,
      error: err.message || 'Internal Server Error'
    });
  }
}
