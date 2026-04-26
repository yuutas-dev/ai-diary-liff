import { createClient } from '@supabase/supabase-js';

function sendJson(res, status, payload) {
  return res.status(status).json(payload);
}

function parseRequestBody(body) {
  if (!body) return {};
  if (typeof body === 'string') return JSON.parse(body);
  return body;
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

function normalizeDate(input) {
  if (!input) return null;
  const normalized = String(input).replace(/\//g, '-').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : null;
}

function normalizeEntryType(type) {
  return type === 'sales' ? 'sales' : 'visit';
}

function trimText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function sanitizeEntries(entries) {
  return (Array.isArray(entries) ? entries : [])
    .map(entry => ({
      id: trimText(entry?.id) || null,
      date: normalizeDate(entry?.date),
      text: trimText(entry?.text),
      tags: normalizeTags(entry?.tags),
      photoUrl: trimText(entry?.photoUrl) || null,
      type: normalizeEntryType(entry?.type)
    }))
    .filter(entry => entry.date && (entry.text || entry.tags.length > 0 || entry.photoUrl));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return sendJson(res, 405, { success: false, error: 'Method Not Allowed' });
  }

  try {
    const data = parseRequestBody(req.body);
    const userId = trimText(data?.userId) || 'test-user';
    const customerId = trimText(data?.customerId);
    const entries = sanitizeEntries(data?.entries);
    const isDevMode = data?.isDevMode === true;

    if (!customerId) {
      return sendJson(res, 400, {
        success: false,
        error: 'customerId is required'
      });
    }

    const supabaseUrl = (process.env.SUPABASE_URL || '').trim();
    const supabaseKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();

    if (!supabaseUrl || !supabaseKey) {
      throw new Error('Vercelの環境変数が読み込めていません');
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    let customerQuery = supabase
      .from('customers')
      .select('id, user_id, tags')
      .eq('id', customerId);

    if (!isDevMode) {
      customerQuery = customerQuery.eq('user_id', userId);
    }

    const { data: customer, error: customerError } = await customerQuery.maybeSingle();

    if (customerError || !customer) {
      return sendJson(res, 404, {
        success: false,
        error: '対象顧客が見つかりません'
      });
    }

    const isDummyCustomer = normalizeTags(customer.tags).includes('ダミー');
    const isOwnCustomer = customer.user_id === userId;

    if (!isOwnCustomer && !(isDevMode && isDummyCustomer)) {
      return sendJson(res, 403, {
        success: false,
        error: 'この顧客データは更新できません'
      });
    }

    const { data: existingEntries, error: existingError } = await supabase
      .from('customer_entries')
      .select('id, delivery_status, entry_type')
      .eq('user_id', userId)
      .eq('customer_id', customerId);

    if (existingError) {
      throw new Error('既存エントリ取得エラー: ' + existingError.message);
    }

    const existingById = new Map((existingEntries || []).map(entry => [entry.id, entry]));
    const keepIds = new Set();

    for (const entry of entries) {
      const payload = {
        user_id: userId,
        customer_id: customerId,
        entry_type: entry.type,
        entry_date: entry.date,
        input_memo: entry.text,
        input_tags: entry.tags,
        photo_url: entry.photoUrl,
        delivery_status: 'manual',
        updated_at: new Date().toISOString()
      };

      if (entry.id && existingById.has(entry.id)) {
        const { data: updated, error: updateError } = await supabase
          .from('customer_entries')
          .update(payload)
          .eq('id', entry.id)
          .eq('user_id', userId)
          .eq('customer_id', customerId)
          .select('id')
          .single();

        if (updateError) {
          throw new Error('エントリ更新エラー: ' + updateError.message);
        }

        keepIds.add(updated.id);
      } else {
        const { data: inserted, error: insertError } = await supabase
          .from('customer_entries')
          .insert(payload)
          .select('id')
          .single();

        if (insertError) {
          throw new Error('エントリ作成エラー: ' + insertError.message);
        }

        keepIds.add(inserted.id);
      }
    }

    const manualVisitIdsToDelete = (existingEntries || [])
      .filter(entry => entry.entry_type === 'visit' && entry.delivery_status === 'manual' && !keepIds.has(entry.id))
      .map(entry => entry.id);

    if (manualVisitIdsToDelete.length > 0) {
      const { error: deleteError } = await supabase
        .from('customer_entries')
        .delete()
        .eq('user_id', userId)
        .eq('customer_id', customerId)
        .in('id', manualVisitIdsToDelete);

      if (deleteError) {
        throw new Error('不要エントリ削除エラー: ' + deleteError.message);
      }
    }

    return sendJson(res, 200, { success: true });
  } catch (err) {
    console.error('Entries Upsert Error:', err);
    return sendJson(res, 500, {
      success: false,
      error: err.message || 'Internal Server Error'
    });
  }
}
