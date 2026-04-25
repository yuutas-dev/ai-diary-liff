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

function parseRequestBody(body) {
  if (!body) return {};
  if (typeof body === 'string') return JSON.parse(body);
  return body;
}

function mapEntriesToLegacyMemo(entries) {
  return (entries || []).map(entry => ({
    id: entry.id,
    date: entry.entry_date,
    text: entry.input_memo || '',
    tags: entry.input_tags || [],
    photoUrl: entry.photo_url || undefined,
    type: entry.entry_type,
    status: entry.delivery_status
  }));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return sendJson(res, 405, { success: false, error: 'Method Not Allowed' });
  }

  try {
    const data = parseRequestBody(req.body);
    const userId = data?.userId || 'test-user';

    const supabaseUrl = (process.env.SUPABASE_URL || '').trim();
    const supabaseKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();

    if (!supabaseUrl || !supabaseKey) {
      throw new Error('Vercelの環境変数が読み込めていません');
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    const [userCustomersResult, dummyCustomersResult] = await Promise.all([
      supabase.from('customers').select('*').eq('user_id', userId),
      supabase.from('customers').select('*').contains('tags', ['ダミー'])
    ]);

    if (userCustomersResult.error) {
      throw new Error('Supabaseユーザーデータ取得エラー: ' + userCustomersResult.error.message);
    }

    let dummyCustomers = dummyCustomersResult.data || [];

    if (dummyCustomersResult.error) {
      const fallbackResult = await supabase
        .from('customers')
        .select('*')
        .ilike('tags', '%ダミー%');

      if (!fallbackResult.error) {
        dummyCustomers = fallbackResult.data || [];
      }
    }

    const combinedCustomerMap = new Map();

    (dummyCustomers || []).forEach(customer => {
      if (normalizeTags(customer.tags).includes('ダミー')) {
        combinedCustomerMap.set(customer.id, customer);
      }
    });

    (userCustomersResult.data || []).forEach(customer => {
      combinedCustomerMap.set(customer.id, customer);
    });

    const customers = Array.from(combinedCustomerMap.values());
    const customerIds = customers.map(customer => customer.id);

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

    const entriesByCustomerId = new Map();

    (entriesData || []).forEach(entry => {
      if (!entriesByCustomerId.has(entry.customer_id)) {
        entriesByCustomerId.set(entry.customer_id, []);
      }
      entriesByCustomerId.get(entry.customer_id).push(entry);
    });

    const responseCustomers = customers.map(customer => {
      const mappedEntries = mapEntriesToLegacyMemo(entriesByCustomerId.get(customer.id) || []);

      return {
        id: customer.id,
        name: customer.name,
        memo: JSON.stringify(mappedEntries),
        tags: normalizeTags(customer.tags).join(', '),
        entries: mappedEntries
      };
    });

    return sendJson(res, 200, {
      success: true,
      customers: responseCustomers
    });
  } catch (err) {
    console.error('バックエンド処理エラー:', err);
    return sendJson(res, 500, {
      success: false,
      error: err.message || 'Internal Server Error'
    });
  }
}
