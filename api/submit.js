import crypto from 'crypto';

const LARK_BASE = 'https://open.larksuite.com/open-apis';
const APP_TOKEN = 'B8qabL6VmaXgbfs0kZoj5kzlpfc';
const TABLE_CONTRACT = 'tblqmyQe3TrcBFv9';
const TABLE_INVOICE  = 'tblmC3zfsQV8hgRU';

const store = {};

async function getLarkToken() {
  const r = await fetch(`${LARK_BASE}/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      app_id: process.env.LARK_APP_ID,
      app_secret: process.env.LARK_APP_SECRET
    })
  });
  const d = await r.json();
  if (!d.tenant_access_token) throw new Error('Lark auth failed: ' + JSON.stringify(d));
  return d.tenant_access_token;
}

async function larkPost(token, path, body) {
  const r = await fetch(`${LARK_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify(body)
  });
  return r.json();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // GET: load draft by id
  if (req.method === 'GET') {
    const url = new URL(req.url, `https://${req.headers.host}`);
    const id = url.searchParams.get('id');
    if (!id) return res.status(400).json({ error: 'Missing id' });
    const draft = store[id];
    if (!draft) return res.status(404).json({ error: 'Draft not found or expired' });
    return res.status(200).json(draft);
  }

  // POST
  if (req.method === 'POST') {
    const body = req.body || {};
    const action = body.action;

    // Save draft
    if (action === 'save_draft') {
      const id = crypto.randomBytes(8).toString('hex');
      store[id] = { ...body, id, saved_at: Date.now() };
      return res.status(200).json({ id });
    }

    // Approve: write to Lark Base
    if (action === 'approve') {
      try {
        const token = await getLarkToken();

        // 1. Create contract record
        const contractFields = {
          'Contract Number': body.contract_number || '',
          'Contract Amount': parseFloat(body.contract_amount) || 0,
          'Contract Status': 'Active',
        };
        if (body.contract_start_date) {
          contractFields['Contract Start Date'] = new Date(body.contract_start_date).getTime();
        }
        if (body.contract_end_date) {
          contractFields['Contract End Date'] = new Date(body.contract_end_date).getTime();
        }

        const contractRes = await larkPost(token,
          `/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_CONTRACT}/records`,
          { fields: contractFields }
        );
        if (contractRes.code !== 0) throw new Error('Contract create failed: ' + JSON.stringify(contractRes));

        // 2. Create invoice records for each milestone
        const milestones = body.milestones || [];
        const invoiceResults = await Promise.all(milestones.map(m => {
          const fields = {
            'Invoice Description': m.description || '',
            'Esitimated Invoice Amount': parseFloat(m.amount) || 0,
            'Type': 'Milestone payment',
            'Acceptance satuts': 'Planned/Estimation',
            'Invoice satuts': 'Not Sent',
            'Project Name': body.project_name || '',
          };
          if (m.due_date) fields['Date to be invoiced'] = new Date(m.due_date).getTime();
          return larkPost(token,
            `/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_INVOICE}/records`,
            { fields }
          );
        }));

        const failed = invoiceResults.filter(r => r.code !== 0);
        if (failed.length > 0) console.warn('Some invoice records failed:', JSON.stringify(failed));

        return res.status(200).json({
          ok: true,
          contract_record_id: contractRes.data?.record?.record_id,
          invoice_records: invoiceResults.length
        });
      } catch(e) {
        return res.status(500).json({ error: e.message });
      }
    }

    return res.status(400).json({ error: 'Unknown action: ' + action });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
