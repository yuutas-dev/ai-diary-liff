import { createClient } from '@supabase/supabase-js';

function sendJson(res, status, payload) {
  return res.status(status).json(payload);
}

function normalizeTags(tags) {
  if (Array.isArray(tags)) {
    return tags.map(tag => String(tag).trim()).filter(Boolean);
  }
  if (typeof tags === 'string' && tags.trim()) {
    return tags.split(',').map(tag => tag.trim()).filter(Boolean);
  }
  return [];
}

function safeParseBody(body) {
  if (!body) return {};
  if (typeof body === 'string') return JSON.parse(body);
  return body;
}

function getTodayFormatted() {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function trimText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function buildStyleReferenceTexts(samples) {
  return (samples || [])
    .map(sample => trimText(sample?.text))
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
  const customerName = trimText(name);
  if (!customerName) return null;

  const { data, error } = await supabase
    .from('customers')
    .select('id')
    .eq('user_id', userId)
    .eq('name', customerName)
    .maybeSingle();

  if (error) throw new Error(`顧客取得エラー: ${error.message}`);

  return data?.id || null;
}

async function fetchStyleSamples({ supabase, userId }) {
  const candidateTables = ['writing_style_samples', 'favorite_writing_samples'];

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
  if (mode === 'photo' || !customerId) return null;

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

async function generateDiary({
  supabase,
  userId,
  payload,
  difyApiUrl,
  difyApiKey
}) {
  const mode = payload?.mode === 'photo' ? 'photo' : 'text';
  const visitStatus = payload?.visitStatus === 'visit' ? 'visit' : 'sales';
  const episodeText =
    typeof payload?.episodeText === 'string'
      ? payload.episodeText
      : (typeof payload?.episode === 'string' ? payload.episode : '');

  const factTags = normalizeTags(payload?.factTags || payload?.episodeTags);
  const moodTags = normalizeTags(payload?.moodTags);
  const customerTags = normalizeTags(payload?.customerTags);
  const customText = trimText(payload?.customText);

  const [styleReferenceTexts, customerId, uploadResult] = await Promise.all([
    fetchStyleSamples({ supabase, userId }),
    findCustomerIdByName({ supabase, userId, name: payload?.name }),
    uploadPhotoIfNeeded({
      supabase,
      userId,
      image: payload?.image,
      mode
    })
  ]);

  const difyPayload = {
    inputs: {
      name: payload?.name || '',
      episode_text: episodeText,
      episode: episodeText,
      pastMemo: payload?.pastMemo || '',
      customerTags: customerTags.join(', '),
      customerRank: payload?.customerRank || '新規',
      customer_tags: customerTags.join(', '),
      fact_tags: factTags.join(', '),
      mood_tags: moodTags.join(', '),
      visit_status: visitStatus,
      episodeTags: [...factTags, ...moodTags].join(', '),
      has_episode_text: episodeText.trim() ? 'yes' : 'no',
      has_fact_tags: factTags.length > 0 ? 'yes' : 'no',
      style: payload?.style || 'cute',
      tension: payload?.tension || '3',
      emoji: payload?.emoji || '4',
      custom_text: customText,
      businessType: payload?.businessType || '',
      industryPrompt: payload?.industryPrompt || '',
      mode,
      entry_type: visitStatus,
      grounding_priority: 'episodeText > factTags > moodTags > pastMemo',
      past_memo_usage_rule: 'Use pastMemo as tone/context only. Do not treat it as evidence of today.',
      style_reference_texts: styleReferenceTexts.join('\n\n---\n\n')
    },
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

  return {
    generatedText: aiText,
    entry_id: entryId,
    learned_style_count: styleReferenceTexts.length
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return sendJson(res, 405, { success: false, error: 'Method Not Allowed' });
  }

  try {
    const data = safeParseBody(req.body);
    const action = data?.action;
    const userId = trimText(data?.userId) || 'test-user';

    if (!action) {
      return sendJson(res, 400, { success: false, error: 'action is required' });
    }

    const supabaseUrl = (process.env.SUPABASE_URL || '').trim();
    const supabaseKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
    const difyApiUrl = (process.env.DIFY_API_URL || '').trim();
    const difyApiKey = (process.env.DIFY_API_KEY || '').trim();

    if (!supabaseUrl || !supabaseKey) {
      throw new Error('【致命的エラー】Vercelの環境変数が読み込めていません');
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    if (action === 'getCustomers') {
      const [userCustRes, dummyCustRes] = await Promise.all([
        supabase.from('customers').select('*').eq('user_id', userId),
        supabase.from('customers').select('*').contains('tags', ['ダミー'])
      ]);

      if (userCustRes.error) {
        throw new Error('Supabaseユーザーデータ取得エラー: ' + userCustRes.error.message);
      }

      let dummyCustomers = dummyCustRes.data || [];
      if (dummyCustRes.error) {
        const fallbackRes = await supabase.from('customers').select('*').ilike('tags', '%ダミー%');
        if (!fallbackRes.error) dummyCustomers = fallbackRes.data || [];
      }

      const userData = userCustRes.data || [];
      const combinedCustMap = new Map();

      dummyCustomers.forEach(customer => {
        if (normalizeTags(customer.tags).includes('ダミー')) {
          combinedCustMap.set(customer.id, customer);
        }
      });

      userData.forEach(customer => {
        combinedCustMap.set(customer.id, customer);
      });

      const finalCustomers = Array.from(combinedCustMap.values());
      const customerIds = finalCustomers.map(customer => customer.id);

      if (customerIds.length === 0) {
        return sendJson(res, 200, { success: true, customers: [] });
      }

      const { data: entriesData, error: entriesError } = await supabase
        .from('customer_entries')
        .select('*')
        .in('customer_id', customerIds)
        .order('entry_date', { ascending: true })
        .order('created_at', { ascending: true });

      if (entriesError) {
        throw new Error('エントリ取得エラー: ' + entriesError.message);
      }

      const entriesMap = {};
      (entriesData || []).forEach(entry => {
        if (!entriesMap[entry.customer_id]) entriesMap[entry.customer_id] = [];
        entriesMap[entry.customer_id].push(entry);
      });

      const customers = finalCustomers.map(customer => {
        const entries = entriesMap[customer.id] || [];
        const memoArr = entries.map(entry => ({
          id: entry.id,
          date: entry.entry_date,
          text: entry.input_memo || '',
          tags: entry.input_tags || [],
          photoUrl: entry.photo_url || undefined,
          type: entry.entry_type,
          status: entry.delivery_status
        }));

        return {
          id: customer.id,
          name: customer.name,
          memo: JSON.stringify(memoArr),
          tags: normalizeTags(customer.tags).join(', '),
          entries: memoArr
        };
      });

      return sendJson(res, 200, { success: true, customers });
    }

    if (action === 'createCustomer') {
      const tagsArray = normalizeTags(data.newTags);

      const { data: created, error } = await supabase
        .from('customers')
        .insert({
          user_id: userId,
          name: data.newName,
          tags: tagsArray
        })
        .select('id, name, tags')
        .single();

      if (error) throw new Error('Supabase保存エラー: ' + error.message);

      return sendJson(res, 200, {
        success: true,
        customer: {
          id: created.id,
          name: created.name,
          tags: normalizeTags(created.tags).join(', ')
        }
      });
    }

    if (action === 'updateCustomer') {
      const tagsArray = normalizeTags(data.newTags);

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
          tags: normalizeTags(updated.tags).join(', ')
        }
      });
    }

    if (action === 'deleteCustomer') {
      const { error } = await supabase
        .from('customers')
        .delete()
        .eq('user_id', userId)
        .eq('name', data.targetName);

      if (error) throw new Error('Supabase削除エラー: ' + error.message);

      return sendJson(res, 200, { success: true });
    }

    if (action === 'generate') {
      if (!difyApiUrl || !difyApiKey) {
        throw new Error('Difyの環境変数が読み込めていません');
      }

      const result = await generateDiary({
        supabase,
        userId,
        payload: data,
        difyApiUrl,
        difyApiKey
      });

      return sendJson(res, 200, {
        success: true,
        ...result
      });
    }

    return sendJson(res, 400, {
      success: false,
      error: `Unknown action: ${action}`
    });
  } catch (err) {
    console.error('バックエンド処理エラー:', err);
    return sendJson(res, 500, {
      success: false,
      error: err.message || 'Internal Server Error'
    });
  }
}
