// POST /api/submit — save draft, return id
// POST /api/submit?id=xxx — get draft
// POST /api/approve — write to Lark Base

import crypto from 'crypto';

const LARK_BASE = 'https://open.larksuite.com/open-apis';
const APP_TOKEN = 'B8qabL6VmaXgbfs0kZoj5kzlpfc';
const TABLE_CONTRACT = 'tblqmyQe3TrcBFv9';
const TABLE_INVOICE  = 'tblmC3zfsQV8hgRU';

// In-memory store (resets on cold start, fine for review flow within minutes)
// For production replace with Vercel KV
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

async function larkRequest(token, method, path, body) {
  const r = await fetch(`${LARK_BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined
  });
  return r.json();
}

async function findProjectRecord(token, projectNumber) {
  // Search project table in invoice table by Project Number field
  const r = await larkRequest(token, 'GET',
    `/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_INVOICE}/records?filter=CurrentValue.[Project Number]="${projectNumber}"&page_size=1`
  );
  // Try project overview table instead - use contract table project link
  const r2 = await larkRequest(token, 'GET',
    `/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_CONTRACT}/records?page_size=100`
  );
  // Return null if not found, caller will create new project
  return null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action } = req.body || {};
  const url = new URL(req.url, `https://${req.headers.host}`);
  const idParam = url.searchParams.get('id');

  // GET draft
  if (req.method === 'GET' && idParam) {
    const draft = store[idParam];
    if (!draft) return res.status(404).json({ error: 'Draft not found or expired' });
    return res.status(200).json(draft);
  }

  // Save draft
  if (action === 'save_draft') {
    const id = crypto.randomBytes(8).toString('hex');
    store[id] = { ...req.body, id, saved_at: Date.now() };
    return res.status(200).json({ id });
  }

  // Approve — write to Lark Base
  if (action === 'approve') {
    try {
      const token = await getLarkToken();
      const d = req.body;

      // 1. Create contract record
      const contractFields = {
        'Contract Number': d.contract_number || '',
        'Contract Amount': parseFloat(d.contract_amount) || 0,
        'Contract Start Date': d.contract_start_date ? new Date(d.contract_start_date).getTime() : null,
        'Contract End Date': d.contract_end_date ? new Date(d.contract_end_date).getTime() : null,
        'Contract Status': 'Active',
      };
      // Remove null fields
      Object.keys(contractFields).forEach(k => contractFields[k] === null && delete contractFields[k]);

      const contractRes = await larkRequest(token, 'POST',
        `/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_CONTRACT}/records`,
        { fields: contractFields }
      );
      if (contractRes.code !== 0) throw new Error('Contract create failed: ' + JSON.stringify(contractRes));

      // 2. Create invoice records for each milestone
      const milestones = d.milestones || [];
      const invoicePromises = milestones.map(m => {
        const fields = {
          'Invoice Description': m.description || '',
          'Esitimated Invoice Amount': parseFloat(m.amount) || 0,
          'Type': 'Milestone payment',
          'Acceptance satuts': 'Planned/Estimation',
          'Invoice satuts': 'Not Sent',
          'Project Name': d.project_name || '',
          'Project Number': parseInt(d.project_number) || 0,
          'Key account': d.key_account || '',
        };
        if (m.due_date) fields['Date to be invoiced'] = new Date(m.due_date).getTime();
        Object.keys(fields).forEach(k => (fields[k] === 0 && k !== 'Esitimated Invoice Amount') && delete fields[k]);
        return larkRequest(token, 'POST',
          `/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_INVOICE}/records`,
          { fields }
        );
      });

      const invoiceResults = await Promise.all(invoicePromises);
      const failed = invoiceResults.filter(r => r.code !== 0);
      if (failed.length > 0) console.warn('Some invoice records failed:', failed);

      return res.status(200).json({ ok: true, contract_record_id: contractRes.data?.record?.record_id });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(400).json({ error: 'Unknown action' });
}
