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

function sanitizeCustomerTagsForAi(tags) {
  const systemExactTags = new Set(['ダミー', '非表示', '一軍固定', 'system', 'dummy']);
  const systemKeywordPatterns = ['ダミー', 'dummy', '非表示', 'hidden', '一軍固定', 'pin', '固定', 'system'];
  const rankNoisePatterns = ['新規', '初回', '初めて', '一見', '常連', 'リピーター', '1回目', '一回目', '2回目', '二回目', '3回目', '三回目'];

  return Array.from(new Set(normalizeTags(tags)
    .map(t => String(t || '').trim())
    .filter(Boolean)
    .filter(tag => !systemExactTags.has(tag))
    .filter(tag => !systemKeywordPatterns.some(keyword => tag.toLowerCase().includes(keyword.toLowerCase())))
    .filter(tag => !rankNoisePatterns.some(keyword => tag.includes(keyword)))));
}

function getTodayFormatted() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { success: false, error: 'Method Not Allowed' });

  try {
    let data = req.body;
    if (typeof req.body === 'string') {
      try {
        data = JSON.parse(req.body);
      } catch (parseErr) {
        console.error('[generate] invalid JSON body:', parseErr);
        return sendJson(res, 400, { success: false, error: 'Invalid JSON body' });
      }
    }
    if (!data || typeof data !== 'object') data = {};

    const userId = data?.userId || 'test-user';
    const messageMode = data?.message_mode || data?.mode || 'text';
    const isPhotoDiary = messageMode === 'photo';
    const businessType = data?.business_type || data?.businessType || '';
    const rawVisitStatus = data?.visit_status || data?.visitStatus || 'sales';
    const visitStatus = rawVisitStatus === 'visit' ? 'visit' : 'sales';
    const routingVisitStatus = isPhotoDiary ? 'photo' : visitStatus;
    console.log('[generate] start', { userId, messageMode, businessType, visitStatus });

    const supabaseUrl = (process.env.SUPABASE_URL || '').trim();
    const supabaseKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
    if (!supabaseUrl || !supabaseKey) throw new Error('Vercelの環境変数が読み込めていません');

    const supabase = createClient(supabaseUrl, supabaseKey);

    let uploadFileId = null;
    let photoUrl = null;

    // 画像処理ロジック (既存維持)
    if (isPhotoDiary && typeof data.image === 'string' && data.image) {
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

      try {
        const uploadRes = await fetch('https://api.dify.ai/v1/files/upload', {
          method: 'POST',
          headers: { Authorization: `Bearer ${process.env.DIFY_API_KEY}` },
          body: formData
        });
        const uploadJson = await uploadRes.json();
        if (uploadJson.id) uploadFileId = uploadJson.id;
        else console.error('[generate] dify file upload failed:', uploadJson);
      } catch (uploadErr) {
        console.error('[generate] dify file upload exception:', uploadErr);
      }
    }

    let customerId = null;
    if (data?.name) {
      const { data: custData } = await supabase
        .from('customers')
        .select('id')
        .eq('user_id', userId)
        .eq('name', data.name)
        .maybeSingle();
      if (custData) customerId = custData.id;
    }

    const episodeText = typeof data.episode_text === 'string'
      ? data.episode_text
      : (typeof data.episodeText === 'string' ? data.episodeText : (data.episode || ''));
    const factTags = normalizeTags(data.fact_tags || data.factTags);
    const moodTags = normalizeTags(data.mood_tags || data.moodTags);
    const customerTags = sanitizeCustomerTagsForAi(data.customer_tags || data.customerTags);
    const customerRank = data.customer_rank || data.customerRank || '新規';
    const pastMemo = data.past_memo || data.pastMemo || '';
    const styleProfileStyle = data.style_profile_style || data.style || data?.style_profile?.style || 'cute';
    const styleProfileTension = data.style_profile_tension || data.tension || data?.style_profile?.tension || '3';
    const styleProfileEmoji = data.style_profile_emoji || data.emoji || data?.style_profile?.emoji || '4';
    const styleProfileCustomText = data.style_profile_custom_text || data.customText || data?.style_profile?.custom_text || '';
    let styleReferenceTexts = '';
    try {
      const { data: favorites, error: favoritesError } = await supabase
        .from('favorite_writing_samples')
        .select('sample_text, created_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(5);
      if (favoritesError) {
        console.error('[generate] favorites fetch failed:', favoritesError.message);
      } else {
        styleReferenceTexts = (favorites || [])
          .map(f => (f.sample_text || '').trim())
          .filter(Boolean)
          .join('\n\n');
      }
    } catch (favoritesErr) {
      console.error('[generate] favorites fetch exception:', favoritesErr);
    }

    // Difyリクエスト
    const baseInputs = {
      name: data.name || '',
      business_type: businessType,
      message_mode: messageMode,
      visit_status: visitStatus,
      is_photo_diary: isPhotoDiary ? 'yes' : 'no',
      routing_business_type: businessType,
      routing_visit_status: routingVisitStatus,
      routing_is_photo_diary: isPhotoDiary ? 'yes' : 'no',
      route_key: isPhotoDiary ? 'photo_diary' : `${businessType}_${visitStatus}`,
      style_profile_style: styleProfileStyle,
      style_profile_tension: styleProfileTension,
      style_profile_emoji: styleProfileEmoji,
      style_profile_custom_text: styleProfileCustomText,
      style_reference_texts: styleReferenceTexts
    };

    const textModeInputs = {
      episode_text: episodeText,
      fact_tags: factTags.join(', '),
      mood_tags: moodTags.join(', '),
      customer_rank: customerRank,
      customer_tags: customerTags.join(', '),
      past_memo: pastMemo,
      has_episode_text: episodeText.trim() ? 'yes' : 'no',
      has_fact_tags: factTags.length > 0 ? 'yes' : 'no',
      grounding_priority: 'episode_text > fact_tags > mood_tags > past_memo',
      past_memo_usage_rule: 'Use past_memo as tone/context only. Do not treat it as evidence of today.'
    };

    const photoModeInputs = {
      photo_caption_hint: episodeText || '',
      photo_tags: factTags.join(', '),
      mood_tags: moodTags.join(', ')
    };

    const difyPayload = {
      inputs: isPhotoDiary
        ? { ...baseInputs, ...photoModeInputs }
        : { ...baseInputs, ...textModeInputs },
      response_mode: 'blocking',
      user: userId
    };

    if (uploadFileId) {
      difyPayload.files = [{ type: 'image', transfer_method: 'local_file', upload_file_id: uploadFileId }];
      difyPayload.inputs.image_file = { type: 'image', transfer_method: 'local_file', upload_file_id: uploadFileId };
    }

    let difyRes;
    try {
      difyRes = await fetch(process.env.DIFY_API_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.DIFY_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(difyPayload)
      });
    } catch (difyNetworkErr) {
      console.error('[generate] dify network error:', difyNetworkErr);
      return sendJson(res, 502, { success: false, error: 'Dify request failed before response' });
    }

    let difyData = {};
    try {
      difyData = await difyRes.json();
    } catch (difyJsonErr) {
      console.error('[generate] dify invalid json:', difyJsonErr);
      return sendJson(res, 502, { success: false, error: 'Invalid JSON from Dify' });
    }
    if (!difyRes.ok) {
      console.error('[generate] dify non-200:', { status: difyRes.status, difyData });
      return sendJson(res, 502, { success: false, error: difyData?.message || `Dify returned ${difyRes.status}` });
    }

    const aiText = difyData.data?.outputs?.text || difyData.data?.outputs?.answer || difyData.answer || '生成されましたがテキストが空です。';

    // 【ダブルライト新側】新構造 customer_entries への draft 保存
    let entryId = null;
    if (!isPhotoDiary && customerId) {
      const isVisit = visitStatus === 'visit';
      const entryType = isVisit ? 'visit' : 'sales';
      const inputTags = [...factTags, ...moodTags];

      const { data: newEntry, error: entryError } = await supabase
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
        
      if (entryError) {
        console.error('Customer entries insert error:', entryError);
        // エントリ作成失敗でも生成テキストは返すのでスローはしない
      } else if (newEntry) {
        entryId = newEntry.id;
      }
    } else if (!isPhotoDiary && !customerId) {
      console.log('[generate] skip entry save: customerId not found');
    }

    // 生成テキストと共に entry_id をフロントへ返す
    console.log('[generate] success', { userId, messageMode, hasEntryId: !!entryId });
    return sendJson(res, 200, { success: true, generatedText: aiText, entry_id: entryId });
  } catch (err) {
    console.error('[generate] backend error:', err);
    return sendJson(res, 500, { success: false, error: err.message });
  }
}
